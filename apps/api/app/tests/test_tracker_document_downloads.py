"""Tracker downloads: the resume and cover letter prepared for ONE application, exactly as they were when the user applied.

What is pinned here: the bytes and headers of a download, that a later edit / regeneration / profile change cannot alter an
already-applied application's copy, that nothing is invented when no document was kept, and that no id can be used to reach
another account's documents.
"""

from __future__ import annotations

import io
import re
from datetime import UTC, datetime, timedelta

from docx import Document
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.models import entities as E
from app.applications import document_association
from app.tests.test_application_applied_lifecycle import (  # noqa: F401  (client is a pytest fixture)
    auth,
    client,
    complete_profile,
    confirm_applied,
    db_session,
    seed_job,
    user_id_for,
)

RESUME_MARKER = "ORIGINAL-RESUME-MARKER"
COVER_MARKER = "ORIGINAL-COVER-MARKER"
PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _prepare(client: TestClient, headers: dict[str, str], job_id: int, *, resume: bool = True, cover: bool = True) -> int:
    """Create the apply session, then pin known content on its documents so the bytes can be checked."""
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()
    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session["session_id"])
        if resume and row.tailored_resume_id:
            doc = db.get(E.GeneratedDocument, row.tailored_resume_id)
            doc.content = {"name": "Chandra Pandey", "summary": RESUME_MARKER, "skills": ["Python"], "experience": [], "education": []}
            doc.plain_text = RESUME_MARKER
        if cover and row.tailored_cover_letter_id:
            doc = db.get(E.GeneratedDocument, row.tailored_cover_letter_id)
            doc.content = {"greeting": "Dear team,", "paragraphs": [COVER_MARKER], "closing": "Sincerely", "signature": "Chandra Pandey"}
            doc.plain_text = COVER_MARKER
        if not resume:
            row.tailored_resume_id = None
        if not cover:
            row.tailored_cover_letter_id = None
        db.commit()
    finally:
        db.close()
    return session["session_id"]


def _tracker_entry(client: TestClient, headers: dict[str, str], job_id: int) -> dict:
    rows = client.get("/jobs/tracker/all", headers=headers).json()["applications"]
    return next(row for row in rows if row["job_id"] == job_id)


def _docx_text(data: bytes) -> str:
    return "\n".join(p.text for p in Document(io.BytesIO(data)).paragraphs)


def _applied(client: TestClient, headers: dict[str, str], **kw) -> tuple[int, dict]:
    job_id = seed_job(**kw)
    return job_id, {"job_id": job_id}


def _setup(client: TestClient, email: str = "dl@mailbox.test-domain.co", **prep) -> tuple[dict[str, str], int, int]:
    headers = auth(client, email)
    complete_profile(client, headers)
    job_id = seed_job()
    _prepare(client, headers, job_id, **prep)
    assert confirm_applied(client, headers, job_id).status_code == 200
    return headers, job_id, _tracker_entry(client, headers, job_id)["id"]


# --------------------------------------------------------------------------- #
# What the user downloads
# --------------------------------------------------------------------------- #
def test_resume_and_cover_letter_download_with_correct_bytes_type_and_filename(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    entry = _tracker_entry(client, headers, job_id)
    for kind in ("resume", "cover_letter"):
        doc = entry["documents"][kind]
        assert doc["prepared_for_application"] is True
        assert doc["frozen"] is True
        assert doc["formats"] == ["pdf", "docx"]
        assert doc["download_path"].startswith(f"/jobs/tracker/{tracker_id}/documents/")
        assert "file_path" not in doc and "pdf_file_path" not in doc            # no storage path, no file URL

    pdf = client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=headers)
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == PDF
    assert pdf.content.startswith(b"%PDF")
    assert re.fullmatch(r'attachment; filename="Acme_Resume_\d{4}-\d{2}-\d{2}\.pdf"', pdf.headers["content-disposition"])
    assert pdf.headers["cache-control"] == "private, no-store"
    assert pdf.headers["x-content-type-options"] == "nosniff"

    docx = client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers)
    assert docx.status_code == 200 and docx.headers["content-type"] == DOCX
    assert docx.content[:2] == b"PK" and RESUME_MARKER in _docx_text(docx.content)
    assert docx.headers["content-disposition"].endswith('.docx"')

    cover = client.get(f"/jobs/tracker/{tracker_id}/documents/cover-letter?fmt=docx", headers=headers)
    assert cover.status_code == 200 and cover.headers["content-type"] == DOCX
    assert COVER_MARKER in _docx_text(cover.content)
    assert re.fullmatch(r'attachment; filename="Acme_Cover_Letter_\d{4}-\d{2}-\d{2}\.docx"', cover.headers["content-disposition"])


def test_filename_cannot_carry_header_injection_or_path_characters(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job(company='Ev"il/../Co\r\nX-Injected: 1', external="inj-1")
    _prepare(client, headers, job_id)
    assert confirm_applied(client, headers, job_id).status_code == 200
    tracker_id = _tracker_entry(client, headers, job_id)["id"]
    response = client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=headers)
    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    assert re.fullmatch(r'attachment; filename="[A-Za-z0-9_.-]+"', disposition)
    assert "x-injected" not in {k.lower() for k in response.headers}


# --------------------------------------------------------------------------- #
# What the application keeps when the user changes things later
# --------------------------------------------------------------------------- #
def test_later_edit_regeneration_and_profile_change_do_not_alter_the_applied_copy(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    before = _docx_text(client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers).content)
    assert RESUME_MARKER in before

    db = db_session()
    try:
        session = db.scalar(select(E.ApplicationSession).where(E.ApplicationSession.job_id == job_id))
        original_id = session.tailored_resume_id
        doc = db.get(E.GeneratedDocument, original_id)
        doc.content = {"name": "Someone Else", "summary": "EDITED-AFTER-APPLYING", "skills": [], "experience": [], "education": []}
        newer = E.GeneratedDocument(
            user_id=doc.user_id, job_id=doc.job_id, type=E.DocumentType.resume, format=E.DocumentFormat.json,
            title="regenerated", content={"summary": "REGENERATED-AFTER-APPLYING"}, plain_text="x",
        )
        db.add(newer)
        db.flush()
        session.tailored_resume_id = newer.id          # what regenerate-resume does
        db.commit()
    finally:
        db.close()
    client.put("/profile", headers=headers, json={"full_name": "Changed Name", "phone": "602-555-0100"})

    after = _docx_text(client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers).content)
    assert after == before and "EDITED" not in after and "REGENERATED" not in after
    assert _tracker_entry(client, headers, job_id)["documents"]["resume"]["frozen"] is True


def test_two_applications_to_the_same_company_keep_their_own_documents(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    first, second = seed_job(external="a-1"), seed_job(external="a-2")
    for job_id, marker in ((first, "FIRST-APP"), (second, "SECOND-APP")):
        session_id = _prepare(client, headers, job_id)
        db = db_session()
        try:
            row = db.get(E.ApplicationSession, session_id)
            db.get(E.GeneratedDocument, row.tailored_resume_id).content = {"summary": marker, "skills": [], "experience": [], "education": []}
            db.commit()
        finally:
            db.close()
        assert confirm_applied(client, headers, job_id).status_code == 200
    for job_id, marker, other in ((first, "FIRST-APP", "SECOND-APP"), (second, "SECOND-APP", "FIRST-APP")):
        tracker_id = _tracker_entry(client, headers, job_id)["id"]
        text = _docx_text(client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers).content)
        assert marker in text and other not in text


# --------------------------------------------------------------------------- #
# Nothing is invented
# --------------------------------------------------------------------------- #
def test_one_document_only_the_other_is_not_available(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client, cover=False)
    docs = _tracker_entry(client, headers, job_id)["documents"]
    assert docs["resume"] is not None and docs["cover_letter"] is None
    assert client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=headers).status_code == 200
    missing = client.get(f"/jobs/tracker/{tracker_id}/documents/cover-letter", headers=headers)
    assert missing.status_code == 404 and missing.json()["detail"] == "Document not available"


def test_application_with_no_documents_and_no_session_has_none(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    assert confirm_applied(client, headers, job_id).status_code == 200            # confirmed without ever preparing documents
    entry = _tracker_entry(client, headers, job_id)
    assert entry["documents"] == {"resume": None, "cover_letter": None}
    assert client.get(f"/jobs/tracker/{entry['id']}/documents/resume", headers=headers).status_code == 404


def test_latest_document_for_the_job_is_never_substituted(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    assert confirm_applied(client, headers, job_id).status_code == 200            # applied with nothing prepared
    db = db_session()
    try:                                                                          # tailoring happens afterwards
        job = db.get(E.JobPosting, job_id)
        db.add(E.GeneratedDocument(user_id=user_id_for(client, headers), job_id=job.id, type=E.DocumentType.resume,
                                   format=E.DocumentFormat.json, title="later", content={"summary": "LATER"}))
        db.commit()
    finally:
        db.close()
    assert _tracker_entry(client, headers, job_id)["documents"]["resume"] is None


def test_older_application_without_a_snapshot_falls_back_to_its_session_and_says_so(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    db = db_session()
    try:
        db.execute(delete(E.ApplicationDocumentSnapshot))                          # a record from before snapshots existed
        db.commit()
    finally:
        db.close()
    doc = _tracker_entry(client, headers, job_id)["documents"]["resume"]
    assert doc is not None and doc["frozen"] is False
    response = client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers)
    assert response.status_code == 200 and RESUME_MARKER in _docx_text(response.content)
    db = db_session()
    try:
        db.execute(delete(E.ApplicationSession))                                   # and with no session either
        db.commit()
    finally:
        db.close()
    assert _tracker_entry(client, headers, job_id)["documents"] == {"resume": None, "cover_letter": None}


def test_corrupted_stored_copy_is_reported_not_regenerated(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    db = db_session()
    try:
        for snap in db.scalars(select(E.ApplicationDocumentSnapshot)).all():
            snap.content = {}
        db.commit()
    finally:
        db.close()
    response = client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "This saved document can't be opened"
    assert "pdf" not in response.headers.get("content-type", "")


# --------------------------------------------------------------------------- #
# Prepared is not uploaded
# --------------------------------------------------------------------------- #
def test_prepared_documents_are_not_claimed_as_attached_unless_the_extension_reported_it(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session_id = _prepare(client, headers, job_id)
    client.post(f"/application-sessions/{session_id}/autofill-results", headers=headers, json={
        "status": "completed", "ats": "greenhouse", "fields_discovered": 5, "fields_filled": 3,
        "documents_uploaded": ["resume"], "review_items": 1, "failures": [],
    })
    assert confirm_applied(client, headers, job_id).status_code == 200
    docs = _tracker_entry(client, headers, job_id)["documents"]
    assert docs["resume"]["prepared_for_application"] is True and docs["resume"]["attached_by_extension"] is True
    assert docs["cover_letter"]["prepared_for_application"] is True and docs["cover_letter"]["attached_by_extension"] is False


def test_marking_applied_alone_does_not_claim_an_upload(client: TestClient) -> None:
    headers, job_id, _ = _setup(client)
    docs = _tracker_entry(client, headers, job_id)["documents"]
    assert docs["resume"]["attached_by_extension"] is False and docs["cover_letter"]["attached_by_extension"] is False


# --------------------------------------------------------------------------- #
# Who can download
# --------------------------------------------------------------------------- #
def test_unauthenticated_and_invalid_tokens_are_refused(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    url = f"/jobs/tracker/{tracker_id}/documents/resume"
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"Authorization": "Bearer not-a-token"}).status_code == 401
    forged = {"Authorization": "Bearer " + headers["Authorization"].split(".")[0] + ".e30.sig"}
    assert client.get(url, headers=forged).status_code == 401


def test_another_account_cannot_reach_the_documents_by_changing_ids(client: TestClient) -> None:
    owner, job_id, tracker_id = _setup(client)
    intruder = auth(client, "intruder@mailbox.test-domain.co")
    complete_profile(client, intruder)
    for kind in ("resume", "cover-letter"):
        for fmt in ("pdf", "docx"):
            denied = client.get(f"/jobs/tracker/{tracker_id}/documents/{kind}?fmt={fmt}", headers=intruder)
            assert denied.status_code == 404 and denied.json()["detail"] == "Document not found"
    # the same answer for an id that does not exist, so ids cannot be probed
    assert client.get("/jobs/tracker/999999/documents/resume", headers=intruder).status_code == 404
    assert client.get("/jobs/tracker/999999/documents/resume", headers=owner).status_code == 404
    # and the generated-document ids behind the snapshot are not reachable either
    db = db_session()
    try:
        document_ids = [d.id for d in db.scalars(select(E.GeneratedDocument)).all()]
    finally:
        db.close()
    for document_id in document_ids:
        assert client.get(f"/jobs/documents/{document_id}/download/pdf", headers=intruder).status_code == 404
    # the intruder's own tracker list never shows the owner's documents
    assert client.get("/jobs/tracker/all", headers=intruder).json()["applications"] == []


def test_invalid_kind_and_format_are_rejected(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    assert client.get(f"/jobs/tracker/{tracker_id}/documents/portfolio", headers=headers).status_code == 404
    assert client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=exe", headers=headers).status_code == 422
    assert client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=json", headers=headers).status_code == 404
    assert client.get(f"/jobs/tracker/abc/documents/resume", headers=headers).status_code == 422


# --------------------------------------------------------------------------- #
# Existing behaviour
# --------------------------------------------------------------------------- #
def test_status_updates_still_work_and_leave_the_documents_alone(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    resp = client.put(f"/jobs/{job_id}/tracker", headers=headers, json={"status": "interview"})
    assert resp.status_code == 200, resp.text
    entry = _tracker_entry(client, headers, job_id)
    assert entry["status"] == "interview"
    assert entry["documents"]["resume"]["frozen"] is True
    assert client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=headers).status_code == 200


def test_a_documentless_saved_job_lists_without_error(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    assert client.post(f"/jobs/{job_id}/save", headers=headers).status_code in (200, 201)
    entry = _tracker_entry(client, headers, job_id)
    assert entry["documents"] == {"resume": None, "cover_letter": None}


def test_snapshot_is_written_once(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    assert confirm_applied(client, headers, job_id).status_code == 200            # a duplicate confirmation
    db = db_session()
    try:
        rows = db.scalars(select(E.ApplicationDocumentSnapshot)).all()
        assert sorted(r.kind for r in rows) == ["cover_letter", "resume"]
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# XA-RC-06-B-R1: fidelity, association by evidence, honest availability
# --------------------------------------------------------------------------- #
def test_downloads_are_content_equivalent_never_byte_identical_and_say_so(client: TestClient) -> None:
    """Two renders of the SAME stored content differ in bytes (PDF/DOCX carry creation metadata), and the original attached file is
    not kept. So a download is the saved text re-rendered, and the API must not present it as the exact file."""
    import time

    headers, job_id, tracker_id = _setup(client)
    first = client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers).content
    time.sleep(1.1)
    second = client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers).content
    assert _docx_text(first) == _docx_text(second) and RESUME_MARKER in _docx_text(first)
    # Bytes are NOT a guarantee in either direction (PDF carries a creation time; DOCX depends on the library), so nothing here may
    # promise a byte-identical file; only the text is pinned.
    pdf_a = client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=headers).content
    time.sleep(1.1)
    pdf_b = client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=headers).content
    assert pdf_a.startswith(b"%PDF") and pdf_b.startswith(b"%PDF")
    doc = _tracker_entry(client, headers, job_id)["documents"]["resume"]
    assert doc["reproduction"] == "re_rendered_from_saved_content"


def test_availability_states_are_reported(client: TestClient) -> None:
    headers, job_id, _ = _setup(client)
    assert _tracker_entry(client, headers, job_id)["documents_availability"] == "frozen"
    other = seed_job(external="none-1")
    assert confirm_applied(client, headers, other).status_code == 200
    assert _tracker_entry(client, headers, other)["documents_availability"] == "none"


def _second_session(job_id: int, user_id: int) -> int:
    """A second prepared session for the same user and job, with its own documents."""
    db = db_session()
    try:
        first = db.scalar(select(E.ApplicationSession).where(E.ApplicationSession.job_id == job_id))
        docs = []
        for doc_type, marker in ((E.DocumentType.resume, "SECOND-SESSION-RESUME"), (E.DocumentType.cover_letter, "SECOND-SESSION-COVER")):
            doc = E.GeneratedDocument(user_id=user_id, job_id=job_id, type=doc_type, format=E.DocumentFormat.json, title=marker,
                                      content={"summary": marker, "paragraphs": [marker], "skills": [], "experience": [], "education": []}, plain_text=marker)
            db.add(doc)
            docs.append(doc)
        db.flush()
        second = E.ApplicationSession(user_id=user_id, job_id=job_id, source_url=first.source_url, status=E.ApplicationSessionStatus.ready,
                                      tailored_resume_id=docs[0].id, tailored_cover_letter_id=docs[1].id)
        db.add(second)
        db.commit()
        return second.id
    finally:
        db.close()


def test_two_prepared_sessions_and_no_evidence_means_no_association_rather_than_a_guess(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    _prepare(client, headers, job_id)
    _second_session(job_id, user_id_for(client, headers))
    assert confirm_applied(client, headers, job_id).status_code == 200      # manual confirmation: no session named
    entry = _tracker_entry(client, headers, job_id)
    assert entry["status"] == "applied"                                     # the application itself is unaffected
    assert entry["documents"] == {"resume": None, "cover_letter": None}
    assert entry["documents_availability"] == "unknown_association"
    assert client.get(f"/jobs/tracker/{entry['id']}/documents/resume", headers=headers).status_code == 404
    db = db_session()
    try:
        assert db.scalars(select(E.ApplicationDocumentSnapshot)).all() == []
    finally:
        db.close()


def test_the_confirming_session_is_used_even_when_another_exists(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    first_id = _prepare(client, headers, job_id)
    second_id = _second_session(job_id, user_id_for(client, headers))
    resp = client.post(f"/application-sessions/{first_id}/submission-confirmed", headers=headers,
                       json={"evidence_type": "success_page", "confirmation_source": "extension_confirmed"})
    assert resp.status_code == 200, resp.text
    entry = _tracker_entry(client, headers, job_id)
    assert entry["documents_availability"] == "frozen"
    assert entry["documents"]["resume"]["association"] == "confirming_session"
    text = _docx_text(client.get(f"/jobs/tracker/{entry['id']}/documents/resume?fmt=docx", headers=headers).content)
    assert RESUME_MARKER in text and "SECOND-SESSION" not in text           # the session that confirmed, not the newest
    assert second_id != first_id


def test_a_failed_snapshot_keeps_applied_is_logged_and_is_never_reported_as_archived(client: TestClient, monkeypatch) -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("simulated archival failure")

    monkeypatch.setattr(document_association, "freeze_application_documents", boom)
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    _prepare(client, headers, job_id)
    assert confirm_applied(client, headers, job_id).status_code == 200
    entry = _tracker_entry(client, headers, job_id)
    assert entry["status"] == "applied" and entry["applied_at"] is not None
    # The documents are still reachable through the sole session, but honestly: not frozen, not "archived".
    assert entry["documents_availability"] == "historical"
    assert entry["documents"]["resume"]["frozen"] is False
    db = db_session()
    try:
        assert db.scalars(select(E.ApplicationDocumentSnapshot)).all() == []
        failure = db.scalars(select(E.AuditLog).where(E.AuditLog.action == "document_snapshot_failed")).all()
        assert len(failure) == 1 and failure[0].metadata_json["job_id"] == job_id
    finally:
        db.close()


def test_privacy_export_contains_only_the_owners_snapshots(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    other = auth(client, "other-export@mailbox.test-domain.co")
    complete_profile(client, other)
    mine = client.get("/privacy/export", headers=headers)
    assert mine.status_code == 200
    snaps = mine.json()["application_document_snapshots"]
    assert sorted(s["kind"] for s in snaps) == ["cover_letter", "resume"]
    assert all(s["application_id"] == tracker_id for s in snaps)
    assert client.get("/privacy/export", headers=other).json()["application_document_snapshots"] == []


def test_deleting_the_source_documents_keeps_the_applied_copy_downloadable(client: TestClient) -> None:
    """Retention: the application's own copy is independent of the editable document it was taken from."""
    headers, job_id, tracker_id = _setup(client)
    db = db_session()
    try:
        db.execute(delete(E.ApplicationSession))
        db.execute(delete(E.GeneratedDocument))
        db.commit()
    finally:
        db.close()
    response = client.get(f"/jobs/tracker/{tracker_id}/documents/resume?fmt=docx", headers=headers)
    assert response.status_code == 200 and RESUME_MARKER in _docx_text(response.content)
    assert _tracker_entry(client, headers, job_id)["documents_availability"] == "frozen"


def test_error_answers_expose_no_private_content_or_paths(client: TestClient) -> None:
    headers, job_id, tracker_id = _setup(client)
    intruder = auth(client, "probe@mailbox.test-domain.co")
    bodies = [
        client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers=intruder).text,
        client.get("/jobs/tracker/424242/documents/resume", headers=headers).text,
        client.get(f"/jobs/tracker/{tracker_id}/documents/nope", headers=headers).text,
    ]
    for body in bodies:
        assert RESUME_MARKER not in body and "generated" not in body.lower() and "/" not in body.replace("Document not found", "")


def test_a_browser_on_another_origin_can_read_the_download_filename(client: TestClient) -> None:
    """Found by the live-API browser run: without Access-Control-Expose-Headers the web app cannot see Content-Disposition."""
    headers, job_id, tracker_id = _setup(client)
    response = client.get(f"/jobs/tracker/{tracker_id}/documents/resume", headers={**headers, "Origin": "http://localhost:3000"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "content-disposition" in response.headers["access-control-expose-headers"].lower()
