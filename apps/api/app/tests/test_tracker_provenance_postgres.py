"""Document provenance, end to end, over REAL HTTP against the REAL API on REAL PostgreSQL (XA-RC-06-B-R2).

A migrated disposable database, an actual ``uvicorn`` subprocess configured like staging for what matters here (no OpenAI key; staging's strict-secrets validation is not exercised), synthetic applicants, and
``httpx`` requests. Each scenario checks the persisted rows, the availability the API reports, the HTTP response of an actual PDF and
DOCX download (status, MIME type, filename, bytes), and the content of what was downloaded. Direct-entry sessions are created through
``/extension/direct-sessions`` with a PKCE-minted extension token; website-launched ones through ``/application-sessions`` and the
single-use launch-token exchange, exactly as the extension does.

Needs MIGRATION_TEST_DATABASE_URL (a PostgreSQL server on which databases may be created); skipped otherwise.
"""

from __future__ import annotations

import io
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from docx import Document
from sqlalchemy import create_engine, delete, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models import entities as E
from app.tests.test_application_applied_migration import _ADMIN_URL, _alembic_config, requires_postgres
from app.tests.test_extension_auth import REDIRECT, VERIFIER, challenge_for

pytestmark = [pytest.mark.migration, requires_postgres]

API_DIR = Path(__file__).resolve().parents[2]
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PROFILE = {
    "full_name": "Riley Candidate", "phone": "602-555-0100", "location_city": "Phoenix", "location_state": "AZ", "location_country": "United States",
    "work_authorization": "authorized_us", "target_roles": ["Backend Engineer"], "target_levels": ["Junior"], "preferred_locations": ["United States"],
    "remote_preference": "remote", "skills": ["Python", "FastAPI", "PostgreSQL"],
}
CAREER = {
    "education": [{"school": "Example State University", "degree": "BS"}],
    "experience": [{"company": "Example Robotics", "title": "Software Engineer", "bullets": ["Built Python services"], "technologies": ["Python"], "currently_working": True}],
    "projects": [], "certifications": [], "awards": [],
}


class Live:
    def __init__(self, base: str, engine) -> None:
        self.base, self.engine = base, engine
        self.http = httpx.Client(base_url=base, timeout=60)
        self._n = 0

    # ---- accounts and jobs ------------------------------------------------
    def signup(self, label: str = "u") -> dict:
        self._n += 1
        email = f"{label}-{uuid.uuid4().hex[:8]}@mailbox.test-domain.co"
        token = self.http.post("/auth/signup", json={"email": email, "password": "password123"}).json()["access_token"]
        h = {"Authorization": f"Bearer {token}"}
        assert self.http.put("/profile", headers=h, json=PROFILE).status_code == 200
        assert self.http.put("/profile/career", headers=h, json=CAREER).status_code == 200
        return {"h": h, "id": self.http.get("/auth/me", headers=h).json()["id"]}

    def seed_job(self, company: str = "Plaid", external: str | None = None) -> int:
        external = external or uuid.uuid4().hex[:10]
        with Session(self.engine) as db:
            source = db.scalar(select(E.JobSource).where(E.JobSource.name == company))
            if source is None:
                source = E.JobSource(name=company, type="greenhouse", base_url="x", enabled=True, supports_api=True)
                db.add(source)
                db.flush()
            link = f"https://boards.greenhouse.io/{company.lower()}/{external}"
            job = E.JobPosting(source_id=source.id, external_id=external, title="Senior Machine Learning Engineer", company=company,
                               location="Remote, United States", remote_type="remote", posted_at=datetime.now(UTC) - timedelta(days=1),
                               discovered_at=datetime.now(UTC), application_url=link, source_url=link, description_raw="",
                               description_clean="ML engineer. Requirements: Python, FastAPI.", required_skills=["Python", "FastAPI"],
                               hash_for_deduplication=f"h-{company}-{external}")
            db.add(job)
            db.commit()
            return job.id

    # ---- the two ways a session starts -----------------------------------
    def website_session(self, user: dict, job_id: int) -> dict:
        body = self.http.post("/application-sessions", headers=user["h"], json={"job_id": job_id}).json()
        exchanged = self.http.post("/application-sessions/token", json={"launch_token": body["extension_launch_token"]}).json()
        return {"id": body["session_id"], "token": {"Authorization": f"Bearer {exchanged['session_token']}"}, "body": body}

    def extension_token(self, user: dict) -> dict:
        code = self.http.post("/extension/auth/code", headers=user["h"], json={"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT}).json()["code"]
        tokens = self.http.post("/extension/auth/token", json={"grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER, "redirect_uri": REDIRECT}).json()
        return {"Authorization": f"Bearer {tokens['access_token']}"}

    def direct_session(self, user: dict, url: str, wait_for_documents: bool = True) -> dict:
        ext = self.extension_token(user)
        response = self.http.post("/extension/direct-sessions", headers=ext, json={"url": url})
        assert response.status_code == 201, response.text
        body = response.json()
        token = {"Authorization": f"Bearer {body['session_token']}"}
        state = body
        if wait_for_documents:                                               # the background preparation, which runs after the response
            for _ in range(100):
                state = self.http.get(f"/application-sessions/{body['session_id']}", headers=token).json()
                if state["resume"]["status"] == "ready" and state["cover_letter"]["status"] == "ready":
                    break
                time.sleep(0.2)
        return {"id": body["session_id"], "token": token, "job_id": body["job"]["id"], "body": body, "state": state}

    # ---- reading ---------------------------------------------------------
    def entry(self, user: dict, job_id: int) -> dict:
        rows = self.http.get("/jobs/tracker/all", headers=user["h"]).json()["applications"]
        return next(r for r in rows if r["job_id"] == job_id)

    def download(self, user: dict, tracker_id: int, kind: str, fmt: str = "pdf") -> httpx.Response:
        return self.http.get(f"/jobs/tracker/{tracker_id}/documents/{kind}", headers=user["h"], params={"fmt": fmt})

    def rows(self, sql: str, **params):
        with self.engine.connect() as conn:
            return conn.execute(text(sql), params).all()


def spawn_api(api_dir: Path, url: str) -> tuple[subprocess.Popen, str]:
    """Start the API found in ``api_dir`` (this checkout, or another one) on a free port against ``url``, like staging minus its secrets."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    work = tempfile.mkdtemp(prefix="xa-prov-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENAI", "DATABASE_URL", "APP_ENV"))}
    env.update(DATABASE_URL=url, APP_ENV="development", DEBUG="false", UPLOAD_DIR=f"{work}/uploads", PYTHONPATH=str(api_dir))
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port), "--log-level", "warning"], cwd=api_dir, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{base}/health", timeout=2).status_code == 200:
                return proc, base
        except httpx.HTTPError:
            time.sleep(0.2)
    detail = proc.stdout.read(2000).decode() if proc.poll() is not None else "timeout"
    proc.kill()
    raise RuntimeError("API did not start: " + detail)


def stop_api(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="module")
def live() -> Generator[Live, None, None]:
    name = f"xa_prov_{uuid.uuid4().hex[:8]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = str(make_url(_ADMIN_URL).set(database=name))
    from alembic import command

    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(_alembic_config(url), "head")
    finally:
        os.environ.pop("DATABASE_URL", None)
    proc, base = spawn_api(API_DIR, url)
    try:
        engine = create_engine(url)
        yield Live(base, engine)
        engine.dispose()
    finally:
        stop_api(proc)
        with admin.connect() as conn:
            conn.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


def _docx_text(data: bytes) -> str:
    return "\n".join(p.text for p in Document(io.BytesIO(data)).paragraphs)


def _assert_downloads(live: Live, user: dict, tracker_id: int, company: str, kinds=("resume", "cover-letter")) -> dict[str, str]:
    """Download PDF and DOCX for each kind over HTTP; check status, MIME, filename and bytes. Returns each kind's DOCX text."""
    text_by_kind = {}
    for kind in kinds:
        label = "Cover_Letter" if kind == "cover-letter" else "Resume"
        pdf = live.download(user, tracker_id, kind, "pdf")
        assert pdf.status_code == 200, pdf.text
        assert pdf.headers["content-type"] == "application/pdf" and pdf.content[:5] == b"%PDF-" and b"%%EOF" in pdf.content[-1024:]
        assert re.fullmatch(rf'attachment; filename="{company}_{label}_\d{{4}}-\d{{2}}-\d{{2}}\.pdf"', pdf.headers["content-disposition"]), pdf.headers["content-disposition"]
        assert pdf.headers["cache-control"] == "private, no-store"
        docx = live.download(user, tracker_id, kind, "docx")
        assert docx.status_code == 200 and docx.headers["content-type"] == DOCX and docx.content[:2] == b"PK"
        assert docx.headers["content-disposition"].endswith('.docx"')
        text_by_kind[kind] = _docx_text(docx.content)
        assert text_by_kind[kind].strip()
    return text_by_kind


def _snapshots(live: Live, job_id: int):
    return live.rows("SELECT s.kind, s.association_basis, s.attached_by_extension FROM application_document_snapshots s JOIN application_tracker t ON t.id = s.tracker_id WHERE t.job_id = :j ORDER BY s.kind", j=job_id)


# --------------------------------------------------------------------------- #
# A, M: website-launched; both formats
# --------------------------------------------------------------------------- #
def test_A_website_launched_application_keeps_its_prepared_resume_and_cover_letter(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    assert session["body"]["resume"]["status"] == "ready" and session["body"]["cover_letter"]["status"] == "ready"   # template mode: no AI key is needed
    assert live.http.post(f"/application-sessions/{session['id']}/submission-confirmed", headers=session["token"],
                          json={"evidence_type": "success_page", "confirmation_source": "extension_confirmed"}).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["status"] == "applied" and entry["applied_source"] == "extension_confirmed"
    assert entry["documents_availability"] == "frozen"
    assert entry["documents"]["resume"]["association"] == "confirming_session" == entry["documents"]["cover_letter"]["association"]
    assert [tuple(r) for r in _snapshots(live, job_id)] == [("cover_letter", "confirming_session", False), ("resume", "confirming_session", False)]
    texts = _assert_downloads(live, user, entry["id"], "Plaid")
    assert "Riley Candidate" in texts["resume"]                                          # the applicant's own prepared content


# --------------------------------------------------------------------------- #
# B: direct entry with a reliably linked prepared resume
# --------------------------------------------------------------------------- #
def test_B_direct_entry_application_keeps_the_documents_prepared_for_that_page(live: Live) -> None:
    user = live.signup()
    session = live.direct_session(user, "https://careers.withwaymo.com/jobs/ml-engineer/apply")
    assert session["body"]["resume"]["status"] == "missing"                       # the request path prepares no documents (no AI on it)
    assert session["state"]["resume"]["status"] == "ready" and session["state"]["cover_letter"]["status"] == "ready", session["state"]["warnings"]
    # what the widget does: the page reached a submit step (a provisional tracker row), then the user confirms
    assert live.http.post(f"/application-sessions/{session['id']}/confirmation-required", headers=session["token"]).status_code == 200
    assert live.http.post(f"/application-sessions/{session['id']}/complete", headers=session["token"], json={"confirmed": True}).status_code == 200
    entry = live.entry(user, session["job_id"])
    assert entry["status"] == "applied" and entry["documents_availability"] == "frozen"
    assert entry["documents"]["resume"]["association"] == "confirming_session"
    _assert_downloads(live, user, entry["id"], _company(live, session["job_id"]))


def _company(live: Live, job_id: int) -> str:
    company = live.rows("SELECT company FROM job_postings WHERE id = :j", j=job_id)[0][0]
    return re.sub(r"_+", "_", re.sub(r"[^A-Za-z0-9_-]+", "_", company.replace(" ", "_"))).strip("_")[:40]


# --------------------------------------------------------------------------- #
# Helpers for the remaining scenarios
# --------------------------------------------------------------------------- #
def _tag_documents(live: Live, session_id: int, tag: str) -> None:
    """Give a session's documents recognisable content so a download can be traced back to the exact document."""
    with Session(live.engine) as db:
        row = db.get(E.ApplicationSession, session_id)
        for doc_id in (row.tailored_resume_id, row.tailored_cover_letter_id):
            if doc_id:
                doc = db.get(E.GeneratedDocument, doc_id)
                doc.content = {**(doc.content or {}), "summary": tag, "paragraphs": [tag], "greeting": f"Dear {tag}", "body": tag}
                doc.plain_text = tag
        db.commit()


def _second_session(live: Live, user_id: int, job_id: int, tag: str, *, same_documents_as: int | None = None) -> int:
    """Another prepared session for the same user and job: its own documents, or the very same ones another session points at."""
    with Session(live.engine) as db:
        first = db.scalar(select(E.ApplicationSession).where(E.ApplicationSession.job_id == job_id).order_by(E.ApplicationSession.id))
        if same_documents_as is not None:
            donor = db.get(E.ApplicationSession, same_documents_as)
            resume_id, cover_id = donor.tailored_resume_id, donor.tailored_cover_letter_id
        else:
            ids = []
            for doc_type in (E.DocumentType.resume, E.DocumentType.cover_letter):
                doc = E.GeneratedDocument(user_id=user_id, job_id=job_id, type=doc_type, format=E.DocumentFormat.json, title=tag,
                                          content={"summary": tag, "paragraphs": [tag], "greeting": f"Dear {tag}", "skills": [], "experience": [], "education": []}, plain_text=tag)
                db.add(doc)
                db.flush()
                ids.append(doc.id)
            resume_id, cover_id = ids
        second = E.ApplicationSession(user_id=user_id, job_id=job_id, source_url=first.source_url, status=E.ApplicationSessionStatus.ready,
                                      tailored_resume_id=resume_id, tailored_cover_letter_id=cover_id)
        db.add(second)
        db.commit()
        return second.id


def _confirm_manually(live: Live, user: dict, job_id: int, **body):
    return live.http.post(f"/jobs/{job_id}/applications/confirm-applied", headers=user["h"], json={"confirmed": True, **body})


def _confirm_with_session(live: Live, session: dict):
    return live.http.post(f"/application-sessions/{session['id']}/submission-confirmed", headers=session["token"],
                          json={"evidence_type": "success_page", "confirmation_source": "extension_confirmed"})


# --------------------------------------------------------------------------- #
# C: direct entry with no generated documents
# --------------------------------------------------------------------------- #
def test_C_direct_entry_without_documents_is_not_available_and_says_why(live: Live) -> None:
    user = live.signup()
    session = live.direct_session(user, "https://careers.withwaymo.com/jobs/no-docs/apply")
    with Session(live.engine) as db:                                  # generation produced nothing: remove it, as a failed generation leaves it
        row = db.get(E.ApplicationSession, session["id"])
        ids = [row.tailored_resume_id, row.tailored_cover_letter_id]
        row.tailored_resume_id = row.tailored_cover_letter_id = None
        db.flush()
        db.execute(delete(E.GeneratedDocument).where(E.GeneratedDocument.id.in_([i for i in ids if i])))
        db.commit()
    assert live.http.post(f"/application-sessions/{session['id']}/complete", headers=session["token"], json={"confirmed": True}).status_code == 200
    entry = live.entry(user, session["job_id"])
    assert entry["status"] == "applied"
    assert entry["documents"] == {"resume": None, "cover_letter": None}
    assert (entry["documents_availability"], entry["documents_unavailable_reason"]) == ("none", "documents_not_prepared")
    assert _snapshots(live, session["job_id"]) == []                                  # nothing archived, and nothing claimed as archived
    assert live.download(user, entry["id"], "resume").status_code == 404
    assert live.rows("SELECT count(*) FROM audit_logs WHERE action = 'document_snapshot_failed'")[0][0] == 0   # not a failure: there was nothing to archive


def test_C2_recorded_with_no_session_at_all(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    assert _confirm_manually(live, user, job_id).status_code == 200
    entry = live.entry(user, job_id)
    assert (entry["documents_availability"], entry["documents_unavailable_reason"]) == ("none", "no_session")
    assert entry["documents"] == {"resume": None, "cover_letter": None}


# --------------------------------------------------------------------------- #
# D, E: several sessions
# --------------------------------------------------------------------------- #
def test_D_several_sessions_only_the_confirmed_one_supplies_the_documents(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    first = live.website_session(user, job_id)
    _tag_documents(live, first["id"], "FIRST-SESSION-DOC")
    _second_session(live, user["id"], job_id, "NEWER-SESSION-DOC")
    assert _confirm_with_session(live, first).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "frozen" and entry["documents"]["resume"]["association"] == "confirming_session"
    texts = _assert_downloads(live, user, entry["id"], "Plaid")
    assert "FIRST-SESSION-DOC" in texts["resume"] and "NEWER-SESSION-DOC" not in texts["resume"] + texts["cover-letter"]   # not the newest


def test_E_several_ambiguous_sessions_are_not_guessed(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    first = live.website_session(user, job_id)
    _tag_documents(live, first["id"], "FIRST-DOC")
    _second_session(live, user["id"], job_id, "SECOND-DOC")
    assert _confirm_manually(live, user, job_id).status_code == 200                  # nothing says which session was used
    entry = live.entry(user, job_id)
    assert entry["status"] == "applied"
    assert (entry["documents_availability"], entry["documents_unavailable_reason"]) == ("unknown_association", "unknown_association")
    assert entry["documents"] == {"resume": None, "cover_letter": None} and _snapshots(live, job_id) == []
    assert live.download(user, entry["id"], "resume").status_code == 404


def test_E2_sessions_that_share_the_same_documents_are_not_ambiguous(live: Live) -> None:
    """A draft reopened after its TTL attaches the very same documents; two sessions are then one answer, not a choice."""
    user, job_id = live.signup(), live.seed_job()
    first = live.website_session(user, job_id)
    _tag_documents(live, first["id"], "SHARED-DOC")
    _second_session(live, user["id"], job_id, "unused", same_documents_as=first["id"])
    assert _confirm_manually(live, user, job_id).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "frozen" and entry["documents"]["resume"]["association"] == "sole_session"
    assert "SHARED-DOC" in _assert_downloads(live, user, entry["id"], "Plaid")["resume"]


def test_E3_the_session_that_raised_the_confirmation_is_the_evidence(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    first = live.website_session(user, job_id)
    _tag_documents(live, first["id"], "SUBMIT-STEP-DOC")
    _second_session(live, user["id"], job_id, "OTHER-DOC")
    assert live.http.post(f"/application-sessions/{first['id']}/confirmation-required", headers=first["token"]).status_code == 200
    assert _confirm_manually(live, user, job_id).status_code == 200                  # the user answers "yes" on the web, no session named
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "frozen" and entry["documents"]["resume"]["association"] == "linked_session"
    assert "SUBMIT-STEP-DOC" in _assert_downloads(live, user, entry["id"], "Plaid")["resume"]


def test_E4_a_claimed_submission_date_never_decides_which_session_counts(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    first = live.website_session(user, job_id)
    _tag_documents(live, first["id"], "ONLY-SESSION-DOC")
    earlier = (datetime.now(UTC) - timedelta(days=3)).isoformat()
    assert _confirm_manually(live, user, job_id, submitted_at=earlier).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "frozen"
    assert "ONLY-SESSION-DOC" in _assert_downloads(live, user, entry["id"], "Plaid")["resume"]


# --------------------------------------------------------------------------- #
# F, G, L: idempotence, later edits, later profile changes
# --------------------------------------------------------------------------- #
def test_F_marking_applied_twice_is_idempotent_and_never_replaces_the_archive(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    _tag_documents(live, session["id"], "ARCHIVED-ONCE")
    assert _confirm_with_session(live, session).status_code == 200
    first_ids = [r[0] for r in live.rows("SELECT s.id FROM application_document_snapshots s JOIN application_tracker t ON t.id = s.tracker_id WHERE t.job_id = :j ORDER BY s.id", j=job_id)]
    _tag_documents(live, session["id"], "CHANGED-BEFORE-SECOND-CONFIRM")           # the source changes between the two confirmations
    assert _confirm_manually(live, user, job_id).json()["already_applied"] is True
    assert _confirm_with_session(live, session).status_code == 200
    again_ids = [r[0] for r in live.rows("SELECT s.id FROM application_document_snapshots s JOIN application_tracker t ON t.id = s.tracker_id WHERE t.job_id = :j ORDER BY s.id", j=job_id)]
    assert again_ids == first_ids and len(first_ids) == 2                            # same rows, not rewritten, not duplicated
    assert live.rows("SELECT count(*) FROM application_tracker WHERE job_id = :j", j=job_id)[0][0] == 1
    entry = live.entry(user, job_id)
    texts = _assert_downloads(live, user, entry["id"], "Plaid")
    assert "ARCHIVED-ONCE" in texts["resume"] and "CHANGED-BEFORE" not in texts["resume"]


def test_G_and_L_edits_and_profile_changes_after_applying_do_not_change_the_download(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    assert _confirm_with_session(live, session).status_code == 200
    entry = live.entry(user, job_id)
    before = _assert_downloads(live, user, entry["id"], "Plaid")
    assert "Riley Candidate" in before["resume"]
    resume_id = live.rows("SELECT tailored_resume_id FROM application_sessions WHERE id = :s", s=session["id"])[0][0]
    edit = live.http.put(f"/jobs/documents/{resume_id}", headers=user["h"], json={"content": {"summary": "EDITED-AFTER-APPLYING"}, "plain_text": "EDITED"})
    assert edit.status_code == 200
    assert live.http.put("/profile", headers=user["h"], json={**PROFILE, "full_name": "Changed Name"}).status_code == 200
    after = _assert_downloads(live, user, entry["id"], "Plaid")
    assert after == before and "EDITED-AFTER-APPLYING" not in after["resume"] and "Changed Name" not in after["resume"]


# --------------------------------------------------------------------------- #
# H, P, Q: partial and job-level documents
# --------------------------------------------------------------------------- #
def test_H_resume_without_a_cover_letter(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    with Session(live.engine) as db:
        row = db.get(E.ApplicationSession, session["id"])
        cover_id, row.tailored_cover_letter_id = row.tailored_cover_letter_id, None
        db.flush()
        db.execute(delete(E.GeneratedDocument).where(E.GeneratedDocument.id == cover_id))
        db.commit()
    assert _confirm_with_session(live, session).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["documents"]["resume"] is not None and entry["documents"]["cover_letter"] is None
    assert [r[0] for r in _snapshots(live, job_id)] == ["resume"]
    _assert_downloads(live, user, entry["id"], "Plaid", kinds=("resume",))
    assert live.download(user, entry["id"], "cover-letter").status_code == 404


def test_P_documents_made_in_the_jobs_workspace_are_kept_at_confirmation_when_unique(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    assert live.http.post(f"/jobs/{job_id}/documents/resume", headers=user["h"]).status_code == 200      # the Jobs workspace, no session at all
    assert _confirm_manually(live, user, job_id).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "frozen" and entry["documents"]["resume"]["association"] == "job_document"
    assert entry["documents"]["cover_letter"] is None                                # nothing was made for it
    _assert_downloads(live, user, entry["id"], "Plaid", kinds=("resume",))


def test_Q_several_job_documents_and_no_session_are_not_guessed(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    for _ in range(2):
        assert live.http.post(f"/jobs/{job_id}/documents/resume", headers=user["h"]).status_code == 200
    assert _confirm_manually(live, user, job_id).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["documents"] == {"resume": None, "cover_letter": None} and _snapshots(live, job_id) == []
    assert entry["documents_unavailable_reason"] == "job_documents_not_linked"


# --------------------------------------------------------------------------- #
# I: a real PostgreSQL failure while archiving
# --------------------------------------------------------------------------- #
def test_I_a_snapshot_failure_keeps_applied_is_audited_and_is_not_reported_as_archived(live: Live) -> None:
    with live.engine.begin() as conn:
        conn.execute(text("CREATE OR REPLACE FUNCTION xa_block_snapshots() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated archival failure'; END $$ LANGUAGE plpgsql"))
        conn.execute(text("CREATE TRIGGER xa_block BEFORE INSERT ON application_document_snapshots FOR EACH ROW EXECUTE FUNCTION xa_block_snapshots()"))
    try:
        user, job_id = live.signup(), live.seed_job()
        session = live.website_session(user, job_id)
        assert _confirm_with_session(live, session).status_code == 200                # the confirmation is not the casualty
    finally:
        with live.engine.begin() as conn:
            conn.execute(text("DROP TRIGGER IF EXISTS xa_block ON application_document_snapshots"))
            conn.execute(text("DROP FUNCTION IF EXISTS xa_block_snapshots()"))
    entry = live.entry(user, job_id)
    assert entry["status"] == "applied" and entry["applied_at"] is not None
    assert _snapshots(live, job_id) == []
    assert entry["documents_availability"] == "historical" and entry["documents"]["resume"]["frozen"] is False   # reachable, but never "archived"
    assert live.rows("SELECT count(*) FROM audit_logs WHERE action = 'document_snapshot_failed' AND user_id = :u", u=user["id"])[0][0] == 1
    assert _confirm_manually(live, user, job_id).json()["already_applied"] is True    # a repeat does not silently archive later edits
    assert _snapshots(live, job_id) == []


# --------------------------------------------------------------------------- #
# J, N: historical records and source deletion
# --------------------------------------------------------------------------- #
def test_J_historical_application_without_a_snapshot(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    _tag_documents(live, session["id"], "HISTORICAL-DOC")
    assert _confirm_with_session(live, session).status_code == 200
    with live.engine.begin() as conn:                                                # a record from before snapshots existed
        conn.execute(text("DELETE FROM application_document_snapshots"))
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "historical" and entry["documents"]["resume"]["frozen"] is False
    assert "HISTORICAL-DOC" in _assert_downloads(live, user, entry["id"], "Plaid")["resume"]


def test_N_snapshot_content_survives_deleting_its_sources(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    _tag_documents(live, session["id"], "OUTLIVES-SOURCE")
    assert _confirm_with_session(live, session).status_code == 200
    with live.engine.begin() as conn:
        conn.execute(text("DELETE FROM application_sessions"))
        conn.execute(text("DELETE FROM generated_documents"))
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "frozen"
    assert "OUTLIVES-SOURCE" in _assert_downloads(live, user, entry["id"], "Plaid")["resume"]


# --------------------------------------------------------------------------- #
# K, O: isolation, and status changes that are not submissions
# --------------------------------------------------------------------------- #
def test_K_another_account_cannot_download_or_see_the_documents(live: Live) -> None:
    owner, job_id = live.signup("owner"), live.seed_job()
    session = live.website_session(owner, job_id)
    assert _confirm_with_session(live, session).status_code == 200
    entry = live.entry(owner, job_id)
    intruder = live.signup("intruder")
    for kind in ("resume", "cover-letter"):
        for fmt in ("pdf", "docx"):
            denied = live.download(intruder, entry["id"], kind, fmt)
            assert denied.status_code == 404 and denied.json() == {"detail": "Document not found"}
            assert "pdf" not in denied.headers["content-type"] and "officedocument" not in denied.headers["content-type"]
    assert live.http.get(f"/jobs/tracker/{entry['id']}/documents/resume").status_code == 401
    assert live.http.get("/jobs/tracker/all", headers=intruder["h"]).json()["applications"] == []
    assert owner["id"] != intruder["id"]


def test_O_changing_a_status_without_a_confirmed_submission_claims_nothing(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)                                     # documents were prepared, nothing was submitted
    assert live.http.put(f"/jobs/{job_id}/tracker", headers=user["h"], json={"status": "applying"}).status_code == 200
    assert live.http.put(f"/jobs/{job_id}/tracker", headers=user["h"], json={"status": "interview"}).status_code == 200
    entry = next(r for r in live.http.get("/jobs/tracker/all", headers=user["h"]).json()["applications"] if r["job_id"] == job_id)
    assert entry["status"] == "interview" and entry["applied_source"] is None            # no confirmed submission is claimed
    assert _snapshots(live, job_id) == []                                             # and nothing was archived as if there had been
    for kind in ("resume", "cover_letter"):
        if entry["documents"][kind]:
            assert entry["documents"][kind]["frozen"] is False and entry["documents"][kind]["attached_by_extension"] is False
    assert session["id"]


# --------------------------------------------------------------------------- #
# R: prepared is not uploaded
# --------------------------------------------------------------------------- #
def test_R_attached_is_claimed_only_for_what_the_extension_reported_and_never_for_form_filling(live: Live) -> None:
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    filled_only = live.http.post(f"/application-sessions/{session['id']}/autofill-results", headers=session["token"], json={
        "status": "completed", "ats": "greenhouse", "fields_discovered": 12, "fields_filled": 9, "documents_uploaded": [], "review_items": 3, "failures": []})
    assert filled_only.status_code == 200                                              # employer fields were filled; nothing was attached
    assert live.http.post(f"/application-sessions/{session['id']}/autofill-results", headers=session["token"], json={
        "status": "completed", "ats": "greenhouse", "fields_discovered": 12, "fields_filled": 10, "documents_uploaded": ["resume"], "review_items": 2, "failures": []}).status_code == 200
    assert _confirm_with_session(live, session).status_code == 200
    entry = live.entry(user, job_id)
    assert entry["documents"]["resume"]["attached_by_extension"] is True               # the extension reported attaching the resume
    assert entry["documents"]["cover_letter"]["attached_by_extension"] is False        # filling fields never implies a cover letter went up
    assert [tuple(r) for r in _snapshots(live, job_id)] == [("cover_letter", "confirming_session", False), ("resume", "confirming_session", True)]
    assert entry["documents"]["resume"]["reproduction"] == "re_rendered_from_saved_content"   # and a download is never the original attachment
