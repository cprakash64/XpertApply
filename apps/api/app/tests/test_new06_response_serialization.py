"""NEW-06 — response serialization on `/privacy/export` and job documents.

The defect
----------
Both routes are annotated `-> dict` but returned raw SQLAlchemy rows, so
pydantic v2 could not encode the response and FastAPI answered **500 to every
caller, the owner included**:

- `GET /privacy/export` returned `UserProfile`, `Education`, `Experience`, …
- `POST /jobs/{job_id}/documents/{doc_type}` returned a `GeneratedDocument`

Neither had any test in the suite, which is why a totally broken GDPR/CCPA
subject-access endpoint survived to a release candidate. `/privacy/export` was
500 for every user, with or without a profile.

Why it mattered beyond availability
-----------------------------------
`generate_document` commits before the response is serialized, so the document
row was created and *then* the caller got a 500. A client retrying on 500
accumulated a duplicate document per attempt — measured at three rows for three
attempts before the fix.

These tests assert the response *contract*, not merely `status_code < 500`, and
each one fails if the route reverts to handing back an ORM row.
"""

from __future__ import annotations

import json
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.main import app
from app.models import entities as E


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    assert engine.url.database in (None, ":memory:"), "refusing to run against a file database"
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override() -> Generator[Session, None, None]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def db_session() -> Session:
    return next(app.dependency_overrides[get_db]())


def signup(client: TestClient, email: str) -> dict[str, str]:
    resp = client.post("/auth/signup", json={"email": email, "password": "password123"})
    assert resp.status_code in (200, 201), resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def complete_profile(client: TestClient, headers: dict[str, str], name: str) -> None:
    assert client.put("/profile", headers=headers, json={
        "full_name": name, "phone": "602-555-0100",
        "location_city": "Phoenix", "location_state": "AZ", "location_country": "United States",
        "linkedin_url": "https://linkedin.com/in/x", "work_authorization": "authorized_us",
        "target_roles": ["Backend Engineer"], "target_levels": ["Junior"],
        "preferred_locations": ["United States"], "remote_preference": "remote",
        "skills": ["Python", "FastAPI", "PostgreSQL"],
    }).status_code == 200
    client.put("/profile/career", headers=headers, json={
        "education": [{"school": "Arizona State University", "degree": "BS"}],
        "experience": [{"company": "Cardinal Health", "title": "Engineer",
                        "bullets": ["Built Python services"], "technologies": ["Python"],
                        "currently_working": True}],
        "projects": [], "certifications": [], "awards": [],
    })


def seed_job(company: str = "Acme", external: str = "n6-1") -> int:
    from datetime import UTC, datetime, timedelta

    db = db_session()
    try:
        src = db.scalar(select(E.JobSource).where(E.JobSource.name == company))
        if src is None:
            src = E.JobSource(name=company, type="greenhouse", base_url="x", enabled=True,
                              supports_api=True)
            db.add(src)
            db.flush()
        url = f"https://boards.greenhouse.io/{company.lower()}/1"
        job = E.JobPosting(
            source_id=src.id, external_id=external, title="Backend Engineer", company=company,
            location="Remote, United States", remote_type="remote",
            posted_at=datetime.now(UTC) - timedelta(days=1), discovered_at=datetime.now(UTC),
            application_url=url, source_url=url, description_raw="",
            description_clean="Backend Engineer. Requirements: Python, FastAPI.",
            required_skills=["Python", "FastAPI"], hash_for_deduplication=f"h-{external}",
        )
        db.add(job)
        db.commit()
        return job.id
    finally:
        db.close()


EXPORT_CATEGORIES = {
    "user", "profile", "career", "sensitive_demographics", "matches",
    "documents", "applications", "people_recommendations",
    "people_discovery_runs", "people_feedback",
}
CAREER_CATEGORIES = {"education", "experience", "projects", "certifications", "awards"}


# --------------------------------------------------------------------------- #
# Privacy export
# --------------------------------------------------------------------------- #
def test_privacy_export_succeeds_and_is_json(client: TestClient) -> None:
    headers = signup(client, "export@mailbox.test-domain.co")
    complete_profile(client, headers, "Export User")

    resp = client.get("/privacy/export", headers=headers)
    assert resp.status_code == 200, resp.text

    body = resp.json()
    # A full re-encode proves nothing survived as an un-encodable object.
    json.dumps(body)

    assert set(body) == EXPORT_CATEGORIES, f"export categories changed: {sorted(body)}"
    assert set(body["career"]) == CAREER_CATEGORIES
    assert isinstance(body["profile"], dict), "profile must be a mapping, not an ORM row"
    assert body["profile"]["full_name"] == "Export User"
    assert body["user"]["email"] == "export@mailbox.test-domain.co"
    for key in ("matches", "documents", "applications", "people_recommendations",
                "people_discovery_runs", "people_feedback"):
        assert isinstance(body[key], list), f"{key} must be a list"
    for key in CAREER_CATEGORIES:
        assert isinstance(body["career"][key], list)
    assert all(isinstance(row, dict) for row in body["career"]["education"])


def test_privacy_export_succeeds_for_a_user_with_no_data(client: TestClient) -> None:
    """The empty state was 500 too, so "needs data" was never the cause."""
    headers = signup(client, "bare@mailbox.test-domain.co")
    resp = client.get("/privacy/export", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    json.dumps(body)
    assert set(body) == EXPORT_CATEGORIES
    assert body["sensitive_demographics"] is None
    for key in ("matches", "documents", "applications"):
        assert body[key] == []


def test_privacy_export_serializes_documents_through_the_shared_contract(
    client: TestClient,
) -> None:
    headers = signup(client, "docs@mailbox.test-domain.co")
    complete_profile(client, headers, "Docs User")
    job_id = seed_job()
    created = client.post(f"/jobs/{job_id}/documents/resume", headers=headers, json={})
    assert created.status_code == 200, created.text

    body = client.get("/privacy/export", headers=headers).json()
    assert len(body["documents"]) == 1
    document = body["documents"][0]
    # The same representation every document route returns.
    assert {"document_id", "document_type", "title", "download_urls"} <= set(document)
    assert document["document_type"] == "resume"


def test_privacy_export_excludes_credentials_and_storage_paths(client: TestClient) -> None:
    """The export must not become a credential or filesystem disclosure.

    `public_dict` drops `hashed_password` but knows nothing about
    `workday_password_ciphertext`, so serializing the profile row would have put
    an encrypted ATS credential into the export body. `serialize_document`
    likewise omits the `*_file_path` columns in favour of `download_urls`.
    """
    from app.routes.privacy import EXPORT_EXCLUDED_COLUMNS

    assert "workday_password_ciphertext" in EXPORT_EXCLUDED_COLUMNS

    headers = signup(client, "creds@mailbox.test-domain.co")
    complete_profile(client, headers, "Creds User")
    assert client.put("/profile/workday-credentials", headers=headers,
                      json={"username": "creds@example.com",
                            "password": "sup3r-secret-value"}).status_code in (200, 204)
    job_id = seed_job()
    client.post(f"/jobs/{job_id}/documents/resume", headers=headers, json={})

    resp = client.get("/privacy/export", headers=headers)
    assert resp.status_code == 200, resp.text
    raw = resp.text

    assert "sup3r-secret-value" not in raw, "export leaked a stored credential"
    for forbidden in ("workday_password_ciphertext", "hashed_password",
                      "file_path", "docx_file_path", "pdf_file_path"):
        assert forbidden not in raw, f"export leaked {forbidden}"

    body = resp.json()
    assert "workday_password_ciphertext" not in body["profile"]
    # The profile is still genuinely present, so the assertion is not vacuous.
    assert body["profile"]["full_name"] == "Creds User"


def test_privacy_export_requires_authentication(client: TestClient) -> None:
    assert client.get("/privacy/export").status_code == 401
    assert client.get(
        "/privacy/export", headers={"Authorization": "Bearer not-a-jwt"}
    ).status_code in (401, 403)


def test_privacy_export_contains_only_the_callers_own_data(client: TestClient) -> None:
    """The isolation property this endpoint could not previously demonstrate."""
    a = signup(client, "owner-a@mailbox.test-domain.co")
    complete_profile(client, a, "Owner Alpha")
    job_a = seed_job("Acme", "n6-a")
    client.post(f"/jobs/{job_a}/documents/resume", headers=a, json={})

    b = signup(client, "stranger-b@mailbox.test-domain.co")
    complete_profile(client, b, "Stranger Bravo")
    job_b = seed_job("Globex", "n6-b")
    client.post(f"/jobs/{job_b}/documents/resume", headers=b, json={})

    export_a = client.get("/privacy/export", headers=a)
    export_b = client.get("/privacy/export", headers=b)
    assert export_a.status_code == 200 and export_b.status_code == 200

    assert "Owner Alpha" in export_a.text, "A's own export is missing A — test would be vacuous"
    assert "Stranger Bravo" not in export_a.text, "A's export contained B's profile"
    assert "stranger-b@" not in export_a.text, "A's export contained B's email"

    assert "Stranger Bravo" in export_b.text
    assert "Owner Alpha" not in export_b.text, "B's export contained A's profile"
    assert "owner-a@" not in export_b.text

    a_documents = {d["document_id"] for d in export_a.json()["documents"]}
    b_documents = {d["document_id"] for d in export_b.json()["documents"]}
    assert a_documents and b_documents
    assert a_documents.isdisjoint(b_documents), "exports shared a document"


# --------------------------------------------------------------------------- #
# Job document creation
# --------------------------------------------------------------------------- #
def test_job_document_creation_returns_the_document_contract(client: TestClient) -> None:
    headers = signup(client, "owner@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner User")
    job_id = seed_job()

    resp = client.post(f"/jobs/{job_id}/documents/resume", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    json.dumps(body)

    assert set(body) == {"document"}, f"unexpected envelope: {sorted(body)}"
    document = body["document"]
    assert isinstance(document, dict), "document must be a mapping, not an ORM row"
    assert {"document_id", "document_type", "title", "content", "download_urls"} <= set(document)
    assert document["document_type"] == "resume"
    assert isinstance(document["document_id"], int)
    assert document["download_urls"]["pdf"] == f"/jobs/documents/{document['document_id']}/download/pdf"

    # The returned id is real: it downloads for its owner.
    assert client.get(document["download_urls"]["pdf"], headers=headers).status_code == 200


def test_job_document_creation_supports_cover_letters(client: TestClient) -> None:
    headers = signup(client, "cover@mailbox.test-domain.co")
    complete_profile(client, headers, "Cover User")
    job_id = seed_job()
    resp = client.post(f"/jobs/{job_id}/documents/cover_letter", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["document"]["document_type"] == "cover_letter"


def test_job_document_creation_rejects_an_unknown_type(client: TestClient) -> None:
    headers = signup(client, "bad@mailbox.test-domain.co")
    complete_profile(client, headers, "Bad Type")
    job_id = seed_job()
    assert client.post(f"/jobs/{job_id}/documents/nonsense",
                       headers=headers, json={}).status_code == 422


def test_job_document_creation_is_caller_scoped_on_a_shared_job(client: TestClient) -> None:
    """The job is shared catalogue data; the document it produces is not."""
    a = signup(client, "owner-a@mailbox.test-domain.co")
    complete_profile(client, a, "Owner Alpha")
    b = signup(client, "stranger-b@mailbox.test-domain.co")
    complete_profile(client, b, "Stranger Bravo")
    shared_job = seed_job("Acme", "n6-shared")

    doc_a = client.post(f"/jobs/{shared_job}/documents/resume", headers=a, json={})
    doc_b = client.post(f"/jobs/{shared_job}/documents/resume", headers=b, json={})
    assert doc_a.status_code == 200 and doc_b.status_code == 200
    id_a = doc_a.json()["document"]["document_id"]
    id_b = doc_b.json()["document"]["document_id"]
    assert id_a != id_b, "both users received the same document"

    db = db_session()
    try:
        row_a = db.get(E.GeneratedDocument, id_a)
        row_b = db.get(E.GeneratedDocument, id_b)
        users = {row.user_id for row in (row_a, row_b)}
        assert len(users) == 2, "documents are not owned by distinct users"
    finally:
        db.close()

    # Neither response carries the other user's identity.
    assert "Stranger Bravo" not in doc_a.text
    assert "Owner Alpha" not in doc_b.text

    # And neither user can reach the other's document by id.
    for headers, foreign_id in ((a, id_b), (b, id_a)):
        assert client.get(f"/jobs/documents/{foreign_id}/download/pdf",
                          headers=headers).status_code in (403, 404)
        assert client.post(f"/jobs/documents/{foreign_id}/export/pdf",
                           headers=headers).status_code in (403, 404)
        assert client.put(f"/jobs/documents/{foreign_id}", headers=headers,
                          json={"title": "stolen"}).status_code in (403, 404)


def test_job_document_creation_versions_rather_than_deduplicates(client: TestClient) -> None:
    """Repeat calls create a new document each time.

    That is the existing behaviour of every generation route — `generate-resume`
    and `generate-materials` both persist a fresh row per call — so it is
    product semantics, not a NEW-06 regression. It is pinned here because the
    500 made it dangerous: a client retrying a failed-looking request
    accumulated a document per attempt. With the response fixed there is no
    longer a retry driver, and the duplicate-on-purpose behaviour is explicit.
    """
    headers = signup(client, "retry@mailbox.test-domain.co")
    complete_profile(client, headers, "Retry User")
    job_id = seed_job()

    ids = []
    for _ in range(3):
        resp = client.post(f"/jobs/{job_id}/documents/resume", headers=headers, json={})
        assert resp.status_code == 200, resp.text
        ids.append(resp.json()["document"]["document_id"])
    assert len(set(ids)) == 3, f"expected three distinct versions, got {ids}"

    sibling = client.post(f"/jobs/{job_id}/generate-resume", headers=headers, json={})
    assert sibling.status_code == 200, sibling.text
    assert sibling.json()["document_id"] not in ids, (
        "the sibling generation route deduplicates while this one does not"
    )


# --------------------------------------------------------------------------- #
# Negative controls — these tests must fail on the old behaviour
# --------------------------------------------------------------------------- #
def test_returning_an_orm_row_would_break_the_job_document_contract(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Restore the defect at test level and prove the contract test catches it."""
    from app.routes import jobs as jobs_route

    headers = signup(client, "control@mailbox.test-domain.co")
    complete_profile(client, headers, "Control User")
    job_id = seed_job()

    assert client.post(f"/jobs/{job_id}/documents/resume",
                       headers=headers, json={}).status_code == 200

    monkeypatch.setattr(jobs_route, "serialize_document", lambda record, **kwargs: record)
    broken = client.post(f"/jobs/{job_id}/documents/resume", headers=headers, json={})
    assert broken.status_code == 500, (
        "handing back the raw ORM row no longer fails — the serialization "
        "assertions in this module are not load-bearing"
    )


def test_returning_orm_rows_would_break_the_privacy_export_contract(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.routes import privacy as privacy_route

    headers = signup(client, "control2@mailbox.test-domain.co")
    complete_profile(client, headers, "Control Two")

    assert client.get("/privacy/export", headers=headers).status_code == 200

    monkeypatch.setattr(privacy_route, "_export_dict", lambda row: row)
    broken = client.get("/privacy/export", headers=headers)
    assert broken.status_code == 500, (
        "handing back raw ORM rows no longer fails — the export serialization "
        "assertions in this module are not load-bearing"
    )
