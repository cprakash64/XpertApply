"""Which resume and cover letter belong to a tracked application, and how to hand them back exactly as they were.

Two different claims are kept apart throughout:

* "prepared for this application": XpertApply tailored these documents for the job, and they are what was on the session when the
  user applied. That is what this module can establish.
* "attached on the employer's form": the extension REPORTED attaching the file (``documents_uploaded`` on an
  ``autofill_summary`` audit row). It is a report, not employer confirmation, and an ``applied`` status implies neither claim.

Where the documents come from, in order:

1. The snapshot written when the application first became ``applied`` (state ``frozen``): an immutable copy of the stored content,
   so later edits, regenerated tailoring or profile changes cannot alter what the user downloads for that application.
2. For applications with no snapshot (confirmed before snapshots existed, or archival failed), the documents of the ONE session that
   can be tied to the application with evidence (state ``historical``, not frozen): the session whose completion made it applied
   (``tracker_id`` plus ``completed_at``), or the only prepared session for that user and job. These are the saved copies as they are
   now, and the API says so.
3. When several sessions could have supplied them and nothing says which, no association is made (state ``unknown_association``).
   Choosing the newest would be a guess, and a wrong one is worse than none.
4. Otherwise nothing (state ``none``). There is never a "latest document for the job" substitution.

A "snapshot" is the saved CONTENT, re-rendered to PDF or DOCX on download. It is not the byte stream that was once attached to an
employer's form: rendering is not byte-reproducible (PDF metadata carries a creation time), and the original file is not kept.
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
    #: "snapshot", "confirming_session" or "sole_session": how this document was tied to the application.
    basis: str = "snapshot"


@dataclass(frozen=True)
class Resolution:
    documents: dict[str, ResolvedDocument | None]
    #: "frozen" | "historical" | "unknown_association" | "none"
    state: str


def _session_doc_ids(session: ApplicationSession) -> dict[str, int | None]:
    return {"resume": session.tailored_resume_id, "cover_letter": session.tailored_cover_letter_id}


def _associated_sessions(
    db: Session, trackers: list[ApplicationTracker], explicit: dict[int, int] | None = None
) -> tuple[dict[int, tuple[ApplicationSession, str]], set[int]]:
    """``({tracker_id: (session, basis)}, {tracker_ids that are ambiguous})``, in one pass.

    Only evidence associates a session with an application: the session that is named by the caller (the one whose completion is
    being recorded), the one whose completion already made this application applied (``tracker_id`` and ``completed_at``), or the
    only prepared session for the user and job up to the application date. Several candidates and no evidence means ambiguous."""
    if not trackers:
        return {}, set()
    explicit = explicit or {}
    sessions = db.scalars(
        select(ApplicationSession)
        .where(
            ApplicationSession.user_id.in_({t.user_id for t in trackers}),
            ApplicationSession.job_id.in_({t.job_id for t in trackers}),
            (ApplicationSession.tailored_resume_id.is_not(None))
            | (ApplicationSession.tailored_cover_letter_id.is_not(None)),
        )
        .order_by(ApplicationSession.id.desc())
    ).all()
    chosen: dict[int, tuple[ApplicationSession, str]] = {}
    ambiguous: set[int] = set()
    for tracker in trackers:
        mine = [s for s in sessions if s.user_id == tracker.user_id and s.job_id == tracker.job_id]
        named = next((s for s in mine if s.id == explicit.get(tracker.id)), None)
        if named is not None:
            chosen[tracker.id] = (named, "confirming_session")
            continue
        upto = [
            s for s in mine
            if tracker.applied_at is None or s.created_at is None or _naive(s.created_at) <= _naive(tracker.applied_at)
        ]
        linked = [s for s in upto if s.tracker_id == tracker.id and s.completed_at is not None]
        if len(linked) == 1:
            chosen[tracker.id] = (linked[0], "confirming_session")
        elif not linked and len(upto) == 1:
            chosen[tracker.id] = (upto[0], "sole_session")
        elif len(linked) > 1 or len(upto) > 1:
            ambiguous.add(tracker.id)
    return chosen, ambiguous


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


def resolve_documents(
    db: Session, trackers: list[ApplicationTracker], explicit: dict[int, int] | None = None
) -> dict[int, Resolution]:
    """The documents (and how sure we are of them) for each tracker, with no per-row queries."""
    docs_by_tracker: dict[int, dict[str, ResolvedDocument | None]] = {t.id: {"resume": None, "cover_letter": None} for t in trackers}
    states: dict[int, str] = {t.id: "none" for t in trackers}
    if not trackers:
        return {}
    snapshots = db.scalars(
        select(ApplicationDocumentSnapshot).where(ApplicationDocumentSnapshot.tracker_id.in_([t.id for t in trackers]))
    ).all()
    for snap in snapshots:
        if snap.kind in KINDS:
            docs_by_tracker[snap.tracker_id][snap.kind] = ResolvedDocument(
                snap.kind, snap.title, snap.content or {}, snap.plain_text, snap.created_at, True,
                bool(snap.attached_by_extension), snap.source_document_id, snap.association_basis or "sole_session",
            )
            states[snap.tracker_id] = "frozen"
    needing = [t for t in trackers if states[t.id] != "frozen"]
    if needing:
        chosen, ambiguous = _associated_sessions(db, needing, explicit)
        ids = {i for s, _ in chosen.values() for i in _session_doc_ids(s).values() if i is not None}
        docs = {d.id: d for d in db.scalars(select(GeneratedDocument).where(GeneratedDocument.id.in_(ids))).all()} if ids else {}
        attached = _attached_kinds(db, [s.id for s, _ in chosen.values()])
        for tracker in needing:
            if tracker.id in ambiguous:
                states[tracker.id] = "unknown_association"
            pair = chosen.get(tracker.id)
            if pair is None:
                continue
            session, basis = pair
            for kind, doc_id in _session_doc_ids(session).items():
                doc = docs.get(doc_id) if doc_id is not None else None
                # Ownership is re-checked on the document itself, never inherited from the session pointer.
                if doc is None or doc.user_id != tracker.user_id:
                    continue
                docs_by_tracker[tracker.id][kind] = ResolvedDocument(
                    kind, doc.title, doc.content or {}, doc.plain_text, doc.created_at, False,
                    kind in attached.get(session.id, set()), doc.id, basis,
                )
            if any(docs_by_tracker[tracker.id].values()):
                states[tracker.id] = "historical"
    return {t.id: Resolution(docs_by_tracker[t.id], states[t.id]) for t in trackers}


def freeze_application_documents(db: Session, tracker: ApplicationTracker, session_id: int | None = None) -> int:
    """Copy the documents prepared for this application, once. Idempotent; returns how many were written.

    Runs when the application first becomes ``applied``. A failure here must never lose the confirmation, so the caller treats
    it as best effort (the Tracker then falls back to the session's documents and labels them as not frozen)."""
    if tracker.id is None:
        db.flush()
    existing = {s.kind for s in db.scalars(select(ApplicationDocumentSnapshot).where(ApplicationDocumentSnapshot.tracker_id == tracker.id)).all()}
    if set(KINDS) <= existing:
        return 0
    live = resolve_documents(db, [tracker], {tracker.id: session_id} if session_id is not None else None)[tracker.id].documents
    written = 0
    for kind in KINDS:
        doc = live[kind]
        if kind in existing or doc is None or doc.frozen:
            continue
        db.add(ApplicationDocumentSnapshot(
            user_id=tracker.user_id, tracker_id=tracker.id, kind=kind, source_document_id=doc.source_id,
            title=doc.title, content=doc.content, plain_text=doc.plain_text, attached_by_extension=doc.attached_by_extension,
            association_basis=doc.basis,
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
        # How the document was tied to the application (see the module docstring); never a choice between several candidates.
        "association": doc.basis,
        "formats": ["pdf", "docx"],
        # Honest about what a download is: the saved content re-rendered on request. Not the file once attached to an employer.
        "reproduction": "re_rendered_from_saved_content",
        "download_path": f"/jobs/tracker/{tracker_id}/documents/{slug}",
    }
