"""Trusted creation and ownership-safe reads for immutable application history."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.documents.filenames import build_document_filename
from app.models.entities import (
    ApplicationAuditLog,
    ApplicationSession,
    ApplicationSnapshot,
    ApplicationTracker,
    DocumentType,
    GeneratedDocument,
    JobPosting,
    SnapshotConfirmationSource,
    SubmissionEvidenceType,
)

MAX_JOB_DESCRIPTION = 100_000
MAX_COVER_LETTER_TEXT = 40_000
_ALLOWED_EVIDENCE_KEYS = {"ats", "evidence_type", "success_route", "signal", "observed_at"}


class SnapshotProvenanceError(ValueError):
    """The session cannot truthfully produce the requested provenance."""


def canonical_document_hash(document: GeneratedDocument) -> str:
    payload = {
        "version": "xpertapply-document-v1", "type": document.type.value,
        "format_version": document.format_version, "content": document.content or {},
        "markdown": (document.content_markdown or "").replace("\r\n", "\n").replace("\r", "\n"),
        "plain_text": (document.plain_text or "").replace("\r\n", "\n").replace("\r", "\n"),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _owned_document(db: Session, document_id: int | None, session: ApplicationSession,
                    expected_type: DocumentType) -> GeneratedDocument | None:
    if document_id is None:
        return None
    document = db.get(GeneratedDocument, document_id)
    if (document is None or document.user_id != session.user_id
            or document.job_id != session.job_id or document.type != expected_type):
        raise SnapshotProvenanceError("Session artifact ownership or type is invalid.")
    return document


def freeze_document(document: GeneratedDocument, now: datetime) -> str:
    digest = canonical_document_hash(document)
    if document.content_hash is not None and document.content_hash != digest:
        raise SnapshotProvenanceError("Frozen document content no longer matches its integrity hash.")
    document.content_hash = digest
    document.immutable_at = document.immutable_at or now
    return digest


def _filename(session: ApplicationSession, document: GeneratedDocument) -> str:
    profile, job = session.profile_snapshot or {}, session.job_snapshot or {}
    return build_document_filename(
        kind=document.type.value, fmt="pdf", full_name=profile.get("full_name"),
        first_name=profile.get("first_name") or profile.get("given_name"),
        last_name=profile.get("last_name") or profile.get("family_name"), company=job.get("company"),
    )


def _safe_evidence(metadata: dict[str, Any] | None) -> dict[str, str]:
    return {key: str(value)[:500] for key, value in (metadata or {}).items()
            if key in _ALLOWED_EVIDENCE_KEYS and value is not None}


def _artifact_evidence(db: Session, session_id: int) -> list[dict[str, Any]]:
    rows = db.scalars(select(ApplicationAuditLog).where(
        ApplicationAuditLog.session_id == session_id,
        ApplicationAuditLog.action_type.in_(["artifact_use", "autofill_summary"]),
    ).order_by(ApplicationAuditLog.id.asc())).all()
    evidence: list[dict[str, Any]] = []
    for row in rows:
        metadata = row.metadata_json or {}
        if row.action_type == "autofill_summary":
            evidence.extend(
                {"artifact": kind, "mode": "uploaded"}
                for kind in metadata.get("documents_uploaded", [])
                if kind in {"resume", "cover_letter"}
            )
        elif row.status == "verified":
            evidence.append(metadata)
    return evidence


def create_snapshot_from_confirmed_session(
    db: Session, *, session: ApplicationSession, tracker: ApplicationTracker,
    confirmation_source: SnapshotConfirmationSource,
    evidence_type: SubmissionEvidenceType | None, evidence_metadata: dict[str, Any] | None,
    resume_used: bool = False,
    cover_letter_mode: Literal["unused", "file", "pasted_text"] = "unused",
    cover_letter_text: str | None = None,
) -> ApplicationSnapshot:
    """Create one attempt from server-owned state inside the caller's transaction."""
    existing = db.scalar(select(ApplicationSnapshot).where(ApplicationSnapshot.source_session_id == session.id))
    if existing is not None:
        return existing
    if session.user_id != tracker.user_id or session.job_id != tracker.job_id:
        raise SnapshotProvenanceError("Session and Tracker ownership do not match.")
    locked = db.scalar(select(ApplicationTracker).where(
        ApplicationTracker.id == tracker.id, ApplicationTracker.user_id == session.user_id
    ).with_for_update())
    if locked is None:
        raise SnapshotProvenanceError("Application Tracker is not owned by the session user.")
    job = db.get(JobPosting, session.job_id)
    if job is None:
        raise SnapshotProvenanceError("Application job no longer exists.")
    resume = _owned_document(db, session.tailored_resume_id, session, DocumentType.resume)
    cover = _owned_document(db, session.tailored_cover_letter_id, session, DocumentType.cover_letter)
    artifact_evidence = _artifact_evidence(db, session.id)
    resume_verified = any(
        item.get("artifact") == "resume" and item.get("mode") == "uploaded"
        for item in artifact_evidence
    )
    cover_file_verified = any(
        item.get("artifact") == "cover_letter" and item.get("mode") == "uploaded"
        for item in artifact_evidence
    )
    if resume_used and not resume_verified:
        raise SnapshotProvenanceError("Resume usage is not supported by durable upload evidence.")
    resume_used = resume_verified
    if resume_used and resume is None:
        raise SnapshotProvenanceError("Resume usage was reported without a session resume.")
    if cover_letter_mode == "file" and not cover_file_verified:
        raise SnapshotProvenanceError("Cover-letter usage is not supported by durable upload evidence.")
    if cover_letter_mode == "unused" and cover_file_verified:
        cover_letter_mode = "file"
    if cover_letter_mode == "file" and cover is None:
        raise SnapshotProvenanceError("File cover-letter usage was reported without a session document.")
    normalized_text = None
    if cover_letter_mode == "pasted_text":
        normalized_text = (cover_letter_text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized_text or len(normalized_text) > MAX_COVER_LETTER_TEXT:
            raise SnapshotProvenanceError("Pasted cover letter must be non-empty and within the size limit.")
        text_hash = hashlib.sha256(normalized_text.encode()).hexdigest()
        if not any(
            item.get("artifact") == "cover_letter"
            and item.get("mode") == "pasted_text"
            and item.get("content_hash") == text_hash
            for item in artifact_evidence
        ):
            raise SnapshotProvenanceError("Pasted cover letter is not supported by durable use evidence.")
    elif cover_letter_text is not None:
        raise SnapshotProvenanceError("Cover-letter text is only valid for pasted_text mode.")
    now = datetime.now(UTC)
    resume_hash = freeze_document(resume, now) if resume_used and resume else None
    cover_hash = freeze_document(cover, now) if cover_letter_mode == "file" and cover else None
    if normalized_text is not None:
        cover_hash = hashlib.sha256(normalized_text.encode()).hexdigest()
    attempt = int(db.scalar(select(func.coalesce(func.max(ApplicationSnapshot.attempt_number), 0)).where(
        ApplicationSnapshot.application_tracker_id == locked.id)) or 0) + 1
    job_data = session.job_snapshot or {}
    snapshot = ApplicationSnapshot(
        application_tracker_id=locked.id, user_id=session.user_id, job_id=session.job_id,
        source_session_id=session.id, attempt_number=attempt, confirmation_source=confirmation_source,
        submission_evidence_type=evidence_type, submission_evidence_metadata=_safe_evidence(evidence_metadata),
        ats_provider=(session.ats_type or "")[:40] or None,
        job_external_id=str(job_data.get("external_id") or job.external_id or "")[:300] or None,
        job_title=str(job_data.get("title") or job.title)[:500],
        company_name=str(job_data.get("company") or job.company)[:300],
        job_url=str(job_data.get("application_url") or job.application_url or "")[:2000] or None,
        source_url=session.source_url[:2000],
        job_description_snapshot=str(
            job_data.get("description_clean") or job.description_clean or ""
        )[:MAX_JOB_DESCRIPTION],
        resume_document_id=resume.id if resume else None, resume_used=resume_used,
        resume_provenance="upload_verified" if resume_used else ("selected_for_session" if resume else None),
        resume_filename=_filename(session, resume) if resume_used and resume else None,
        resume_content_hash=resume_hash, cover_letter_used=cover_letter_mode != "unused",
        cover_letter_mode=cover_letter_mode,
        cover_letter_document_id=cover.id if cover_letter_mode == "file" and cover else None,
        cover_letter_filename=_filename(session, cover) if cover_letter_mode == "file" and cover else None,
        cover_letter_content_hash=cover_hash, cover_letter_text_snapshot=normalized_text,
        answers_snapshot=[], applied_at=locked.applied_at or now,
    )
    db.add(snapshot)
    db.flush()
    return snapshot


def get_owned_snapshot(db: Session, *, user_id: int, snapshot_id: int,
                       tracker_id: int | None = None) -> ApplicationSnapshot | None:
    conditions = [ApplicationSnapshot.id == snapshot_id, ApplicationSnapshot.user_id == user_id]
    if tracker_id is not None:
        conditions.append(ApplicationSnapshot.application_tracker_id == tracker_id)
    return db.scalar(select(ApplicationSnapshot).where(*conditions))


def list_owned_snapshots(db: Session, *, user_id: int, tracker_id: int,
                         limit: int = 100) -> list[ApplicationSnapshot]:
    owned = db.scalar(select(ApplicationTracker.id).where(
        ApplicationTracker.id == tracker_id, ApplicationTracker.user_id == user_id))
    if owned is None:
        return []
    return list(db.scalars(select(ApplicationSnapshot).where(
        ApplicationSnapshot.user_id == user_id,
        ApplicationSnapshot.application_tracker_id == tracker_id,
    ).order_by(ApplicationSnapshot.attempt_number.asc()).limit(limit)).all())


def serialize_snapshot(snapshot: ApplicationSnapshot) -> dict[str, Any]:
    """Public historical view; deliberately excludes paths, tokens, and raw browser state."""
    return {
        "id": snapshot.id,
        "application_tracker_id": snapshot.application_tracker_id,
        "attempt_number": snapshot.attempt_number,
        "confirmation_source": snapshot.confirmation_source.value,
        "submission_evidence_type": (
            snapshot.submission_evidence_type.value if snapshot.submission_evidence_type else None
        ),
        "ats_provider": snapshot.ats_provider,
        "job_external_id": snapshot.job_external_id,
        "job_title": snapshot.job_title,
        "company_name": snapshot.company_name,
        "job_url": snapshot.job_url,
        "source_url": snapshot.source_url,
        "job_description_snapshot": snapshot.job_description_snapshot,
        "resume": {
            "document_id": snapshot.resume_document_id,
            "filename": snapshot.resume_filename,
            "content_hash": snapshot.resume_content_hash,
        },
        "resume_used": snapshot.resume_used,
        "resume_provenance": snapshot.resume_provenance,
        "cover_letter_used": snapshot.cover_letter_used,
        "cover_letter_mode": snapshot.cover_letter_mode,
        "cover_letter": {
            "document_id": snapshot.cover_letter_document_id,
            "filename": snapshot.cover_letter_filename,
            "content_hash": snapshot.cover_letter_content_hash,
        },
        "cover_letter_text_snapshot": snapshot.cover_letter_text_snapshot,
        "answers": snapshot.answers_snapshot or [],
        "applied_at": snapshot.applied_at,
        "created_at": snapshot.created_at,
    }
