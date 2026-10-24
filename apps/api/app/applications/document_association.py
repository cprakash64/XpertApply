"""Which resume and cover letter belong to a tracked application, and how to hand them back exactly as they were.

Two different claims are kept apart throughout:

* "prepared for this application": XpertApply tailored these documents for the job, and they are what was on the session when the
  user applied. That is what this module can establish.
* "attached on the employer's form": the extension REPORTED attaching the file (``documents_uploaded`` on an
  ``autofill_summary`` audit row). It is a report, not employer confirmation, and an ``applied`` status implies neither claim.

Where the documents come from, in order:

1. The snapshot written when the application first became ``applied`` (state ``frozen``): an immutable copy of the stored content,
   so later edits, regenerated tailoring or profile changes cannot alter what the user downloads for that application.
2. For applications with no snapshot (confirmed before snapshots existed, or archival failed), the saved documents of the sessions
   that can be tied to the application with evidence (state ``historical``, not frozen). Evidence is the session named by the
   confirmation, a session that raised or completed the confirmation for this application (``tracker_id``), or the fact that every
   prepared session for this user and job points at one and the same set of documents. Sessions that point at DIFFERENT documents
   with nothing to say which was used give no association (state ``unknown_association``): choosing the newest is a guess, and a
   wrong document is worse than none. The date the user or a client claims for the submission is never used to pick a session.
3. At the moment of confirmation only (never when reading later), a kind with no session evidence may take the single document of
   that type that exists for this user and this exact job (basis ``job_document``): it is what the user had prepared for the job.
   Several such documents and no evidence means nothing is taken.
4. Otherwise nothing (state ``none``), with the reason that is known from the stored facts. There is never a "latest document for
   the job" substitution and nothing is generated after the fact.

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
    #: Why nothing is available, when that is known from stored facts: "no_session" | "documents_not_prepared" |
    #: "job_documents_not_linked" | "unknown_association"; None when documents are available.
    reason: str | None = None


def _session_doc_ids(session: ApplicationSession) -> dict[str, int | None]:
    return {"resume": session.tailored_resume_id, "cover_letter": session.tailored_cover_letter_id}


def _associated_sessions(
    db: Session, trackers: list[ApplicationTracker], explicit: dict[int, int] | None = None
) -> tuple[dict[int, tuple[ApplicationSession, str]], set[int]]:
    """``({tracker_id: (session, basis)}, {tracker_ids that are ambiguous})``, in one pass. Evidence only; see the module docstring."""
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
        linked = [s for s in mine if s.tracker_id == tracker.id]
        pool, basis = (linked, "linked_session") if linked else (mine, "sole_session")
        distinct = {(s.tailored_resume_id, s.tailored_cover_letter_id) for s in pool}
        if len(distinct) == 1:
            newest = pool[0]                                    # newest id first; every candidate points at the same documents
            chosen[tracker.id] = (newest, "confirming_session" if linked and newest.completed_at is not None else basis)
        elif len(distinct) > 1:
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
    reasons = _unavailable_reasons(db, [t for t in trackers if states[t.id] in ("none", "unknown_association")], states)
    return {t.id: Resolution(docs_by_tracker[t.id], states[t.id], reasons.get(t.id)) for t in trackers}


def _unavailable_reasons(db: Session, trackers: list[ApplicationTracker], states: dict[int, str]) -> dict[int, str]:
    """Why an application has no documents, from persisted facts only (counts per user and job; no content is read)."""
    if not trackers:
        return {}
    pairs = {(t.user_id, t.job_id) for t in trackers}
    session_counts: dict[tuple[int, int], int] = {}
    for user_id, job_id in db.execute(
        select(ApplicationSession.user_id, ApplicationSession.job_id).where(
            ApplicationSession.user_id.in_({p[0] for p in pairs}), ApplicationSession.job_id.in_({p[1] for p in pairs})
        )
    ):
        session_counts[(user_id, job_id)] = session_counts.get((user_id, job_id), 0) + 1
    document_counts: dict[tuple[int, int], int] = {}
    for user_id, job_id in db.execute(
        select(GeneratedDocument.user_id, GeneratedDocument.job_id).where(
            GeneratedDocument.user_id.in_({p[0] for p in pairs}),
            GeneratedDocument.job_id.in_({p[1] for p in pairs}),
            GeneratedDocument.type.in_((DocumentType.resume, DocumentType.cover_letter)),
        )
    ):
        document_counts[(user_id, job_id)] = document_counts.get((user_id, job_id), 0) + 1
    reasons: dict[int, str] = {}
    for tracker in trackers:
        key = (tracker.user_id, tracker.job_id)
        if states[tracker.id] == "unknown_association":
            reasons[tracker.id] = "unknown_association"
        elif document_counts.get(key):
            reasons[tracker.id] = "job_documents_not_linked"
        elif session_counts.get(key):
            reasons[tracker.id] = "documents_not_prepared"
        else:
            reasons[tracker.id] = "no_session"
    return reasons


def freeze_application_documents(db: Session, tracker: ApplicationTracker, session_id: int | None = None) -> int:
    """Copy the documents prepared for this application, once. Idempotent; returns how many were written.

    Runs when the application first becomes ``applied``. A failure here must never lose the confirmation, so the caller treats
    it as best effort (the Tracker then falls back to the session's documents and labels them as not frozen)."""
    if tracker.id is None:
        db.flush()
    existing = {s.kind for s in db.scalars(select(ApplicationDocumentSnapshot).where(ApplicationDocumentSnapshot.tracker_id == tracker.id)).all()}
    if set(KINDS) <= existing:
        return 0
    resolution = resolve_documents(db, [tracker], {tracker.id: session_id} if session_id is not None else None)[tracker.id]
    live = dict(resolution.documents)
    if resolution.state != "unknown_association":
        # Only now, at the confirmation, and only a unique document of that type for this user and this exact job.
        for kind, doc_type in (("resume", DocumentType.resume), ("cover_letter", DocumentType.cover_letter)):
            if live[kind] is not None:
                continue
            candidates = db.scalars(
                select(GeneratedDocument).where(
                    GeneratedDocument.user_id == tracker.user_id, GeneratedDocument.job_id == tracker.job_id, GeneratedDocument.type == doc_type
                )
            ).all()
            if len(candidates) == 1:
                only = candidates[0]
                live[kind] = ResolvedDocument(kind, only.title, only.content or {}, only.plain_text, only.created_at, False, False, only.id, "job_document")
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
