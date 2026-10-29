"""Independent (extension-opened) application drafts.

A draft for an application the user opened directly must be ready quickly, must
never be created twice for the same page, and must never spend AI money more than
once for it. So, unlike the website's ``create_application_session``:

* nothing on the request path calls an AI provider. The draft is built from the
  saved profile and answer vault; the tailored résumé and cover letter are
  prepared afterwards by ``prepare_direct_documents``;
* an existing live draft for the same (user, page) is returned untouched. Repeated
  navigation, reloads and retries are free;
* concurrent requests for the same (user, page) are serialized, so they share one
  draft and one background preparation;
* document preparation is attempted ONCE per draft. Its outcome (or failure) is
  recorded on the draft, so a failure degrades to "no tailored documents" instead
  of being retried by every page visit.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.applications.answer_vault_service import build_safe_answers
from app.applications.ats import detect_ats_from_url
from app.applications.fixture_guard import guard_against_dev_fixture
from app.applications.session_refresh import current_profile_revision
from app.applications.session_service import (
    SESSION_IDLE_TTL_MINUTES,
    _json_safe,
    _profile_snapshot,
    _require_complete_profile,
    _reuse_active_session,
    _safe_generate,
    log_action,
)
from app.db.session import SessionLocal
from app.models.entities import (
    ApplicationActionType,
    ApplicationSession,
    ApplicationSessionStatus,
    DocumentType,
    GeneratedDocument,
    JobPosting,
    User,
)
from app.services.documents import public_dict

logger = logging.getLogger("jobpilot.applications")

DOCUMENTS_PREPARING = "Your tailored résumé and cover letter are being prepared."
#: Upper bound on the whole optional preparation. A provider that hangs costs this much, once.
PREPARE_TIMEOUT_SECONDS = 120

_LOCKS: dict[tuple[int, str], asyncio.Lock] = {}


def direct_lock(user_id: int, key: str) -> asyncio.Lock:
    return _LOCKS.setdefault((user_id, key), asyncio.Lock())


def release_direct_lock(user_id: int, key: str) -> None:
    lock = _LOCKS.get((user_id, key))
    if lock is not None and not lock.locked():
        _LOCKS.pop((user_id, key), None)


def _attach_existing_documents(db: Session, user: User, job: JobPosting, session: ApplicationSession) -> None:
    """Link a résumé / cover letter this user already has for this job. No generation."""
    kinds = (
        (DocumentType.resume, "tailored_resume_id"),
        (DocumentType.cover_letter, "tailored_cover_letter_id"),
    )
    for doc_type, attr in kinds:
        existing = db.scalar(
            select(GeneratedDocument)
            .where(
                (GeneratedDocument.user_id == user.id)
                & (GeneratedDocument.job_id == job.id)
                & (GeneratedDocument.type == doc_type)
            )
            .order_by(GeneratedDocument.created_at.desc())
        )
        if existing is not None:
            setattr(session, attr, existing.id)


def open_direct_session(db: Session, user: User, job: JobPosting) -> tuple[ApplicationSession, bool]:
    """Return ``(session, needs_preparation)``. Synchronous, database-only, no AI."""
    reused = _reuse_active_session(db, user, job)
    if reused is not None:
        return reused, False

    _require_complete_profile(db, user)
    guard_against_dev_fixture(user)
    safe_answers, unresolved = build_safe_answers(db, user, company=job.company)
    session = ApplicationSession(
        user_id=user.id,
        job_id=job.id,
        status=ApplicationSessionStatus.ready,
        source_url=job.application_url,
        ats_type=detect_ats_from_url(job.application_url),
        profile_snapshot=_json_safe(_profile_snapshot(db, user)),
        job_snapshot=_json_safe(public_dict(job)),
        generated_answers=safe_answers,
        unresolved_questions=unresolved,
        profile_revision=current_profile_revision(db, user.id),
        warnings=[],
        # The extension holds the user's own credential; there is no website launch to hand off.
        launch_token_hash=None,
        launch_token_used=True,
        expires_at=datetime.now(UTC) + timedelta(minutes=SESSION_IDLE_TTL_MINUTES),
    )
    _attach_existing_documents(db, user, job, session)
    needs_preparation = session.tailored_resume_id is None or session.tailored_cover_letter_id is None
    if needs_preparation:
        session.warnings = [DOCUMENTS_PREPARING]
    db.add(session)
    db.flush()
    log_action(db, session.id, ApplicationActionType.session_created, metadata={"job_id": job.id, "direct": True})
    db.commit()
    db.refresh(session)
    return session, needs_preparation


async def prepare_direct_documents(session_id: int) -> None:
    """Background: generate the missing optional documents, once, and record the outcome."""
    db = SessionLocal()
    try:
        session = db.get(ApplicationSession, session_id)
        if session is None or DOCUMENTS_PREPARING not in (session.warnings or []):
            return  # gone, or someone already settled it: never run twice
        user = db.get(User, session.user_id)
        job = db.get(JobPosting, session.job_id)
        errors: list[str] = []
        if user is not None and job is not None:
            try:
                async with asyncio.timeout(PREPARE_TIMEOUT_SECONDS):
                    for doc_type, attr in (
                        (DocumentType.resume, "tailored_resume_id"),
                        (DocumentType.cover_letter, "tailored_cover_letter_id"),
                    ):
                        if getattr(session, attr) is not None:
                            continue
                        doc, error = await _safe_generate(db, user, job, doc_type)
                        if doc is not None:
                            setattr(session, attr, doc.id)
                        elif error:
                            errors.append(error)
            except TimeoutError:
                db.rollback()
                errors.append("Tailored documents took too long to prepare. You can retry them from XpertApply.")
        session = db.get(ApplicationSession, session_id)
        if session is None:
            return
        remaining = [w for w in (session.warnings or []) if w != DOCUMENTS_PREPARING]
        session.warnings = remaining + errors
        db.commit()
    except Exception as exc:  # noqa: BLE001 - optional work must never raise out of a background task
        db.rollback()
        logger.warning("direct.documents.failed session=%s err=%s", session_id, type(exc).__name__)
        try:
            session = db.get(ApplicationSession, session_id)
            if session is not None:
                session.warnings = [w for w in (session.warnings or []) if w != DOCUMENTS_PREPARING] + [
                    "Tailored documents could not be prepared automatically. You can retry them from XpertApply."
                ]
                db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
    finally:
        db.close()
