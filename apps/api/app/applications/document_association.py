"""Which resume and cover letter belong to a tracked application, and how to hand them back exactly as they were.

Two different claims are kept apart throughout:

* "prepared for this application": XpertApply tailored these documents for the job, and they are what was on the session when the
  user applied. That is what this module can establish.
* "attached on the employer's form": the extension REPORTED attaching the file (``documents_uploaded`` on an
  ``autofill_summary`` audit row). It is a report, not employer confirmation, and an ``applied`` status implies neither claim.

Where the documents come from, in order:

1. The snapshot written when the application first became ``applied`` (``frozen``): an immutable copy, so later edits, regenerated
   tailoring or profile changes cannot alter what the user downloads for that application.
2. For applications confirmed before snapshots existed, the documents of the newest session for that user and job created at or
   before the application date (not frozen: they are the saved copies as they are now, and the API says so).
3. Nothing. There is no "latest document for the job" guess: that is a different document from the one prepared for the
   application as soon as the user tailors again.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import (
    ApplicationAuditLog,
    ApplicationDocumentSnapshot,
    ApplicationSession,
    ApplicationTracker,
    DocumentType,
    GeneratedDocument,
)

logger = logging.getLogger("jobpilot.applications")

KINDS = ("resume", "cover_letter")
#: URL spelling of each kind.
KIND_SLUG = {"resume": "resume", "cover-letter": "cover_letter", "cover_letter": "cover_letter"}


@dataclass(frozen=True)
class ResolvedDocument:
    kind: str
    title: str | None
    content: dict[str, Any]
    plain_text: str | None
    created_at: datetime | None
    frozen: bool
    attached_by_extension: bool
    source_id: int | None


def _session_doc_ids(session: ApplicationSession) -> dict[str, int | None]:
    return {"resume": session.tailored_resume_id, "cover_letter": session.tailored_cover_letter_id}


def _associated_sessions(
    db: Session, trackers: list[ApplicationTracker]
) -> dict[int, ApplicationSession]:
    """The session that prepared each tracker's documents, in one pass.

    Newest session for (user, job) with at least one document, created at or before the application date when there is one;
    a completed session wins over a later abandoned one."""
    if not trackers:
        return {}
    job_ids = {tracker.job_id for tracker in trackers}
    user_ids = {tracker.user_id for tracker in trackers}
    sessions = db.scalars(
        select(ApplicationSession)
        .where(
            ApplicationSession.user_id.in_(user_ids),
            ApplicationSession.job_id.in_(job_ids),
            (ApplicationSession.tailored_resume_id.is_not(None))
            | (ApplicationSession.tailored_cover_letter_id.is_not(None)),
        )
        .order_by(ApplicationSession.completed_at.is_(None), ApplicationSession.id.desc())
    ).all()
    chosen: dict[int, ApplicationSession] = {}
    for tracker in trackers:
        for session in sessions:
            if session.user_id != tracker.user_id or session.job_id != tracker.job_id:
                continue
            if tracker.applied_at is not None and session.created_at is not None and _naive(session.created_at) > _naive(tracker.applied_at):
                continue
            chosen[tracker.id] = session
            break
    return chosen


def _naive(value: datetime) -> datetime:
    return value.replace(tzinfo=None) if value.tzinfo is not None else value


def _attached_kinds(db: Session, session_ids: list[int]) -> dict[int, set[str]]:
    """Kinds the extension reported attaching, per session (an extension report, nothing more)."""
    if not session_ids:
        return {}
    rows = db.scalars(
        select(ApplicationAuditLog).where(
            ApplicationAuditLog.session_id.in_(session_ids), ApplicationAuditLog.action_type == "autofill_summary"
        )
    ).all()
    out: dict[int, set[str]] = {}
    for row in rows:
        uploaded = (row.metadata_json or {}).get("documents_uploaded") or []
        out.setdefault(row.session_id, set()).update(k for k in uploaded if k in KINDS)
    return out


def resolve_documents(db: Session, trackers: list[ApplicationTracker]) -> dict[int, dict[str, ResolvedDocument | None]]:
    """``{tracker_id: {"resume": ResolvedDocument | None, "cover_letter": ... }}`` with no per-row queries."""
    result: dict[int, dict[str, ResolvedDocument | None]] = {t.id: {"resume": None, "cover_letter": None} for t in trackers}
    if not trackers:
        return result
    snapshots = db.scalars(
        select(ApplicationDocumentSnapshot).where(ApplicationDocumentSnapshot.tracker_id.in_([t.id for t in trackers]))
    ).all()
    for snap in snapshots:
        if snap.kind in KINDS:
            result[snap.tracker_id][snap.kind] = ResolvedDocument(
                snap.kind, snap.title, snap.content or {}, snap.plain_text, snap.created_at, True,
                bool(snap.attached_by_extension), snap.source_document_id,
            )
    needing = [t for t in trackers if any(result[t.id][k] is None for k in KINDS) and not any(result[t.id][k] for k in KINDS)]
    if needing:
        sessions = _associated_sessions(db, needing)
        ids = {i for s in sessions.values() for i in _session_doc_ids(s).values() if i is not None}
        docs = {d.id: d for d in db.scalars(select(GeneratedDocument).where(GeneratedDocument.id.in_(ids))).all()} if ids else {}
        attached = _attached_kinds(db, [s.id for s in sessions.values()])
        for tracker in needing:
            session = sessions.get(tracker.id)
            if session is None:
                continue
            for kind, doc_id in _session_doc_ids(session).items():
                doc = docs.get(doc_id) if doc_id is not None else None
                # Ownership is re-checked on the document itself, never inherited from the session pointer.
                if doc is None or doc.user_id != tracker.user_id:
                    continue
                result[tracker.id][kind] = ResolvedDocument(
                    kind, doc.title, doc.content or {}, doc.plain_text, doc.created_at, False,
                    kind in attached.get(session.id, set()), doc.id,
                )
    return result


def freeze_application_documents(db: Session, tracker: ApplicationTracker) -> int:
    """Copy the documents prepared for this application, once. Idempotent; returns how many were written.

    Runs when the application first becomes ``applied``. A failure here must never lose the confirmation, so the caller treats
    it as best effort (the Tracker then falls back to the session's documents and labels them as not frozen)."""
    if tracker.id is None:
        db.flush()
    existing = {s.kind for s in db.scalars(select(ApplicationDocumentSnapshot).where(ApplicationDocumentSnapshot.tracker_id == tracker.id)).all()}
    if set(KINDS) <= existing:
        return 0
    live = resolve_documents(db, [tracker])[tracker.id]
    written = 0
    for kind in KINDS:
        doc = live[kind]
        if kind in existing or doc is None or doc.frozen:
            continue
        db.add(ApplicationDocumentSnapshot(
            user_id=tracker.user_id, tracker_id=tracker.id, kind=kind, source_document_id=doc.source_id,
            title=doc.title, content=doc.content, plain_text=doc.plain_text, attached_by_extension=doc.attached_by_extension,
        ))
        written += 1
    if written:
        db.flush()
    return written


def document_summary(tracker_id: int, kind: str, doc: ResolvedDocument | None) -> dict[str, Any] | None:
    """What the Tracker list says about one document. ``None`` means "Not available": nothing was prepared or retained."""
    if doc is None:
        return None
    slug = "cover-letter" if kind == "cover_letter" else "resume"
    return {
        "id": doc.source_id,
        "title": doc.title,
        "created_at": doc.created_at,
        # Always true here: the document is the one prepared for this application.
        "prepared_for_application": True,
        # Only an extension report that it attached the file to the employer's form. Never employer confirmation.
        "attached_by_extension": doc.attached_by_extension,
        # True once the application was confirmed applied and the copy can no longer change.
        "frozen": doc.frozen,
        "formats": ["pdf", "docx"],
        "download_path": f"/jobs/tracker/{tracker_id}/documents/{slug}",
    }
