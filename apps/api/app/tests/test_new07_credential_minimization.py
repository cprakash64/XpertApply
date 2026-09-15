"""NEW-07 — credential material must not reach AI payloads or snapshots.

The defect
----------
`profile_payload` built its profile section with `public_dict`, which copies
every `UserProfile` column and subtracts only `hashed_password`. When
`workday_password_ciphertext` (the encrypted employer-portal password) was
added, it silently joined every AI prompt and every
`GeneratedDocument.source_profile_snapshot`. Measured before the fix: the
ciphertext left for OpenAI on six requests across four routes, and was
persisted in document snapshots. No plaintext and no key were exposed.

What these tests hold in place
------------------------------
1. The projection is an **allow-list**, so a newly added `UserProfile` column is
   inert until somebody lists it. `test_a_new_profile_column_is_fail_closed`
   fails when a column belongs to neither the allow-list nor the reviewed
   exclusion set, forcing the decision instead of defaulting to exposure.
2. Canary assertions at the **real provider boundary** — the interception point
   is the OpenAI client itself, after every serialization layer, so a renamed or
   nested key cannot slip past by changing shape.
3. Snapshot writes and the document-copy path stay clean, so an old unsafe row
   cannot seed a new one.
4. The credential still works where it is genuinely needed. Minimization must
   not amount to breaking the Workday feature.
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
from app.services.profile_projection import (
    AI_PROFILE_EXCLUDED_FIELDS,
    AI_PROFILE_FIELDS,
    CREDENTIAL_KEY_NAMES,
    find_credential_key_paths,
    safe_profile_dict,
    scrub_credential_keys,
)

#: Distinct canaries so a failure names which class of material escaped.
PLAINTEXT_CANARY = "NEW07-PLAINTEXT-CANARY-8f3a"
KEY_CANARY = "NEW07-ENCRYPTION-KEY-CANARY-4b71"

CREDENTIAL_COLUMN = "workday_password_ciphertext"


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


def seed_job(company: str = "Acme", external: str = "n7-1") -> int:
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


@pytest.fixture()
def provider_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Intercept the OpenAI client itself — the last hop before the network.

    Asserting on `profile_payload` would only prove one layer is clean. The
    interception point here is after prompt assembly and after `json.dumps`, so
    the assertions cover whatever actually would have been transmitted.
    """
    from app.ai import provider as prov
    from app.core.config import settings

    sent: list[dict] = []

    class FakeCompletions:
        async def create(self, **kwargs):
            sent.append(kwargs)

            class Message:
                content = json.dumps({"paragraphs": ["Tailored paragraph. " * 40]})

            class Choice:
                message = Message()

            class Response:
                choices = [Choice()]

            return Response()

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    monkeypatch.setattr(prov.ai_provider, "client", FakeClient())
    monkeypatch.setattr(settings, "openai_model_smart", "fake-smart")
    monkeypatch.setattr(settings, "openai_model_fast", "fake-fast")
    # A canary key so "the key never leaves" is a real assertion rather than a
    # statement about an empty config value.
    monkeypatch.setattr(settings, "workday_credentials_encryption_key", KEY_CANARY)
    return sent


def store_credential(client: TestClient, headers: dict[str, str]) -> str:
    """Store the canary credential through the real endpoint; return ciphertext."""
    resp = client.put("/profile/workday-credentials", headers=headers,
                      json={"username": "owner@example.com", "password": PLAINTEXT_CANARY})
    assert resp.status_code in (200, 204), resp.text
    db = db_session()
    try:
        profile = db.scalar(select(E.UserProfile))
        ciphertext = getattr(profile, CREDENTIAL_COLUMN)
        assert ciphertext, "credential was not stored — the test would be vacuous"
        return ciphertext
    finally:
        db.close()


def assert_calls_clean(calls: list[dict], ciphertext: str, *, expected_min: int = 1) -> None:
    """No canary value and no credential key name in any outgoing request."""
    assert len(calls) >= expected_min, (
        f"expected at least {expected_min} provider call(s), saw {len(calls)}"
    )
    for index, call in enumerate(calls, 1):
        blob = json.dumps(call.get("messages", []), default=str)
        assert ciphertext not in blob, f"call {index}: ciphertext transmitted"
        assert PLAINTEXT_CANARY not in blob, f"call {index}: PLAINTEXT transmitted"
        assert KEY_CANARY not in blob, f"call {index}: encryption key transmitted"
        for name in CREDENTIAL_KEY_NAMES:
            assert f'"{name}"' not in blob, f"call {index}: credential key {name!r} present"


# --------------------------------------------------------------------------- #
# 1. The projection itself
# --------------------------------------------------------------------------- #
def test_the_projection_is_an_allow_list_not_a_deny_list() -> None:
    columns = {c.name for c in E.UserProfile.__table__.columns}
    # Every allow-listed name is a real column: the list cannot drift into fiction.
    assert AI_PROFILE_FIELDS <= columns, AI_PROFILE_FIELDS - columns
    assert CREDENTIAL_COLUMN not in AI_PROFILE_FIELDS
    assert CREDENTIAL_COLUMN in AI_PROFILE_EXCLUDED_FIELDS


def test_a_new_profile_column_is_fail_closed() -> None:
    """The core NEW-07 property.

    A column added to `UserProfile` must not reach AI payloads by default. Every
    column has to be classified, so this fails loudly on the next schema change
    rather than quietly exposing it — which is exactly how NEW-07 happened.
    """
    columns = {c.name for c in E.UserProfile.__table__.columns}
    classified = AI_PROFILE_FIELDS | set(AI_PROFILE_EXCLUDED_FIELDS)
    unclassified = columns - classified
    assert not unclassified, (
        "UserProfile column(s) are neither allow-listed for AI payloads nor "
        f"explicitly excluded: {sorted(unclassified)}. Add each to "
        "AI_PROFILE_FIELDS (safe for prompts and snapshots) or to "
        "AI_PROFILE_EXCLUDED_FIELDS with a reason."
    )


def test_safe_profile_dict_omits_the_credential_even_when_present() -> None:
    class FakeProfile:
        full_name = "Owner A"
        skills = ["Python"]

    setattr(FakeProfile, CREDENTIAL_COLUMN, "ciphertext-value")
    projected = safe_profile_dict(FakeProfile())
    assert projected["full_name"] == "Owner A"
    assert CREDENTIAL_COLUMN not in projected
    assert "ciphertext-value" not in json.dumps(projected)


def test_safe_profile_dict_ignores_attributes_it_does_not_allow_list() -> None:
    """An attribute the model gains later is not picked up implicitly."""
    class FakeProfile:
        full_name = "Owner A"
        some_future_secret_column = "should-not-appear"

    projected = safe_profile_dict(FakeProfile())
    assert "some_future_secret_column" not in projected
    assert "should-not-appear" not in json.dumps(projected)


def test_scrub_removes_nested_credential_keys_without_reading_values() -> None:
    payload = {
        "profile": {"full_name": "Owner", CREDENTIAL_COLUMN: "secret-a"},
        "list": [{"api_key": "secret-b"}, {"safe": "keep"}],
        "nested": {"deep": {"access_token": "secret-c", "city": "Phoenix"}},
    }
    cleaned, removed = scrub_credential_keys(payload)
    assert removed == 3
    blob = json.dumps(cleaned)
    for secret in ("secret-a", "secret-b", "secret-c"):
        assert secret not in blob
    assert cleaned["profile"]["full_name"] == "Owner"
    assert cleaned["nested"]["deep"]["city"] == "Phoenix"
    assert cleaned["list"][1]["safe"] == "keep"


def test_scrub_does_not_strike_legitimate_lookalike_fields() -> None:
    """Substring matching would destroy real user data; exact names do not."""
    payload = {"credential_url": "https://credly.example/badge",
               "job_content_hash": "abc123",
               "password_reset_instructions_url": "https://example/help"}
    cleaned, removed = scrub_credential_keys(payload)
    assert removed == 0
    assert cleaned == payload


def test_find_credential_key_paths_reports_paths_not_values() -> None:
    payload = {"profile": {CREDENTIAL_COLUMN: "secret"}, "rows": [{"api_key": "secret2"}]}
    paths = find_credential_key_paths(payload)
    assert f"profile.{CREDENTIAL_COLUMN}" in paths
    assert "rows[0].api_key" in paths
    assert all("secret" not in path for path in paths)


# --------------------------------------------------------------------------- #
# 2. The external provider boundary
# --------------------------------------------------------------------------- #
def test_generate_resume_sends_no_credential_material(
    client: TestClient, provider_calls
) -> None:
    headers = signup(client, "resume@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)
    job_id = seed_job("Acme", "n7-resume")

    resp = client.post(f"/jobs/{job_id}/generate-resume", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    assert_calls_clean(provider_calls, ciphertext)


def test_generate_cover_letter_sends_no_credential_material(
    client: TestClient, provider_calls
) -> None:
    headers = signup(client, "cover@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)
    job_id = seed_job("Acme", "n7-cover")

    resp = client.post(f"/jobs/{job_id}/generate-cover-letter", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    assert_calls_clean(provider_calls, ciphertext)


def test_documents_cover_letter_sends_no_credential_material(
    client: TestClient, provider_calls
) -> None:
    headers = signup(client, "doccover@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)
    job_id = seed_job("Acme", "n7-doccover")

    resp = client.post(f"/jobs/{job_id}/documents/cover_letter", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    assert_calls_clean(provider_calls, ciphertext)


def test_application_session_creation_sends_no_credential_on_any_call(
    client: TestClient, provider_calls
) -> None:
    """Session creation makes several provider calls; every one must be clean."""
    headers = signup(client, "session@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)
    job_id = seed_job("Acme", "n7-session")

    resp = client.post("/application-sessions", headers=headers, json={"job_id": job_id})
    assert resp.status_code in (200, 201), resp.text
    # Measured at three before the fix; assert on all of them, not just the first.
    assert_calls_clean(provider_calls, ciphertext, expected_min=2)


def test_the_provider_guard_strips_credential_keys_injected_downstream(
    client: TestClient, provider_calls
) -> None:
    """Defense in depth: the boundary guard, exercised independently.

    The allow-list is the real control, so this drives `json_task` directly with
    a payload that already contains credential keys — simulating some future
    helper that bypasses the projection.
    """
    import asyncio

    from app.ai.provider import ai_provider

    payload = {
        "profile": {"full_name": "Owner A", CREDENTIAL_COLUMN: "injected-secret"},
        "nested": [{"api_key": "another-secret"}],
    }
    asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
        ai_provider.json_task("cover_letter.md", payload, smart=True)
    )
    assert provider_calls, "the guard must not prevent the call from happening"
    blob = json.dumps(provider_calls[0].get("messages", []), default=str)
    assert "injected-secret" not in blob
    assert "another-secret" not in blob
    assert CREDENTIAL_COLUMN not in blob
    # The legitimate content still travels.
    assert "Owner A" in blob


# --------------------------------------------------------------------------- #
# 3. Snapshot writes
# --------------------------------------------------------------------------- #
def snapshot_of(document_id: int) -> dict:
    db = db_session()
    try:
        record = db.get(E.GeneratedDocument, document_id)
        return dict(record.source_profile_snapshot or {})
    finally:
        db.close()


def test_new_document_snapshots_are_clean_but_still_useful(
    client: TestClient, provider_calls
) -> None:
    headers = signup(client, "snap@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)
    job_id = seed_job("Acme", "n7-snap")

    resp = client.post(f"/jobs/{job_id}/generate-resume", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    snapshot = snapshot_of(resp.json()["document_id"])

    blob = json.dumps(snapshot, default=str)
    assert ciphertext not in blob, "snapshot retained the ciphertext"
    assert PLAINTEXT_CANARY not in blob
    assert CREDENTIAL_COLUMN not in blob
    assert not find_credential_key_paths(snapshot)

    # Sanitization must not hollow out provenance.
    assert snapshot["profile"]["full_name"] == "Owner A"
    assert snapshot["profile"]["skills"], "snapshot lost the skills it explains the resume with"
    assert snapshot["experience"], "snapshot lost the experience it was generated from"


def test_editing_a_legacy_unsafe_document_does_not_propagate_the_credential(
    client: TestClient, provider_calls
) -> None:
    """An old row cannot seed a new one (§34).

    Rows written before NEW-07 still hold the ciphertext. The document-copy path
    scrubs, so editing a frozen legacy document produces a clean new version.
    """
    headers = signup(client, "legacy@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    job_id = seed_job("Acme", "n7-legacy")
    created = client.post(f"/jobs/{job_id}/generate-resume", headers=headers, json={})
    document_id = created.json()["document_id"]

    # Re-create the pre-fix state, and freeze it so editing takes the copy path.
    import copy
    from datetime import UTC, datetime

    from sqlalchemy.orm.attributes import flag_modified

    db = db_session()
    try:
        record = db.get(E.GeneratedDocument, document_id)
        snapshot = copy.deepcopy(record.source_profile_snapshot or {})
        snapshot.setdefault("profile", {})[CREDENTIAL_COLUMN] = "legacy-ciphertext-value"
        record.source_profile_snapshot = snapshot
        flag_modified(record, "source_profile_snapshot")
        record.immutable_at = datetime.now(UTC)
        db.commit()
    finally:
        db.close()
    assert CREDENTIAL_COLUMN in json.dumps(snapshot_of(document_id))

    updated = client.put(f"/jobs/documents/{document_id}", headers=headers,
                         json={"title": "Edited"})
    assert updated.status_code == 200, updated.text
    new_id = updated.json()["document_id"]
    assert new_id != document_id, "the edit did not take the copy path"

    new_blob = json.dumps(snapshot_of(new_id), default=str)
    assert "legacy-ciphertext-value" not in new_blob, "the copy inherited the credential"
    assert CREDENTIAL_COLUMN not in new_blob


def test_application_session_profile_snapshot_is_clean(
    client: TestClient, provider_calls
) -> None:
    """`application_sessions.profile_snapshot` is built by a separate hand-written
    allow-list, so it was never affected. Pinned so it stays that way."""
    headers = signup(client, "sesssnap@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)
    job_id = seed_job("Acme", "n7-sesssnap")

    resp = client.post("/application-sessions", headers=headers, json={"job_id": job_id})
    assert resp.status_code in (200, 201), resp.text

    db = db_session()
    try:
        session = db.scalar(select(E.ApplicationSession))
        blob = json.dumps(session.profile_snapshot or {}, default=str)
    finally:
        db.close()
    assert ciphertext not in blob
    assert CREDENTIAL_COLUMN not in blob
    assert "Owner A" in blob, "the session snapshot lost its legitimate content"


# --------------------------------------------------------------------------- #
# 4. The credential still works where it is needed
# --------------------------------------------------------------------------- #
def test_workday_credential_storage_and_removal_still_work(client: TestClient) -> None:
    """Minimization must not break the feature that owns the credential."""
    from app.profile.credentials import decrypt_workday_password

    headers = signup(client, "wd@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)

    # Still decryptable server-side: the authoritative store is untouched.
    assert decrypt_workday_password(ciphertext) == PLAINTEXT_CANARY

    status = client.get("/profile", headers=headers)
    assert status.status_code == 200
    assert status.json()["profile"]["workday_password_configured"] is True

    removed = client.request("DELETE", "/profile/workday-credentials", headers=headers)
    assert removed.status_code in (200, 204), removed.text
    db = db_session()
    try:
        profile = db.scalar(select(E.UserProfile))
        assert getattr(profile, CREDENTIAL_COLUMN) is None
    finally:
        db.close()


def test_profile_api_still_returns_legitimate_fields(client: TestClient) -> None:
    """The narrower AI projection must not narrow user-facing responses."""
    headers = signup(client, "papi@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    resp = client.get("/profile", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()["profile"]
    for field in ("full_name", "location_city", "linkedin_url", "skills", "target_roles"):
        assert field in body, f"profile API lost {field}"
    assert body["full_name"] == "Owner A"
    # The flag is exposed; the ciphertext itself never is.
    assert "workday_password_configured" in body
    assert CREDENTIAL_COLUMN not in resp.text


def test_privacy_export_still_excludes_the_credential(client: TestClient) -> None:
    """NEW-06 non-regression."""
    headers = signup(client, "exp@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    store_credential(client, headers)
    resp = client.get("/privacy/export", headers=headers)
    assert resp.status_code == 200, resp.text
    assert CREDENTIAL_COLUMN not in resp.text
    assert PLAINTEXT_CANARY not in resp.text
    assert resp.json()["profile"]["full_name"] == "Owner A"


# --------------------------------------------------------------------------- #
# 5. Historical cleanup tooling
# --------------------------------------------------------------------------- #
def seed_snapshot_rows(count: int, *, unsafe: int, malformed: int = 0) -> list[int]:
    """Create documents whose snapshots mix safe, unsafe and malformed shapes."""
    db = db_session()
    ids: list[int] = []
    try:
        user = E.User(email="hist@mailbox.test-domain.co", hashed_password="x")
        db.add(user)
        db.flush()
        src = E.JobSource(name="Hist", type="greenhouse", base_url="x", enabled=True,
                          supports_api=True)
        db.add(src)
        db.flush()
        from datetime import UTC, datetime, timedelta

        job = E.JobPosting(
            source_id=src.id, external_id="hist-1", title="Engineer", company="Hist",
            location="Remote", remote_type="remote",
            posted_at=datetime.now(UTC) - timedelta(days=1), discovered_at=datetime.now(UTC),
            application_url="https://x/1", source_url="https://x/1", description_raw="",
            description_clean="x", required_skills=[], hash_for_deduplication="h-hist-1",
        )
        db.add(job)
        db.flush()
        for index in range(count):
            if index < unsafe:
                snapshot = {
                    "profile": {"full_name": f"User {index}", CREDENTIAL_COLUMN: "old-secret"},
                    "experience": [{"company": "Acme"}],
                }
            elif index < unsafe + malformed:
                snapshot = ["not", "an", "object"]
            else:
                snapshot = {"profile": {"full_name": f"User {index}"}}
            record = E.GeneratedDocument(
                user_id=user.id, job_id=job.id, type=E.DocumentType.resume,
                format=E.DocumentFormat.json, title=f"doc {index}", content={},
                source_profile_snapshot=snapshot,
            )
            db.add(record)
            db.flush()
            ids.append(record.id)
        db.commit()
        return ids
    finally:
        db.close()


def run_sanitizer(**kwargs):
    """Drive the maintenance script against the test session."""
    import importlib.util
    from pathlib import Path

    root = Path(__file__).resolve().parents[4]
    path = root / "scripts" / "sanitize_profile_snapshots.py"
    spec = importlib.util.spec_from_file_location("sanitize_profile_snapshots", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    report = module.Report()
    db = db_session()
    try:
        module.sanitize_target(
            db, E.GeneratedDocument, "source_profile_snapshot", report=report, **kwargs
        )
        return report
    finally:
        db.close()


def unsafe_row_count() -> int:
    db = db_session()
    try:
        rows = db.scalars(select(E.GeneratedDocument)).all()
        return sum(
            1 for row in rows
            if isinstance(row.source_profile_snapshot, dict)
            and find_credential_key_paths(row.source_profile_snapshot)
        )
    finally:
        db.close()


def test_cleanup_dry_run_reports_candidates_and_changes_nothing(client: TestClient) -> None:
    seed_snapshot_rows(6, unsafe=4)
    assert unsafe_row_count() == 4

    report = run_sanitizer(apply_changes=False, batch_size=10, max_rows=None)
    assert report.scanned == 6
    assert report.candidates == 4
    assert report.sanitized == 0, "dry run modified rows"
    assert unsafe_row_count() == 4, "dry run modified rows"

    rendered = report.render(applied=False)
    assert "DRY-RUN" in rendered
    assert "old-secret" not in rendered, "the report leaked a stored value"
    assert f"profile.{CREDENTIAL_COLUMN}" in rendered


def test_cleanup_apply_sanitizes_and_preserves_safe_data(client: TestClient) -> None:
    seed_snapshot_rows(6, unsafe=4)
    report = run_sanitizer(apply_changes=True, batch_size=10, max_rows=None)
    assert report.candidates == 4
    assert report.sanitized == 4
    assert report.keys_removed == 4
    assert unsafe_row_count() == 0

    db = db_session()
    try:
        rows = db.scalars(select(E.GeneratedDocument)).all()
        for row in rows:
            snapshot = row.source_profile_snapshot
            if not isinstance(snapshot, dict):
                continue
            blob = json.dumps(snapshot, default=str)
            assert "old-secret" not in blob
            assert CREDENTIAL_COLUMN not in blob
            # Safe content survived; snapshots were not blanked to pass.
            assert snapshot["profile"]["full_name"].startswith("User")
        # Ownership untouched.
        assert len({row.user_id for row in rows}) == 1
    finally:
        db.close()


def test_cleanup_is_idempotent(client: TestClient) -> None:
    seed_snapshot_rows(5, unsafe=3)
    first = run_sanitizer(apply_changes=True, batch_size=10, max_rows=None)
    assert first.sanitized == 3

    second = run_sanitizer(apply_changes=True, batch_size=10, max_rows=None)
    assert second.candidates == 0, "a second run found work to do"
    assert second.sanitized == 0
    assert unsafe_row_count() == 0


def test_cleanup_respects_batching_across_many_rows(client: TestClient) -> None:
    seed_snapshot_rows(25, unsafe=25)
    report = run_sanitizer(apply_changes=True, batch_size=4, max_rows=None)
    assert report.scanned == 25
    assert report.sanitized == 25
    assert unsafe_row_count() == 0


def test_cleanup_honours_max_rows_bound(client: TestClient) -> None:
    seed_snapshot_rows(10, unsafe=10)
    report = run_sanitizer(apply_changes=True, batch_size=3, max_rows=6)
    assert report.scanned == 6, f"scanned {report.scanned}, exceeding the bound"
    assert report.sanitized == 6
    assert unsafe_row_count() == 4, "rows beyond the bound should remain for the next run"


def test_cleanup_skips_malformed_snapshots_without_destroying_them(
    client: TestClient,
) -> None:
    """A snapshot that is not an object is counted and left alone — never blanked."""
    seed_snapshot_rows(6, unsafe=3, malformed=2)
    report = run_sanitizer(apply_changes=True, batch_size=10, max_rows=None)
    assert report.skipped_malformed == 2
    assert report.sanitized == 3

    db = db_session()
    try:
        malformed = [row.source_profile_snapshot for row in db.scalars(select(E.GeneratedDocument))
                     if not isinstance(row.source_profile_snapshot, dict)]
        assert len(malformed) == 2
        assert all(value == ["not", "an", "object"] for value in malformed), (
            "a malformed snapshot was altered or wiped"
        )
    finally:
        db.close()


def test_bounded_cleanup_runs_resume_and_converge(client: TestClient) -> None:
    """Chained `--max-rows` invocations must finish the table.

    Regression test for a defect found at the NEW-07 checkpoint. The scan
    originally paged with OFFSET starting at 0, so every bounded invocation
    re-examined the same already-clean prefix, reported "0 candidates", and
    never reached the rest of the table — a false completion signal that would
    have left credential material in place while looking finished. Keyset paging
    on the primary key fixes it; `last_id` is the resume token.
    """
    seed_snapshot_rows(10, unsafe=10)
    assert unsafe_row_count() == 10

    cursor: int | None = None
    runs = 0
    while runs < 10:
        report = run_sanitizer(
            apply_changes=True, batch_size=2, max_rows=3, start_after_id=cursor
        )
        runs += 1
        if report.scanned == 0:
            break
        assert report.scanned <= 3, f"bound exceeded: scanned {report.scanned}"
        assert report.last_id is not None
        assert cursor is None or report.last_id > cursor, "cursor did not advance"
        cursor = report.last_id

    assert unsafe_row_count() == 0, (
        "bounded runs did not converge — the table still holds credential material"
    )
    assert runs <= 5, f"took {runs} runs for 10 rows at 3 per run"


def test_a_bounded_run_without_resume_rescans_the_same_prefix(client: TestClient) -> None:
    """Document the operational contract `--max-rows` actually has.

    Without `--start-after-id` a bounded run deliberately starts from the
    beginning. That is fine and idempotent, but it is *not* progress — which is
    why the resume token exists and why the script's docstring says to pair the
    two.
    """
    seed_snapshot_rows(10, unsafe=10)

    first = run_sanitizer(apply_changes=True, batch_size=2, max_rows=3)
    assert first.sanitized == 3
    assert unsafe_row_count() == 7

    # Same invocation again, no cursor: re-examines the cleaned prefix only.
    second = run_sanitizer(apply_changes=True, batch_size=2, max_rows=3)
    assert second.scanned == 3
    assert second.candidates == 0, "expected the already-clean prefix"
    assert unsafe_row_count() == 7, "an unresumed run must not be mistaken for progress"
