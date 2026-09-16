"""NEW-07 — credential material must not reach AI payloads or snapshots.

The defect, as measured on this branch
--------------------------------------
`profile_payload` built its profile section with `public_dict`, which copies
every `UserProfile` column and subtracts only `hashed_password`. When
`workday_password_ciphertext` (the encrypted employer-portal password) was
added, it silently joined every AI prompt and every
`GeneratedDocument.source_profile_snapshot`. Reproduced against this exact
source before the fix: the ciphertext left for OpenAI on **six** requests
across four routes — `generate-resume`, `generate-cover-letter`,
`documents/{doc_type}`, and twice per `POST /application-sessions` — and was
persisted in the document snapshot. No plaintext and no encryption key were
exposed, then or now.

What these tests hold in place
------------------------------
1. The projection is an **allow-list**, so a newly added `UserProfile` column
   is inert until somebody lists it. `test_a_new_profile_column_is_fail_closed`
   fails when a column belongs to neither the allow-list nor the reviewed
   exclusion set, forcing the decision instead of defaulting to exposure.
2. Canary assertions at the **real provider boundary** — interception is the
   OpenAI client itself, after prompt assembly and after `json.dumps`, so a
   renamed or re-nested key cannot slip past by changing shape.
3. Snapshot writes stay clean while keeping the provenance they exist for.
4. The historical cleanup tool runs against **this** schema. The first version
   imported the ORM model and could not run against production at all, because
   the security branch's model declares columns production does not have;
   `test_cleanup_tool_works_without_content_hash` pins the fix.
5. The Workday credential still works where it is genuinely needed.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
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
        # A real ATS URL: session creation rejects anything it cannot classify.
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
    """No canary value and no credential key name in any outgoing request.

    The whole request kwargs are scanned, not just `messages`, so a payload that
    migrates to another field is still caught.
    """
    assert len(calls) >= expected_min, (
        f"expected at least {expected_min} provider call(s), saw {len(calls)}"
    )
    for index, call in enumerate(calls, 1):
        blob = json.dumps(call, default=str)
        assert ciphertext not in blob, f"call {index}: ciphertext transmitted"
        assert PLAINTEXT_CANARY not in blob, f"call {index}: PLAINTEXT transmitted"
        assert KEY_CANARY not in blob, f"call {index}: encryption key transmitted"
        for name in CREDENTIAL_KEY_NAMES:
            assert f'"{name}"' not in blob, f"call {index}: credential key {name!r} present"
    # Non-vacuity: legitimate content did travel.
    assert any("Owner A" in json.dumps(call, default=str) for call in calls), (
        "no legitimate profile content in any call — the assertions would be vacuous"
    )


# --------------------------------------------------------------------------- #
# 1. The projection itself
# --------------------------------------------------------------------------- #
def test_the_projection_is_an_allow_list_not_a_deny_list() -> None:
    columns = {c.name for c in E.UserProfile.__table__.columns}
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
    unclassified = columns - (AI_PROFILE_FIELDS | set(AI_PROFILE_EXCLUDED_FIELDS))
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


def test_scrub_ignores_a_forbidden_name_appearing_as_a_value() -> None:
    """Keys are matched, values are not — a note mentioning the field is data."""
    payload = {"note": CREDENTIAL_COLUMN, "other": "api_key"}
    cleaned, removed = scrub_credential_keys(payload)
    assert removed == 0
    assert cleaned == payload
    assert find_credential_key_paths(payload) == []


def test_find_credential_key_paths_reports_paths_not_values() -> None:
    payload = {"profile": {CREDENTIAL_COLUMN: "secret"}, "rows": [{"api_key": "secret2"}]}
    paths = find_credential_key_paths(payload)
    assert f"profile.{CREDENTIAL_COLUMN}" in paths
    assert "rows[0].api_key" in paths
    assert all("secret" not in path for path in paths)


# --------------------------------------------------------------------------- #
# 2. The external provider boundary — every route that leaked on this branch
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


def test_documents_doc_type_sends_no_credential_material(
    client: TestClient, provider_calls
) -> None:
    headers = signup(client, "doccover@mailbox.test-domain.co")
    complete_profile(client, headers, "Owner A")
    ciphertext = store_credential(client, headers)
    job_id = seed_job("Acme", "n7-doccover")

    resp = client.post(f"/jobs/{job_id}/documents/cover_letter", headers=headers, json={})
    # This route answers 500 on this branch for an unrelated, pre-existing reason:
    # it returns a raw `GeneratedDocument` under a declared `dict` contract, which
    # pydantic cannot encode (tracked separately as NEW-06 and fixed on the
    # security branch, not here — this hotfix is deliberately NEW-07 only).
    #
    # The 500 does not make the route harmless: the provider call happens first,
    # and before this fix it carried the ciphertext. So the assertion is on the
    # AI boundary, not on the response status.
    assert resp.status_code in (200, 500), resp.text
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
    # Measured at three before the fix, two of them carrying the ciphertext.
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
    asyncio.run(ai_provider.json_task("cover_letter.md", payload, smart=True))

    assert provider_calls, "the guard must not prevent the call from happening"
    blob = json.dumps(provider_calls[0], default=str)
    assert "injected-secret" not in blob
    assert "another-secret" not in blob
    assert CREDENTIAL_COLUMN not in blob
    assert "Owner A" in blob  # legitimate content still travels


def test_a_provider_failure_does_not_log_the_payload(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    """Error paths must not dump the prompt or the credential."""
    import asyncio

    from app.ai import provider as prov
    from app.core.config import settings

    class Boom:
        class chat:  # noqa: N801 - mirrors the client's attribute shape
            class completions:
                @staticmethod
                async def create(**kwargs):
                    raise RuntimeError("provider exploded")

    monkeypatch.setattr(prov.ai_provider, "client", Boom())
    monkeypatch.setattr(settings, "openai_model_smart", "fake-smart")
    monkeypatch.setattr(settings, "openai_model_fast", "fake-fast")

    with caplog.at_level("DEBUG"):
        asyncio.run(prov.ai_provider.json_task(
            "cover_letter.md",
            {"profile": {"full_name": "Owner A", CREDENTIAL_COLUMN: "log-canary-secret"}},
            smart=True,
        ))
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "log-canary-secret" not in logged
    assert CREDENTIAL_COLUMN not in logged


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
    assert KEY_CANARY not in blob
    assert CREDENTIAL_COLUMN not in blob
    assert not find_credential_key_paths(snapshot)

    # Sanitization must not hollow out provenance.
    assert snapshot["profile"]["full_name"] == "Owner A"
    assert snapshot["profile"]["skills"], "snapshot lost the skills it explains the resume with"
    assert snapshot["experience"], "snapshot lost the experience it was generated from"


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


def test_this_branch_has_no_document_copy_path() -> None:
    """Why there is no legacy-copy sanitization test on this branch.

    The security branch added `copy_document_for_edit`, which needed scrubbing so
    an edit of a pre-fix document could not mint a new row carrying the
    credential. This branch has no such function and no frozen-document
    versioning, so there is no copy path to sanitize. If one is introduced, this
    test fails and the scrub must come with it.
    """
    from app.documents import store

    assert not hasattr(store, "copy_document_for_edit"), (
        "a document copy path now exists — it must scrub the snapshot as it "
        "copies, or a pre-fix row can seed a new one"
    )


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
    assert "workday_password_configured" in body
    assert CREDENTIAL_COLUMN not in resp.text


# --------------------------------------------------------------------------- #
# 5. Historical cleanup tooling — SQLite behaviour
# --------------------------------------------------------------------------- #
def load_cleanup_module():
    import importlib.util
    from pathlib import Path

    root = Path(__file__).resolve().parents[4]
    path = root / "scripts" / "sanitize_profile_snapshots.py"
    spec = importlib.util.spec_from_file_location("sanitize_profile_snapshots", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seed_snapshot_rows(count: int, *, unsafe: int, malformed: int = 0, null: int = 0) -> None:
    db = db_session()
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
            application_url="https://boards.greenhouse.io/hist/1",
            source_url="https://boards.greenhouse.io/hist/1", description_raw="",
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
            elif index < unsafe + malformed + null:
                snapshot = None
            else:
                snapshot = {"profile": {"full_name": f"User {index}"}}
            db.add(E.GeneratedDocument(
                user_id=user.id, job_id=job.id, type=E.DocumentType.resume,
                format=E.DocumentFormat.json, title=f"doc {index}", content={},
                source_profile_snapshot=snapshot,
            ))
        db.commit()
    finally:
        db.close()


def run_cleanup(**kwargs):
    module = load_cleanup_module()
    report = module.Report()
    db = db_session()
    try:
        connection = db.connection()
        module.sanitize_target(
            connection, module.GENERATED_DOCUMENTS, "source_profile_snapshot",
            report=report, **kwargs,
        )
        return report
    finally:
        db.close()


def unsafe_row_count() -> int:
    db = db_session()
    try:
        return sum(
            1 for row in db.scalars(select(E.GeneratedDocument))
            if isinstance(row.source_profile_snapshot, dict)
            and find_credential_key_paths(row.source_profile_snapshot)
        )
    finally:
        db.close()


def test_cleanup_dry_run_reports_candidates_and_changes_nothing(client: TestClient) -> None:
    seed_snapshot_rows(6, unsafe=4)
    assert unsafe_row_count() == 4

    report = run_cleanup(apply_changes=False, batch_size=10, max_rows=None)
    assert report.scanned == 6
    assert report.candidates == 4
    assert report.sanitized == 0, "dry run modified rows"
    assert unsafe_row_count() == 4, "dry run modified rows"

    rendered = report.render(applied=False)
    assert "DRY-RUN" in rendered
    assert "old-secret" not in rendered, "the report leaked a stored value"
    assert f"profile.{CREDENTIAL_COLUMN}" in rendered


def test_cleanup_skips_malformed_and_null_snapshots_without_destroying_them(
    client: TestClient,
) -> None:
    seed_snapshot_rows(7, unsafe=3, malformed=2, null=1)
    report = run_cleanup(apply_changes=True, batch_size=10, max_rows=None)
    assert report.skipped_malformed == 2
    assert report.skipped_null == 1
    assert report.sanitized == 3

    db = db_session()
    try:
        snapshots = [r.source_profile_snapshot for r in db.scalars(select(E.GeneratedDocument))]
        assert snapshots.count(None) == 1, "a null snapshot was altered"
        assert [s for s in snapshots if s == ["not", "an", "object"]].__len__() == 2, (
            "a malformed snapshot was altered or wiped"
        )
    finally:
        db.close()


def test_cleanup_honours_max_rows_and_resumes(client: TestClient) -> None:
    """Chained bounded invocations must finish the table.

    A bounded run paged from the start would rescan the already-clean prefix,
    report "0 candidates", and never reach the rest — a false completion signal.
    Keyset paging with `last_id` as the resume token is what prevents that.
    """
    seed_snapshot_rows(10, unsafe=10)

    cursor = None
    runs = 0
    while runs < 10:
        report = run_cleanup(apply_changes=True, batch_size=2, max_rows=3,
                             start_after_id=cursor)
        runs += 1
        if report.scanned == 0:
            break
        assert report.scanned <= 3, f"bound exceeded: scanned {report.scanned}"
        assert cursor is None or report.last_id > cursor, "cursor did not advance"
        cursor = report.last_id

    assert unsafe_row_count() == 0, "bounded runs did not converge"
    assert runs <= 5, f"took {runs} runs for 10 rows at 3 per run"


def test_cleanup_is_idempotent(client: TestClient) -> None:
    seed_snapshot_rows(5, unsafe=3)
    first = run_cleanup(apply_changes=True, batch_size=10, max_rows=None)
    assert first.sanitized == 3

    second = run_cleanup(apply_changes=True, batch_size=10, max_rows=None)
    assert second.candidates == 0, "a second run found work to do"
    assert unsafe_row_count() == 0


def test_cleanup_preserves_safe_data(client: TestClient) -> None:
    seed_snapshot_rows(4, unsafe=4)
    run_cleanup(apply_changes=True, batch_size=10, max_rows=None)

    db = db_session()
    try:
        for row in db.scalars(select(E.GeneratedDocument)):
            snapshot = row.source_profile_snapshot
            blob = json.dumps(snapshot, default=str)
            assert "old-secret" not in blob
            assert CREDENTIAL_COLUMN not in blob
            assert snapshot["profile"]["full_name"].startswith("User")
            assert snapshot["experience"] == [{"company": "Acme"}], "unrelated data altered"
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# 6. Historical cleanup tooling — real PostgreSQL, production table shape
# --------------------------------------------------------------------------- #
def _reachable(url: str) -> bool:
    engine = None
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 3})
        with engine.connect():
            return True
    except Exception:
        return False
    finally:
        if engine is not None:
            engine.dispose()


def _discover_admin_url() -> str | None:
    pinned = os.environ.get("MIGRATION_TEST_DATABASE_URL")
    if pinned:
        return pinned if _reachable(pinned) else None
    user = os.environ.get("USER") or "postgres"
    candidates = [
        "postgresql+psycopg://jobpilot:jobpilot_dev_password@localhost:5432/postgres",
        f"postgresql+psycopg://{user}@localhost:5432/postgres",
        "postgresql+psycopg://postgres@localhost:5432/postgres",
    ]
    return next((url for url in candidates if _reachable(url)), None)


_ADMIN_URL = _discover_admin_url()

requires_postgres = pytest.mark.skipif(
    _ADMIN_URL is None,
    reason=(
        "No reachable PostgreSQL server. Start one (docker compose up postgres) or set "
        "MIGRATION_TEST_DATABASE_URL to run the production-shape cleanup tests."
    ),
)

#: The production table, exactly: no `content_hash`, no `immutable_at`, no
#: `source_document_id`. Those arrive with migrations 0032/0033, which production
#: has not applied — which is why an ORM-coupled cleanup tool could not run there.
PRODUCTION_SHAPE_DDL = """
CREATE TABLE generated_documents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    type VARCHAR(40) NOT NULL,
    format VARCHAR(40) NOT NULL,
    title VARCHAR(300),
    content JSONB DEFAULT '{}'::jsonb,
    content_markdown TEXT,
    plain_text TEXT,
    quality JSONB DEFAULT '{}'::jsonb,
    source_profile_snapshot JSONB DEFAULT '{}'::jsonb,
    job_snapshot JSONB DEFAULT '{}'::jsonb,
    format_version VARCHAR(20) DEFAULT 'v1',
    file_path VARCHAR(1000),
    docx_file_path VARCHAR(1000),
    pdf_file_path VARCHAR(1000),
    model_used VARCHAR(120),
    prompt_version VARCHAR(50) DEFAULT 'v1',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
)
"""

UNSAFE_SNAPSHOT = json.dumps({
    "profile": {"full_name": "Prod User", "skills": ["Python"],
                CREDENTIAL_COLUMN: "PRODSHAPE-SECRET"},
    "experience": [{"company": "Acme"}],
})


@pytest.fixture()
def production_shape_database() -> Generator[str, None, None]:
    """A throwaway database whose generated_documents matches production."""
    name = f"jobpilot_n7test_{uuid.uuid4().hex[:12]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin.dispose()
    url = str(create_engine(_ADMIN_URL).url.set(database=name))
    try:
        yield url
    finally:
        admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = :name AND pid <> pg_backend_pid()"), {"name": name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


def _seed_production_shape(url: str, rows: int) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text(PRODUCTION_SHAPE_DDL))
        for _ in range(rows):
            conn.execute(text(
                "INSERT INTO generated_documents "
                "(user_id, job_id, type, format, title, source_profile_snapshot) "
                "VALUES (1, 1, 'resume', 'json', 'doc', CAST(:s AS jsonb))"),
                {"s": UNSAFE_SNAPSHOT})
    engine.dispose()


@requires_postgres
def test_cleanup_tool_works_without_content_hash(production_shape_database: str) -> None:
    """The mandatory schema-compatibility regression.

    The ORM-coupled predecessor failed here with
    `column generated_documents.content_hash does not exist` before reading a
    row. This tool declares only `id` and `source_profile_snapshot`, so it runs
    against the production table as it actually is.
    """
    url = production_shape_database
    _seed_production_shape(url, 8)
    module = load_cleanup_module()

    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            columns = conn.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'generated_documents'")).scalars().all()
            assert "content_hash" not in columns, "fixture is not in production shape"

            dry = module.Report()
            module.sanitize_target(conn, module.GENERATED_DOCUMENTS,
                                   "source_profile_snapshot", apply_changes=False,
                                   batch_size=3, max_rows=None, report=dry)
            assert dry.scanned == 8
            assert dry.candidates == 8
            assert dry.sanitized == 0
            assert dry.last_id == 8

            applied = module.Report()
            module.sanitize_target(conn, module.GENERATED_DOCUMENTS,
                                   "source_profile_snapshot", apply_changes=True,
                                   batch_size=3, max_rows=None, report=applied)
            assert applied.candidates == 8
            assert applied.sanitized == 8

        with engine.connect() as conn:
            remaining = conn.execute(text(
                "SELECT count(*) FROM generated_documents "
                "WHERE jsonb_path_exists(source_profile_snapshot, "
                "CAST('$.**.\"" + CREDENTIAL_COLUMN + "\"' AS jsonpath))")).scalar()
            assert remaining == 0, "candidates remain after apply"
            kept = conn.execute(text(
                "SELECT count(*) FROM generated_documents "
                "WHERE source_profile_snapshot -> 'profile' ->> 'full_name' = 'Prod User'"
            )).scalar()
            assert kept == 8, "safe snapshot data was lost"
            secret = conn.execute(text(
                "SELECT count(*) FROM generated_documents "
                "WHERE source_profile_snapshot::text LIKE '%PRODSHAPE-SECRET%'")).scalar()
            assert secret == 0
    finally:
        engine.dispose()


@requires_postgres
def test_an_orm_coupled_query_would_fail_on_production_shape(
    production_shape_database: str,
) -> None:
    """The negative control for the compatibility fix.

    Selecting the full ORM column list — what the predecessor did — must fail
    against the production table. If this ever stops failing, production has
    gained the columns and the compatibility concern has changed.
    """
    url = production_shape_database
    _seed_production_shape(url, 2)
    engine = create_engine(url)
    try:
        with engine.connect() as conn, pytest.raises(Exception) as excinfo:
            conn.execute(text("SELECT id, content_hash FROM generated_documents"))
        assert "content_hash" in str(excinfo.value)
    finally:
        engine.dispose()


def _candidate_count(connection) -> int:
    return connection.execute(text(
        "SELECT count(*) FROM generated_documents "
        "WHERE jsonb_path_exists(source_profile_snapshot, "
        "CAST('$.**.\"" + CREDENTIAL_COLUMN + "\"' AS jsonpath))"
    )).scalar_one()


def _install_failure_trigger(connection, failing_ids: list[int]) -> None:
    ids = ", ".join(str(value) for value in failing_ids)
    connection.execute(text(
        "CREATE FUNCTION new07_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$ "
        f"BEGIN IF NEW.id IN ({ids}) THEN RAISE EXCEPTION 'forced update failure'; "
        "END IF; RETURN NEW; END $$"
    ))
    connection.execute(text(
        "CREATE TRIGGER new07_fail_update BEFORE UPDATE ON generated_documents "
        "FOR EACH ROW EXECUTE FUNCTION new07_fail_update()"
    ))
    connection.commit()


@requires_postgres
@pytest.mark.parametrize("failure_id", [1, 2, 3, 4])
def test_failed_batch_counts_only_committed_effects_at_every_update_position(
    production_shape_database: str, failure_id: int,
) -> None:
    """Before-first through after-last-update failures contribute zero.

    The trigger fires before the selected update. ``failure_id == 4`` therefore
    proves that three successful executions followed by a final failure still
    report no committed mutations for the rolled-back four-row batch.
    """
    url = production_shape_database
    _seed_production_shape(url, 4)
    module = load_cleanup_module()
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            _install_failure_trigger(conn, [failure_id])
            report = module.Report()
            module.sanitize_target(
                conn, module.GENERATED_DOCUMENTS, "source_profile_snapshot",
                apply_changes=True, batch_size=4, max_rows=None, report=report,
            )
            assert report.scanned == report.candidates == 4
            assert report.sanitized == report.keys_removed == 0
            assert report.failed_batches == 1
            assert report.sanitized >= 0 and report.keys_removed >= 0
            assert _candidate_count(conn) == 4
    finally:
        engine.dispose()


@requires_postgres
def test_successful_batches_surround_a_failed_batch_and_reconcile(
    production_shape_database: str,
) -> None:
    url = production_shape_database
    _seed_production_shape(url, 6)
    module = load_cleanup_module()
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            _install_failure_trigger(conn, [3])
            report = module.Report()
            module.sanitize_target(
                conn, module.GENERATED_DOCUMENTS, "source_profile_snapshot",
                apply_changes=True, batch_size=2, max_rows=None, report=report,
            )
            assert report.scanned == report.candidates == 6
            assert report.sanitized == report.keys_removed == 4
            assert report.failed_batches == 1
            assert _candidate_count(conn) == 2
            assert 6 - report.sanitized == _candidate_count(conn)
            assert report.last_id == 6  # failed rows remain for a later rerun
    finally:
        engine.dispose()


@requires_postgres
def test_multiple_failed_batches_preserve_successful_totals(
    production_shape_database: str,
) -> None:
    url = production_shape_database
    _seed_production_shape(url, 6)
    module = load_cleanup_module()
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            _install_failure_trigger(conn, [1, 3])
            report = module.Report()
            module.sanitize_target(
                conn, module.GENERATED_DOCUMENTS, "source_profile_snapshot",
                apply_changes=True, batch_size=2, max_rows=None, report=report,
            )
            assert report.sanitized == report.keys_removed == 2
            assert report.failed_batches == 2
            assert _candidate_count(conn) == 4
            assert 6 - report.sanitized == _candidate_count(conn)
    finally:
        engine.dispose()


class _CommitFailOnce:
    """Connection proxy that fails the first commit after updates execute."""

    def __init__(self, connection) -> None:
        self.connection = connection
        self.failed = False

    def execute(self, *args, **kwargs):
        return self.connection.execute(*args, **kwargs)

    def commit(self) -> None:
        if not self.failed:
            self.failed = True
            raise RuntimeError("forced commit failure")
        self.connection.commit()

    def rollback(self) -> None:
        self.connection.rollback()


@requires_postgres
def test_commit_failure_rolls_back_without_committed_accounting(
    production_shape_database: str,
) -> None:
    url = production_shape_database
    _seed_production_shape(url, 4)
    module = load_cleanup_module()
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            report = module.Report()
            module.sanitize_target(
                _CommitFailOnce(conn), module.GENERATED_DOCUMENTS,
                "source_profile_snapshot", apply_changes=True, batch_size=4,
                max_rows=None, report=report,
            )
            assert report.sanitized == report.keys_removed == 0
            assert report.failed_batches == 1
            assert _candidate_count(conn) == 4
    finally:
        engine.dispose()


@requires_postgres
def test_multi_key_commits_count_keys_and_failed_multi_key_counts_nothing(
    production_shape_database: str,
) -> None:
    url = production_shape_database
    _seed_production_shape(url, 1)
    module = load_cleanup_module()
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            conn.execute(text(
                "UPDATE generated_documents SET source_profile_snapshot = "
                "CAST(:snapshot AS jsonb) WHERE id = 1"
            ), {"snapshot": json.dumps({
                "profile": {CREDENTIAL_COLUMN: "cipher-canary", "api_key": "key-canary"},
                "safe": "retained",
            })})
            conn.commit()
            failed = module.Report()
            module.sanitize_target(
                _CommitFailOnce(conn), module.GENERATED_DOCUMENTS,
                "source_profile_snapshot", apply_changes=True, batch_size=1,
                max_rows=None, report=failed,
            )
            assert failed.sanitized == failed.keys_removed == 0
            assert failed.failed_batches == 1 and _candidate_count(conn) == 1

            applied = module.Report()
            module.sanitize_target(
                conn, module.GENERATED_DOCUMENTS, "source_profile_snapshot",
                apply_changes=True, batch_size=1, max_rows=None, report=applied,
            )
            assert applied.sanitized == 1
            assert applied.keys_removed == 2
            assert _candidate_count(conn) == 0
    finally:
        engine.dispose()


def test_dry_run_separates_proposed_keys_from_committed_counts(client: TestClient) -> None:
    seed_snapshot_rows(3, unsafe=3)
    report = run_cleanup(apply_changes=False, batch_size=2, max_rows=None)
    assert report.sanitized == 0
    assert report.keys_removed == 0
    assert report.keys_would_remove == 3
    assert unsafe_row_count() == 3


def test_main_returns_failure_when_any_batch_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_cleanup_module()
    monkeypatch.setattr(module, "TARGETS", [("test", module.GENERATED_DOCUMENTS, "x")])

    def fake_sanitize(*args, report, **kwargs):
        report.failed_batches += 1

    monkeypatch.setattr(module, "sanitize_target", fake_sanitize)
    assert module.main(["--database-url", "sqlite://"]) == 1
