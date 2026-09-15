"""B-01 — systematic two-user authorization (IDOR / BOLA) over the real HTTP API.

The release gate this closes
----------------------------
Ownership filters existed and several cross-user assertions were scattered
across the suite, but nothing exercised the private object graph as a MATRIX.
Static filters are not evidence: the question is whether an authenticated
stranger who already holds a valid identifier can read, list, mutate, delete,
download, confirm or otherwise operate on someone else's resource.

Method
------
Two real users are created through `POST /auth/signup` and every attack request
carries User B's genuine Bearer token. No mocked authentication, no monkeypatched
current_user, no direct `user_id` substitution — the attack always crosses the
same HTTP boundary a real client would, including the PyJWT stack that Stage
2G-C put in place.

User A builds a complete private graph through ordinary API calls: profile,
session, generated resume and cover letter, tracker, snapshot, answer overrides.
B then attacks it with A's exact valid identifiers.

Reading a status code is not enough. Every rejected mutation is followed by a
re-read AS A, so "403 but it changed anyway" cannot pass.

Scope note: `/jobs/{job_id}` and the company logo route are deliberately absent
from the private matrix. A JobPosting is shared catalogue data both users can
legitimately see; what must stay isolated is the per-user state hanging off it,
which is exactly what `test_shared_job_does_not_leak_private_state` covers.
"""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.main import app
from app.models import entities as E
from app.tests.b01_coverage import (
    CALLER_SCOPED,
    CROSS_USER,
    LEDGER,
    RECORDER,
    SHARED_EFFECT,
    SHARED_PUBLIC_OPERATIONS,
    activate,
    deactivate,
    id_bearing_operations,
    openapi_operations,
    private_operations,
)

REFUSED = {403, 404}
"""The repository uses both: 404 conceals existence, 403 states authorization.
Either is a pass. 2xx on a B->A private operation is the failure.

422 is deliberately NOT in this set. A schema rejection proves the body was
malformed, not that ownership was enforced, and counting it would let a typo
masquerade as an access control. Where a route validates before authorizing,
the test sends a schema-valid body so the request reaches the ownership check.
"""


# --------------------------------------------------------------------------- #
# Disposable environment
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    """In-memory SQLite, created and dropped per test.

    Proving this is disposable is part of the gate: a cross-user matrix that
    mutates state must never be pointed at a shared or production database.
    """
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
    activate(RECORDER)
    try:
        yield TestClient(app)
    finally:
        deactivate()
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture(autouse=True)
def _name_current_test(request: pytest.FixtureRequest) -> Generator[None, None, None]:
    """Tag recorded requests with the case that issued them.

    Ownership ids restart at 1 in every test's fresh database, so the registry
    is cleared alongside it — a stale (kind, id) entry would otherwise attribute
    one test's resource to another test's user.
    """
    RECORDER.ownership.clear()
    RECORDER.current_test = request.node.name
    yield
    RECORDER.current_test = ""


def db_session() -> Session:
    return next(app.dependency_overrides[get_db]())


# --------------------------------------------------------------------------- #
# Real users, real tokens
# --------------------------------------------------------------------------- #
def signup(client: TestClient, email: str) -> dict[str, str]:
    resp = client.post("/auth/signup", json={"email": email, "password": "password123"})
    assert resp.status_code in (200, 201), resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def whoami(client: TestClient, headers: dict[str, str]) -> dict:
    resp = client.get("/auth/me", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


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


def seed_job(company: str = "Acme", external: str = "be-1") -> int:
    from datetime import UTC, datetime, timedelta

    db = db_session()
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
    job_id = job.id
    db.close()
    return job_id


class Graph:
    """One user's complete private object graph, built through the real API."""

    def __init__(self, client: TestClient, email: str, name: str, company: str, external: str):
        self.headers = signup(client, email)
        self.user_id = whoami(client, self.headers)["id"]
        complete_profile(client, self.headers, name)
        self.job_id = seed_job(company, external)

        session = client.post("/application-sessions", headers=self.headers,
                              json={"job_id": self.job_id})
        assert session.status_code in (200, 201), session.text
        body = session.json()
        self.session_id = body["session_id"]
        self.resume_document_id = body["resume"]["document_id"]
        self.cover_letter_document_id = body["cover_letter"]["document_id"]

        for artifact in ("resume", "cover_letter"):
            client.post(f"/application-sessions/{self.session_id}/artifact-use",
                        headers=self.headers,
                        json={"artifact": artifact, "mode": "uploaded", "text": None})

        confirmed = client.post(
            f"/application-sessions/{self.session_id}/submission-confirmed",
            headers=self.headers,
            json={"evidence_type": "success_page", "resume_used": True,
                  "cover_letter_mode": "file"},
        )
        assert confirmed.status_code == 200, confirmed.text

        db = db_session()
        try:
            tracker = db.scalar(
                select(E.ApplicationTracker).where(
                    E.ApplicationTracker.user_id == self.user_id,
                    E.ApplicationTracker.job_id == self.job_id,
                )
            )
            assert tracker is not None, "confirmation did not create a tracker"
            self.tracker_id = tracker.id
            snapshot = db.scalar(
                select(E.ApplicationSnapshot).where(
                    E.ApplicationSnapshot.application_tracker_id == self.tracker_id
                )
            )
            assert snapshot is not None, "confirmation did not create a snapshot"
            self.snapshot_id = snapshot.id
        finally:
            db.close()

        self.register_ownership()

    def register_ownership(self) -> None:
        """Publish this graph's ids to the coverage recorder, by resource kind.

        Kind matters. A's ``cover_letter_document_id`` and B's ``session_id``
        are both ``2`` in this fixture, so an untyped registry would score
        `GET /application-sessions/2` by B as an attack on A.
        """
        own = RECORDER.ownership
        own.register("session", self.session_id, self.user_id)
        own.register("tracker", self.tracker_id, self.user_id)
        own.register("snapshot", self.snapshot_id, self.user_id)
        own.register("document", self.resume_document_id, self.user_id)
        own.register("document", self.cover_letter_document_id, self.user_id)


@pytest.fixture()
def graphs(client: TestClient) -> tuple[Graph, Graph]:
    """A owns the resources under attack; B is a real, fully-provisioned stranger."""
    a = Graph(client, "owner-a@mailbox.test-domain.co", "Owner A", "Acme", "be-a")
    b = Graph(client, "stranger-b@mailbox.test-domain.co", "Stranger B", "Globex", "be-b")
    return a, b


# --------------------------------------------------------------------------- #
# 0. The test is measuring what it thinks it is
# --------------------------------------------------------------------------- #
def test_the_two_identities_are_distinct_and_real(client: TestClient, graphs) -> None:
    a, b = graphs
    assert a.user_id != b.user_id
    assert whoami(client, a.headers)["email"] != whoami(client, b.headers)["email"]
    # Distinct private graphs, so a later "B cannot see A" is not vacuous.
    assert a.session_id != b.session_id
    assert a.tracker_id != b.tracker_id
    assert a.snapshot_id != b.snapshot_id
    assert a.resume_document_id != b.resume_document_id


def test_unauthenticated_and_authenticated_rejections_are_distinguishable(
    client: TestClient, graphs
) -> None:
    """Auth failure is not authorization protection, and must not be mistaken for it."""
    a, b = graphs
    path = f"/application-sessions/{a.session_id}"

    # No credential at all is 401. A malformed bearer credential is refused by
    # the security dependency as 403 — both are rejections; neither reaches the
    # ownership check, which is the only point being made here.
    assert client.get(path).status_code == 401
    assert client.get(path, headers={"Authorization": "Bearer not-a-jwt"}).status_code in (401, 403)
    # B is genuinely authenticated — it can reach its own resources...
    assert client.get(f"/application-sessions/{b.session_id}", headers=b.headers).status_code == 200
    # ...and is refused A's on ownership grounds, not on authentication grounds.
    assert client.get(path, headers=b.headers).status_code in REFUSED


def test_the_same_request_succeeds_for_the_owner_and_fails_for_the_stranger(
    client: TestClient, graphs
) -> None:
    """Token swap: identical method, path and body; only the identity differs."""
    a, b = graphs
    for path in (
        f"/application-sessions/{a.session_id}",
        f"/application-sessions/{a.session_id}/answers",
        f"/jobs/tracker/{a.tracker_id}/snapshots",
        f"/jobs/tracker/{a.tracker_id}/snapshots/{a.snapshot_id}",
        f"/jobs/documents/{a.resume_document_id}/download/pdf",
    ):
        assert client.get(path, headers=a.headers).status_code == 200, f"owner blocked on {path}"
        assert client.get(path, headers=b.headers).status_code in REFUSED, f"LEAK at {path}"


# --------------------------------------------------------------------------- #
# 1. Read isolation — every private GET
# --------------------------------------------------------------------------- #
def cover(
    method: str,
    template: str,
    *,
    kind: str = CROSS_USER,
    case: str,
    owner_control: bool = False,
    isolation_asserted: bool = False,
    side_effect_checked: bool = False,
) -> None:
    """Claim coverage for one operation.

    The claim is not the evidence. `test_every_private_operation_is_dynamically
    _covered` re-checks each one against the requests the recorder actually saw
    and fails the claim if no such request exists.
    """
    LEDGER.declare(
        (method.upper(), template),
        kind=kind,
        case=case,
        owner_control=owner_control,
        foreign_attack=kind == CROSS_USER,
        isolation_asserted=isolation_asserted,
        side_effect_checked=side_effect_checked,
    )


def read_matrix(a: Graph) -> list[tuple[str, str]]:
    return [
        ("session detail", f"/application-sessions/{a.session_id}"),
        ("session answers", f"/application-sessions/{a.session_id}/answers"),
        ("session answer overrides", f"/application-sessions/{a.session_id}/answers/override"),
        ("session resume", f"/application-sessions/{a.session_id}/resume"),
        ("session cover letter", f"/application-sessions/{a.session_id}/cover-letter"),
        ("tracker snapshots list", f"/jobs/tracker/{a.tracker_id}/snapshots"),
        ("snapshot detail", f"/jobs/tracker/{a.tracker_id}/snapshots/{a.snapshot_id}"),
        ("resume download", f"/jobs/documents/{a.resume_document_id}/download/pdf"),
        ("cover letter download", f"/jobs/documents/{a.cover_letter_document_id}/download/pdf"),
        ("resume download docx", f"/jobs/documents/{a.resume_document_id}/download/docx"),
    ]


READ_OPERATIONS = [
    ("GET", "/application-sessions/{session_id}"),
    ("GET", "/application-sessions/{session_id}/answers"),
    ("GET", "/application-sessions/{session_id}/answers/override"),
    ("GET", "/application-sessions/{session_id}/resume"),
    ("GET", "/application-sessions/{session_id}/cover-letter"),
    ("GET", "/jobs/tracker/{tracker_id}/snapshots"),
    ("GET", "/jobs/tracker/{tracker_id}/snapshots/{snapshot_id}"),
    ("GET", "/jobs/documents/{document_id}/download/{fmt}"),
]


def test_b_cannot_read_any_private_resource_of_a(client: TestClient, graphs) -> None:
    a, b = graphs
    failures = []
    for label, path in read_matrix(a):
        resp = client.get(path, headers=b.headers)
        if resp.status_code not in REFUSED:
            failures.append(f"{label} [{path}] -> {resp.status_code}")
    assert not failures, "unauthorized reads succeeded:\n  " + "\n  ".join(failures)
    for method, template in READ_OPERATIONS:
        cover(method, template, case="b_cannot_read_any_private_resource_of_a")


def test_the_owner_can_read_everything_the_stranger_could_not(client: TestClient, graphs) -> None:
    """Without this the read matrix could pass because the routes are simply broken."""
    a, _ = graphs
    for label, path in read_matrix(a):
        assert client.get(path, headers=a.headers).status_code == 200, f"owner blocked on {label}"
    for method, template in READ_OPERATIONS:
        cover(method, template, case="owner_can_read_everything", owner_control=True)


def test_rejected_reads_leak_no_private_content(client: TestClient, graphs) -> None:
    a, b = graphs
    owner = whoami(client, a.headers)
    forbidden = [owner["email"], "Owner A", "Acme", "Backend Engineer"]
    for label, path in read_matrix(a):
        body = client.get(path, headers=b.headers).text
        for secret in forbidden:
            assert secret not in body, f"{label} leaked {secret!r}"


# --------------------------------------------------------------------------- #
# 2. Collection isolation
# --------------------------------------------------------------------------- #
def test_private_collections_contain_only_the_callers_own_rows(client: TestClient, graphs) -> None:
    a, b = graphs
    listing = client.get("/jobs/tracker/submitted", headers=b.headers)
    assert listing.status_code == 200, listing.text
    ids = {row["id"] for row in listing.json()["applications"]}
    assert a.tracker_id not in ids
    assert b.tracker_id in ids


def test_a_shared_job_does_not_leak_the_other_users_private_state(
    client: TestClient, graphs
) -> None:
    """Both users may legitimately see the same JobPosting. What must not travel
    with it is the per-user tracker, snapshot or document hanging off it."""
    a, b = graphs
    shared_job = a.job_id

    job = client.get(f"/jobs/{shared_job}", headers=b.headers)
    if job.status_code == 200:
        payload = job.text
        assert str(a.tracker_id) not in payload or "tracker" not in payload.lower()
        assert "Owner A" not in payload

    # Knowing the job is not a route to A's tracker.
    assert client.get(f"/jobs/tracker/{a.tracker_id}/snapshots",
                      headers=b.headers).status_code in REFUSED


# --------------------------------------------------------------------------- #
# 3. Nested parent/child substitution
# --------------------------------------------------------------------------- #
def test_parent_child_substitution_never_discloses(client: TestClient, graphs) -> None:
    a, b = graphs
    cases = [
        ("B parent + A child", f"/jobs/tracker/{b.tracker_id}/snapshots/{a.snapshot_id}"),
        ("A parent + B child", f"/jobs/tracker/{a.tracker_id}/snapshots/{b.snapshot_id}"),
        ("A parent + A child", f"/jobs/tracker/{a.tracker_id}/snapshots/{a.snapshot_id}"),
        ("A parent + absent child", f"/jobs/tracker/{a.tracker_id}/snapshots/999999"),
        ("absent parent + A child", f"/jobs/tracker/999999/snapshots/{a.snapshot_id}"),
    ]
    failures = []
    for label, path in cases:
        resp = client.get(path, headers=b.headers)
        if resp.status_code not in REFUSED:
            failures.append(f"{label} [{path}] -> {resp.status_code}")
    assert not failures, "nested substitution disclosed:\n  " + "\n  ".join(failures)


def test_b_own_parent_with_b_own_child_still_works(client: TestClient, graphs) -> None:
    """The nested matrix must not pass merely because the route always refuses."""
    _, b = graphs
    assert client.get(f"/jobs/tracker/{b.tracker_id}/snapshots/{b.snapshot_id}",
                      headers=b.headers).status_code == 200


# --------------------------------------------------------------------------- #
# 4. Mutation isolation — with state re-read as the owner
# --------------------------------------------------------------------------- #
def tracker_state(user_id: int, tracker_id: int) -> dict:
    db = db_session()
    try:
        row = db.get(E.ApplicationTracker, tracker_id)
        if row is None:
            return {}
        return {
            "user_id": row.user_id, "status": row.status,
            "deletion_scheduled_at": row.deletion_scheduled_at,
            "deletion_cancelled_at": row.deletion_cancelled_at,
        }
    finally:
        db.close()


def test_b_cannot_mutate_a_tracker_and_a_state_is_unchanged(client: TestClient, graphs) -> None:
    a, b = graphs
    before = tracker_state(a.user_id, a.tracker_id)

    # The job is shared, so B may legitimately upsert ITS OWN tracker against
    # it. The invariant is not a refusal — it is that A's row does not move.
    upsert = client.put(f"/jobs/{a.job_id}/tracker", headers=b.headers,
                        json={"status": "rejected"})
    assert upsert.status_code < 500, upsert.text
    assert tracker_state(a.user_id, a.tracker_id) == before, "A tracker mutated by B"

    db = db_session()
    try:
        b_tracker = db.scalar(
            select(E.ApplicationTracker).where(
                E.ApplicationTracker.user_id == b.user_id,
                E.ApplicationTracker.job_id == a.job_id,
            )
        )
        assert b_tracker is None or b_tracker.id != a.tracker_id, (
            "B's upsert landed on A's tracker row"
        )
    finally:
        db.close()

    cancel = client.post(f"/jobs/tracker/{a.tracker_id}/cancel-deletion", headers=b.headers)
    assert cancel.status_code in REFUSED, f"cancel-deletion -> {cancel.status_code}"
    assert tracker_state(a.user_id, a.tracker_id) == before, "A retention state mutated by B"

    cover("POST", "/jobs/tracker/{tracker_id}/cancel-deletion",
          case="b_cannot_mutate_a_tracker", side_effect_checked=True)
    cover("PUT", "/jobs/{job_id}/tracker", kind=SHARED_EFFECT,
          case="b_cannot_mutate_a_tracker", isolation_asserted=True,
          side_effect_checked=True)


def test_the_owner_can_drive_their_own_tracker_and_retention(
    client: TestClient, graphs
) -> None:
    """Owner control for the tracker and retention routes.

    A acts on A's own rows here. Together with the B-side attack above this
    gives the shared-job routes a call from each identity, which is what
    "both may invoke, effects stay caller-scoped" actually requires.
    """
    a, _ = graphs
    upsert = client.put(f"/jobs/{a.job_id}/tracker", headers=a.headers,
                        json={"status": "interview"})
    assert upsert.status_code < 400, upsert.text
    cover("PUT", "/jobs/{job_id}/tracker", kind=SHARED_EFFECT,
          case="owner_can_drive_own_tracker", owner_control=True)

    # cancel-deletion is only meaningful once a deletion is actually scheduled.
    db = db_session()
    try:
        row = db.get(E.ApplicationTracker, a.tracker_id)
        row.deletion_scheduled_at = datetime.now(UTC) + timedelta(days=7)
        db.commit()
    finally:
        db.close()
    cancel = client.post(f"/jobs/tracker/{a.tracker_id}/cancel-deletion", headers=a.headers)
    assert cancel.status_code < 400, cancel.text
    cover("POST", "/jobs/tracker/{tracker_id}/cancel-deletion",
          case="owner_can_drive_own_retention", owner_control=True)


def session_state(session_id: int) -> dict:
    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session_id)
        if row is None:
            return {}
        return {
            "user_id": row.user_id,
            "status": getattr(row, "status", None),
            "completed_at": getattr(row, "completed_at", None),
            "cancelled_at": getattr(row, "cancelled_at", None),
            "confirmation_required_at": getattr(row, "confirmation_required_at", None),
        }
    finally:
        db.close()


#: Every mutating POST on the session family, with a body the route's schema
#: accepts. A 422 would prove nothing about ownership, so none is relied on.
SESSION_POST_LIFECYCLE = [
    ("cancel", {}),
    ("complete", {}),
    ("confirmation-required", {}),
    ("confirmation-dismissed", {}),
    ("refresh-from-profile", {}),
    ("regenerate-resume", {}),
    ("regenerate-cover-letter", {}),
    ("artifact-use", {"artifact": "resume", "mode": "uploaded", "text": None}),
    ("autofill-results", {"status": "completed", "fields_total": 1, "fields_filled": 1}),
    ("events", {"events": []}),
    ("map-option", {"question_label": "Are you authorized to work in the US?",
                    "options": ["Yes", "No"],
                    "canonical_key": "work_authorization_us",
                    "confirmed_answer": "Yes"}),
    ("submission-confirmed", {"evidence_type": "success_page", "resume_used": True,
                              "cover_letter_mode": "file"}),
]


def test_b_cannot_drive_a_session_lifecycle(client: TestClient, graphs) -> None:
    a, b = graphs
    before = session_state(a.session_id)
    failures = []
    for label, body in SESSION_POST_LIFECYCLE:
        path = f"/application-sessions/{a.session_id}/{label}"
        resp = client.post(path, headers=b.headers, json=body)
        if resp.status_code not in REFUSED:
            failures.append(f"{label} -> {resp.status_code} {resp.text[:120]}")
    assert not failures, "unauthorized session operations succeeded:\n  " + "\n  ".join(failures)

    assert session_state(a.session_id) == before, "A session mutated by B"
    # A's session is still A's, and still usable by A.
    assert client.get(f"/application-sessions/{a.session_id}",
                      headers=a.headers).status_code == 200
    for label, _ in SESSION_POST_LIFECYCLE:
        cover("POST", f"/application-sessions/{{session_id}}/{label}",
              case="b_cannot_drive_a_session_lifecycle", side_effect_checked=True)


def test_b_cannot_change_a_session_status(client: TestClient, graphs) -> None:
    """`PATCH /application-sessions/{id}/status` was absent from the original
    matrix entirely — a lifecycle mutation with no cross-user evidence."""
    a, b = graphs
    before = session_state(a.session_id)

    for status_value in ("cancelled", "completed", "failed", "ready_for_review"):
        resp = client.patch(f"/application-sessions/{a.session_id}/status",
                            headers=b.headers, json={"status": status_value})
        assert resp.status_code in REFUSED, (
            f"B set A session status={status_value} -> {resp.status_code}"
        )
        # Ownership is checked before the status vocabulary is validated, so a
        # rejected value cannot be what produced the refusal.
        assert resp.status_code != 422, "status validated before ownership"

    assert session_state(a.session_id) == before, "A session status mutated by B"
    cover("PATCH", "/application-sessions/{session_id}/status",
          case="b_cannot_change_a_session_status", side_effect_checked=True)


def test_b_cannot_map_an_option_on_a_session(client: TestClient, graphs) -> None:
    """`POST .../map-option` was likewise never exercised cross-user."""
    a, b = graphs
    before = session_state(a.session_id)
    resp = client.post(
        f"/application-sessions/{a.session_id}/map-option",
        headers=b.headers,
        json={"question_label": "Are you authorized to work in the US?",
              "options": ["Yes", "No"],
              "canonical_key": "work_authorization_us",
              "confirmed_answer": "Yes"},
    )
    assert resp.status_code in REFUSED, f"map-option -> {resp.status_code}"
    assert resp.status_code != 422, "body validated before ownership"
    assert session_state(a.session_id) == before, "A session mutated by B map-option"

    db = db_session()
    try:
        rows = list(db.scalars(
            select(E.ApplicationAnswer).where(E.ApplicationAnswer.user_id == a.user_id)
        ))
        assert all(r.value != "Yes" or r.canonical_key != "work_authorization_us"
                   or r.user_id == a.user_id for r in rows)
    finally:
        db.close()
    cover("POST", "/application-sessions/{session_id}/map-option",
          case="b_cannot_map_an_option_on_a_session", side_effect_checked=True)


def test_the_owner_can_drive_their_own_session_lifecycle(client: TestClient, graphs) -> None:
    """Owner control for the session family.

    Without it the lifecycle matrix could pass because the routes are broken for
    everyone rather than closed to strangers.
    """
    _, b = graphs
    reachable = 0
    for label, body in SESSION_POST_LIFECYCLE:
        resp = client.post(f"/application-sessions/{b.session_id}/{label}",
                           headers=b.headers, json=body)
        assert resp.status_code not in REFUSED, (
            f"owner refused on {label} -> {resp.status_code} {resp.text[:120]}"
        )
        reachable += 1
        cover("POST", f"/application-sessions/{{session_id}}/{label}",
              case="owner_can_drive_own_session_lifecycle", owner_control=True)
    assert reachable == len(SESSION_POST_LIFECYCLE)

    status_resp = client.patch(f"/application-sessions/{b.session_id}/status",
                               headers=b.headers, json={"status": "cancelled"})
    assert status_resp.status_code not in REFUSED, (
        f"owner refused on PATCH status -> {status_resp.status_code}"
    )
    cover("PATCH", "/application-sessions/{session_id}/status",
          case="owner_can_drive_own_session_lifecycle", owner_control=True)


def test_the_owner_can_write_their_own_session_answers_and_name(
    client: TestClient, graphs
) -> None:
    """Owner controls for the four session writes that had none.

    Stage 2G-D-R1 reached 51/51 coverage with 47 owner controls; these four
    were the gap. Each has a real success path for its owner, so "B is refused"
    needed pairing with "A is not" to rule out a route that simply never works.
    """
    a, _ = graphs
    key = "work_authorization_us"

    override = client.put(
        f"/application-sessions/{a.session_id}/answers/override/{key}",
        headers=a.headers, json={"value": True},
    )
    assert override.status_code < 400, override.text
    cover("PUT", "/application-sessions/{session_id}/answers/override/{canonical_key}",
          case="owner_can_write_own_session_answers", owner_control=True)

    answer = client.put(
        f"/application-sessions/{a.session_id}/answers/{key}",
        headers=a.headers, json={"value": "authorized_us"},
    )
    assert answer.status_code < 400, answer.text
    cover("PUT", "/application-sessions/{session_id}/answers/{canonical_key}",
          case="owner_can_write_own_session_answers", owner_control=True)

    name = client.put(
        f"/application-sessions/{a.session_id}/profile/name",
        headers=a.headers, json={"first_name": "Owner", "last_name": "Alpha"},
    )
    assert name.status_code < 400, name.text
    cover("PUT", "/application-sessions/{session_id}/profile/name",
          case="owner_can_write_own_session_answers", owner_control=True)

    resolve = client.post(
        f"/application-sessions/{a.session_id}/resolve-questions",
        headers=a.headers,
        json={"questions": [{
            "field_ref": "f1", "question": "Are you authorized to work in the United States?",
            "raw_label": None, "accessible_name": None, "nearby_text": None,
            "field_name": None, "field_id": None, "placeholder": None, "aria_role": None,
            "section": None, "control_type": "native_select", "required": True,
            "locale": "en-US", "options": [],
        }]},
    )
    assert resolve.status_code < 400, resolve.text
    cover("POST", "/application-sessions/{session_id}/resolve-questions",
          case="owner_can_write_own_session_answers", owner_control=True)

    # The writes really landed, so these are successes rather than silent no-ops.
    db = db_session()
    try:
        profile = db.scalar(select(E.UserProfile).where(E.UserProfile.user_id == a.user_id))
        assert profile is not None and profile.first_name == "Owner"
    finally:
        db.close()


def test_b_cannot_set_or_read_a_answer_overrides(client: TestClient, graphs) -> None:
    a, b = graphs
    key = "work_authorization_us"

    before = session_state(a.session_id)

    put = client.put(
        f"/application-sessions/{a.session_id}/answers/override/{key}",
        headers=b.headers, json={"value": True},
    )
    assert put.status_code in REFUSED, f"override PUT -> {put.status_code}"

    get = client.get(f"/application-sessions/{a.session_id}/answers/override", headers=b.headers)
    assert get.status_code in REFUSED

    answer = client.put(
        f"/application-sessions/{a.session_id}/answers/{key}",
        headers=b.headers, json={"value": "Yes"},
    )
    assert answer.status_code in REFUSED, f"answers PUT -> {answer.status_code}"

    name = client.put(
        f"/application-sessions/{a.session_id}/profile/name",
        headers=b.headers,
        json={"first_name": "Mallory", "last_name": "Hacker"},
    )
    assert name.status_code in REFUSED, f"profile/name PUT -> {name.status_code}"
    assert whoami(client, a.headers)["email"].startswith("owner-a")
    assert session_state(a.session_id) == before, "A session mutated through override routes"

    db = db_session()
    try:
        profile = db.scalar(select(E.UserProfile).where(E.UserProfile.user_id == a.user_id))
        assert profile is not None and "Mallory" not in (profile.full_name or ""), (
            "B rewrote A's profile name through a session route"
        )
    finally:
        db.close()

    for method, template in (
        ("PUT", "/application-sessions/{session_id}/answers/override/{canonical_key}"),
        ("GET", "/application-sessions/{session_id}/answers/override"),
        ("PUT", "/application-sessions/{session_id}/answers/{canonical_key}"),
        ("PUT", "/application-sessions/{session_id}/profile/name"),
    ):
        cover(method, template, case="b_cannot_set_or_read_a_answer_overrides",
              side_effect_checked=True)


def document_state(document_id: int) -> dict:
    db = db_session()
    try:
        row = db.get(E.GeneratedDocument, document_id)
        if row is None:
            return {}
        return {
            "user_id": row.user_id, "title": row.title,
            "content": row.content, "content_hash": row.content_hash,
            "immutable_at": row.immutable_at,
        }
    finally:
        db.close()


def test_b_cannot_mutate_a_document_metadata(client: TestClient, graphs) -> None:
    a, b = graphs
    before = document_state(a.resume_document_id)

    # A schema-valid body, so a 422 cannot be mistaken for access control.
    resp = client.put(f"/jobs/documents/{a.resume_document_id}", headers=b.headers,
                      json={"title": "stolen", "markdown": "MALLORY WAS HERE"})
    assert resp.status_code in REFUSED, f"document PUT -> {resp.status_code} {resp.text[:160]}"

    export = client.post(f"/jobs/documents/{a.resume_document_id}/export/pdf", headers=b.headers)
    assert export.status_code in REFUSED

    assert document_state(a.resume_document_id) == before, "A document mutated by B"
    # A's document still downloads, and still as A's.
    assert client.get(f"/jobs/documents/{a.resume_document_id}/download/pdf",
                      headers=a.headers).status_code == 200

    for method, template in (
        ("PUT", "/jobs/documents/{document_id}"),
        ("POST", "/jobs/documents/{document_id}/export/{fmt}"),
    ):
        cover(method, template, case="b_cannot_mutate_a_document_metadata",
              side_effect_checked=True)


def test_the_owner_can_mutate_and_export_their_own_document(client: TestClient, graphs) -> None:
    """Owner control for the document mutation routes."""
    _, b = graphs
    put = client.put(f"/jobs/documents/{b.resume_document_id}", headers=b.headers,
                     json={"title": "My Tailored Resume"})
    assert put.status_code == 200, put.text
    export = client.post(f"/jobs/documents/{b.resume_document_id}/export/pdf", headers=b.headers)
    assert export.status_code == 200, export.text
    for method, template in (
        ("PUT", "/jobs/documents/{document_id}"),
        ("POST", "/jobs/documents/{document_id}/export/{fmt}"),
    ):
        cover(method, template, case="owner_can_mutate_own_document", owner_control=True)


# --------------------------------------------------------------------------- #
# 5. Confirmation — the durable-history path
# --------------------------------------------------------------------------- #
def snapshot_count(tracker_id: int) -> int:
    db = db_session()
    try:
        return len(list(db.scalars(
            select(E.ApplicationSnapshot).where(
                E.ApplicationSnapshot.application_tracker_id == tracker_id
            )
        )))
    finally:
        db.close()


def test_b_cannot_confirm_a_session_or_create_a_history(client: TestClient, graphs) -> None:
    """Stage 2B/2D turn confirmation into durable, artifact-freezing history.
    A stranger driving it would forge another user's application record."""
    a, b = graphs
    before_snapshots = snapshot_count(a.tracker_id)
    before_state = tracker_state(a.user_id, a.tracker_id)
    before_b_trackers = {
        row["id"] for row in client.get("/jobs/tracker/submitted", headers=b.headers).json()["applications"]
    }

    resp = client.post(
        f"/application-sessions/{a.session_id}/submission-confirmed",
        headers=b.headers,
        json={"evidence_type": "success_page", "resume_used": True, "cover_letter_mode": "file"},
    )
    assert resp.status_code in REFUSED, f"confirm-applied -> {resp.status_code}"

    assert snapshot_count(a.tracker_id) == before_snapshots, "B caused a snapshot on A's tracker"
    assert tracker_state(a.user_id, a.tracker_id) == before_state, "B moved A's tracker"

    after_b_trackers = {
        row["id"] for row in client.get("/jobs/tracker/submitted", headers=b.headers).json()["applications"]
    }
    assert after_b_trackers == before_b_trackers, "B gained a tracker from A's session"
    cover("POST", "/application-sessions/{session_id}/submission-confirmed",
          case="b_cannot_confirm_a_session", side_effect_checked=True)


def test_b_cannot_claim_a_documents_as_its_own_provenance(client: TestClient, graphs) -> None:
    """Ownership of an artifact is server-derived; a client-supplied document id
    must not transfer it."""
    a, b = graphs

    # Both confirmation schemas set extra="forbid" and carry no document field
    # at all, so a foreign artifact reference cannot even be expressed. That is
    # a structural guarantee, and asserting it keeps a future field addition
    # from silently opening a provenance channel.
    for path, body in (
        (f"/jobs/{b.job_id}/applications/confirm-applied",
         {"confirmed": True, "resume_document_id": a.resume_document_id}),
        (f"/application-sessions/{b.session_id}/submission-confirmed",
         {"evidence_type": "success_page", "resume_used": True,
          "cover_letter_mode": "file",
          "cover_letter_document_id": a.cover_letter_document_id}),
    ):
        rejected = client.post(path, headers=b.headers, json=body)
        assert rejected.status_code == 422, (
            f"{path} accepted a client-supplied document id -> {rejected.status_code}"
        )

    # And with a legitimate body, B's own provenance never names A's artifacts.
    accepted = client.post(
        f"/jobs/{b.job_id}/applications/confirm-applied",
        headers=b.headers, json={"confirmed": True},
    )
    assert accepted.status_code < 400, accepted.text

    db = db_session()
    try:
        snaps = list(db.scalars(
            select(E.ApplicationSnapshot).join(
                E.ApplicationTracker,
                E.ApplicationSnapshot.application_tracker_id == E.ApplicationTracker.id,
            ).where(E.ApplicationTracker.user_id == b.user_id)
        ))
        a_documents = {a.resume_document_id, a.cover_letter_document_id}
        for snap in snaps:
            for attr in ("resume_document_id", "cover_letter_document_id"):
                value = getattr(snap, attr, None)
                assert value not in a_documents, f"B snapshot claimed A's {attr}"
    finally:
        db.close()

    # A's documents are untouched and still A's.
    assert client.get(f"/jobs/documents/{a.resume_document_id}/download/pdf",
                      headers=a.headers).status_code == 200
    assert client.get(f"/jobs/documents/{a.resume_document_id}/download/pdf",
                      headers=b.headers).status_code in REFUSED
    cover("POST", "/jobs/{job_id}/applications/confirm-applied", kind=SHARED_EFFECT,
          case="b_cannot_claim_a_documents_as_provenance",
          isolation_asserted=True, side_effect_checked=True)


def test_the_owner_can_confirm_applied_for_their_own_job(client: TestClient, graphs) -> None:
    """Owner control for confirm-applied on the shared job.

    Both users may confirm against the same JobPosting; what the matrix proves
    is that each confirmation lands on the caller's own tracker.
    """
    a, b = graphs
    before_a = tracker_state(a.user_id, a.tracker_id)

    # A confirming on A's own job is the owner control.
    own = client.post(f"/jobs/{a.job_id}/applications/confirm-applied",
                      headers=a.headers, json={"confirmed": True})
    assert own.status_code < 400, own.text

    resp = client.post(f"/jobs/{a.job_id}/applications/confirm-applied",
                       headers=b.headers, json={"confirmed": True})
    assert resp.status_code < 400, resp.text
    assert tracker_state(a.user_id, a.tracker_id) == before_a, (
        "B's confirmation on the shared job moved A's tracker"
    )

    db = db_session()
    try:
        b_tracker = db.scalar(
            select(E.ApplicationTracker).where(
                E.ApplicationTracker.user_id == b.user_id,
                E.ApplicationTracker.job_id == a.job_id,
            )
        )
        assert b_tracker is not None, "B's own confirmation created no tracker for B"
        assert b_tracker.id != a.tracker_id, "B's confirmation landed on A's tracker"
    finally:
        db.close()
    cover("POST", "/jobs/{job_id}/applications/confirm-applied", kind=SHARED_EFFECT,
          case="owner_can_confirm_applied", owner_control=True,
          isolation_asserted=True, side_effect_checked=True)


def test_b_cannot_resolve_questions_against_a_session(client: TestClient, graphs) -> None:
    a, b = graphs
    resp = client.post(
        f"/application-sessions/{a.session_id}/resolve-questions",
        headers=b.headers,
        json={"questions": [{
            "field_ref": "f1", "question": "Are you authorized to work in the United States?",
            "raw_label": None, "accessible_name": None, "nearby_text": None,
            "field_name": None, "field_id": None, "placeholder": None, "aria_role": None,
            "section": None, "control_type": "native_select", "required": True,
            "locale": "en-US", "options": [],
        }]},
    )
    assert resp.status_code in REFUSED, f"resolve-questions -> {resp.status_code}"
    assert "authorized" not in resp.text.lower() or resp.status_code in REFUSED
    cover("POST", "/application-sessions/{session_id}/resolve-questions",
          case="b_cannot_resolve_questions")


# --------------------------------------------------------------------------- #
# 6. Anti-enumeration
# --------------------------------------------------------------------------- #
def test_concealing_routes_answer_foreign_and_absent_ids_identically(
    client: TestClient, graphs
) -> None:
    """Tracker, snapshot and document routes conceal: a foreign id and an absent
    id get the same answer, so nothing about another account is confirmed."""
    a, b = graphs
    pairs = [
        ("snapshot list", f"/jobs/tracker/{a.tracker_id}/snapshots", "/jobs/tracker/99999999/snapshots"),
        ("snapshot detail", f"/jobs/tracker/{a.tracker_id}/snapshots/{a.snapshot_id}",
         "/jobs/tracker/99999999/snapshots/99999999"),
        ("document download", f"/jobs/documents/{a.resume_document_id}/download/pdf",
         "/jobs/documents/99999999/download/pdf"),
    ]
    for label, foreign, absent in pairs:
        f = client.get(foreign, headers=b.headers)
        n = client.get(absent, headers=b.headers)
        assert f.status_code in REFUSED and n.status_code in REFUSED, label
        assert f.status_code == n.status_code, (
            f"{label}: foreign={f.status_code} absent={n.status_code} — became an oracle"
        )


def test_session_routes_refuse_consistently_even_though_they_distinguish(
    client: TestClient, graphs
) -> None:
    """NEW-05, pinned rather than silently accepted.

    The application-session family answers 403 for a session owned by someone
    else and 404 for one that does not exist. That difference is an ownership
    oracle: it confirms that an id belongs to *some* account. It is deliberate —
    403 is this repository's "you are authenticated but not entitled" signal, and
    four accepted tests across three files assert it — so changing it is an API
    contract decision, not a narrow authorization fix, and is out of scope here.

    What this test does defend is the part that matters: whatever the code, the
    answer is always a refusal and never carries content. If a session route
    ever starts answering 200, this fails.
    """
    a, b = graphs
    for path in (
        f"/application-sessions/{a.session_id}",
        f"/application-sessions/{a.session_id}/answers",
        f"/application-sessions/{a.session_id}/answers/override",
        f"/application-sessions/{a.session_id}/resume",
        f"/application-sessions/{a.session_id}/cover-letter",
    ):
        foreign = client.get(path, headers=b.headers)
        absent = client.get(path.replace(str(a.session_id), "99999999", 1), headers=b.headers)
        assert foreign.status_code in REFUSED, f"{path} -> {foreign.status_code}"
        assert absent.status_code in REFUSED
        # The oracle is a status-code difference only; no private content travels.
        assert "Owner A" not in foreign.text and "Acme" not in foreign.text


# --------------------------------------------------------------------------- #
# 7. Mass assignment — client cannot name the owner
# --------------------------------------------------------------------------- #
def test_a_client_supplied_owner_field_cannot_reassign_ownership(
    client: TestClient, graphs
) -> None:
    a, b = graphs
    resp = client.post("/application-sessions", headers=b.headers,
                       json={"job_id": b.job_id, "user_id": a.user_id, "owner_id": a.user_id})
    if resp.status_code in (200, 201):
        db = db_session()
        try:
            created = db.get(E.ApplicationSession, resp.json()["session_id"])
            assert created.user_id == b.user_id, "client-supplied owner field was honoured"
        finally:
            db.close()


# --------------------------------------------------------------------------- #
# 8. Remaining private families — answer vault, people, privacy, job-scoped work
# --------------------------------------------------------------------------- #
def test_the_answer_vault_is_addressed_only_as_the_caller(client: TestClient, graphs) -> None:
    """`/application-answers/{canonical_key}` carries no user id — the row is
    selected by the authenticated principal. The risk is not an id to guess but
    a body field that might name someone else; both are checked."""
    a, b = graphs
    key = "work_authorization_us"

    assert client.put(f"/application-answers/{key}", headers=a.headers,
                      json={"value": "authorized_us"}).status_code in (200, 201, 204)

    # B writing the same key must touch only B's own row.
    resp = client.put(f"/application-answers/{key}", headers=b.headers,
                      json={"value": "not_authorized", "user_id": a.user_id})
    assert resp.status_code in (200, 201, 204, 403, 404, 422)

    db = db_session()
    try:
        rows = list(db.scalars(
            select(E.ApplicationAnswer).where(E.ApplicationAnswer.canonical_key == key)
        ))
        for row in rows:
            if row.user_id == a.user_id:
                assert row.value != "not_authorized", "B overwrote A's vault answer"
    finally:
        db.close()
    cover("PUT", "/application-answers/{canonical_key}", kind=CALLER_SCOPED,
          case="answer_vault_addressed_only_as_caller", owner_control=True,
          isolation_asserted=True, side_effect_checked=True)


def vault_row(user_id: int, key: str) -> dict:
    db = db_session()
    try:
        row = db.scalar(
            select(E.ApplicationAnswer).where(
                E.ApplicationAnswer.user_id == user_id,
                E.ApplicationAnswer.canonical_key == key,
            )
        )
        if row is None:
            return {}
        return {
            "value": row.value,
            "verified_at": getattr(row, "verified_at", None),
            "allow_auto_fill": getattr(row, "allow_auto_fill", None),
        }
    finally:
        db.close()


def test_b_cannot_reach_a_vault_entry_through_the_shared_key(
    client: TestClient, graphs
) -> None:
    """DELETE, verify and disable-autofill had no cross-user evidence at all.

    None of them takes an object id — the row is selected by the authenticated
    principal and a canonical key both users share. So the authorization
    question is namespacing: B sending A's exact key must reach only B's row.
    A refusal is not required; A's row surviving untouched is.
    """
    a, b = graphs
    key = "work_authorization_us"

    # A owns a real, verified, autofill-enabled entry.
    assert client.put(f"/application-answers/{key}", headers=a.headers,
                      json={"value": "authorized_us"}).status_code in (200, 201, 204)
    assert client.post(f"/application-answers/{key}/verify",
                       headers=a.headers).status_code == 200
    before = vault_row(a.user_id, key)
    assert before and before["value"] == "authorized_us"

    # B holds its own entry under the same key, so the calls below are not
    # no-ops that would pass for the wrong reason.
    assert client.put(f"/application-answers/{key}", headers=b.headers,
                      json={"value": "not_authorized"}).status_code in (200, 201, 204)

    verify = client.post(f"/application-answers/{key}/verify", headers=b.headers)
    assert verify.status_code in (200, 404), verify.text
    assert vault_row(a.user_id, key) == before, "B's verify altered A's entry"

    disable = client.post(f"/application-answers/{key}/disable-autofill", headers=b.headers)
    assert disable.status_code in (200, 404), disable.text
    assert vault_row(a.user_id, key) == before, "B's disable-autofill altered A's entry"

    delete = client.request("DELETE", f"/application-answers/{key}", headers=b.headers)
    assert delete.status_code in (204, 404), delete.text
    assert vault_row(a.user_id, key) == before, "B's DELETE removed or altered A's entry"

    # Caller-scoped semantics, documented rather than assumed: B's own row is
    # the one that goes.
    assert vault_row(b.user_id, key) == {}, "B's DELETE did not remove B's own row"

    # A can still read and use its entry afterwards.
    listing = client.get("/application-answers", headers=a.headers)
    assert listing.status_code == 200
    assert any(row.get("canonical_key") == key for row in listing.json().get("answers", [])), (
        "A's vault entry vanished from A's own listing"
    )

    for method, template in (
        ("POST", "/application-answers/{canonical_key}/verify"),
        ("POST", "/application-answers/{canonical_key}/disable-autofill"),
        ("DELETE", "/application-answers/{canonical_key}"),
    ):
        cover(method, template, kind=CALLER_SCOPED,
              case="b_cannot_reach_a_vault_entry_through_the_shared_key",
              owner_control=True, isolation_asserted=True, side_effect_checked=True)


@pytest.fixture()
def people_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Turn the People feature on for the authorization matrix only.

    Without this the whole family answers 404 PEOPLE_FEATURE_DISABLED *before*
    authorization runs, and every "B was refused" assertion passes against a
    switched-off feature rather than an ownership check. The sub-features are
    enabled for the same reason: `email`, `outreach-draft` and its `improve`
    variant each check their own flag before `owned_recommendation`, so a
    disabled flag would again refuse B for the wrong reason.

    monkeypatch restores every attribute at teardown, so the production
    defaults (`people_recommendations_enabled=False`, rollout "disabled") are
    untouched by this module.
    """
    from app.core.config import settings

    monkeypatch.setattr(settings, "people_recommendations_enabled", True)
    monkeypatch.setattr(settings, "people_rollout_mode", "all")
    monkeypatch.setattr(settings, "people_email_discovery_enabled", True)
    monkeypatch.setattr(settings, "people_outreach_drafting_enabled", True)
    monkeypatch.setattr(settings, "people_outreach_ai_enabled", True)
    # `/people/diagnostics` answers 404 outside a development environment, for
    # everyone, before ownership is consulted. Leaving it that way would make
    # its authorization assertions vacuous in exactly the way this stage exists
    # to eliminate, so the matrix reaches it the only way it can be reached.
    monkeypatch.setattr(settings, "app_env", "development")


def seed_recommendation(user_id: int, job_id: int, marker: str) -> int:
    """A real, *displayable* A-owned recommendation.

    The read and outreach paths filter on scoring version, employment
    validation version/status and the revalidation flag, so a fixture that
    skips them would be invisible to the owner too — and an owner control that
    cannot see the row proves nothing.
    """
    from app.people.employment_validation import EMPLOYMENT_VALIDATION_VERSION
    from app.people.scoring import SCORING_VERSION

    db = db_session()
    try:
        person = E.ProfessionalPerson(
            canonical_full_name=f"{marker} Recruiter",
            normalized_full_name=f"{marker.lower()} recruiter",
            current_company_name="Acme",
            current_company_domain="acme.example",
            current_title="Senior Technical Recruiter",
            normalized_title="senior technical recruiter",
            linkedin_url=f"https://www.linkedin.com/in/{marker.lower()}-recruiter",
            linkedin_url_normalized=f"linkedin.com/in/{marker.lower()}-recruiter",
            employment_last_verified_at=datetime.now(UTC),
            employment_revalidation_required=False,
            email_verification_status="unverified",
        )
        db.add(person)
        db.flush()
        candidate = E.JobPeopleCandidate(
            job_id=job_id,
            person_id=person.id,
            candidate_category="likely_recruiter",
            category_score=88,
            data_confidence=0.9,
            current_employment_confidence=0.95,
            employment_validation_status="confirmed_exact_company_verified",
            employment_validation_version=EMPLOYMENT_VALIDATION_VERSION,
            employment_validation_checked_at=datetime.now(UTC),
            recommendation_reasons=["Exact current company confirmed."],
            recommendation_limitations=[],
            scoring_version=SCORING_VERSION,
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
        db.add(candidate)
        db.flush()
        recommendation = E.UserJobPeopleRecommendation(
            user_id=user_id,
            job_id=job_id,
            job_people_candidate_id=candidate.id,
            personalized_reasons=[],
            personalized_score=88,
        )
        db.add(recommendation)
        db.commit()
        RECORDER.ownership.register("recommendation", recommendation.id, user_id)
        return recommendation.id
    finally:
        db.close()


def recommendation_state(recommendation_id: int) -> dict:
    db = db_session()
    try:
        row = db.get(E.UserJobPeopleRecommendation, recommendation_id)
        if row is None:
            return {}
        return {
            "user_id": row.user_id, "job_id": row.job_id,
            "saved_at": row.saved_at, "contacted_at": row.contacted_at,
            "suppressed_at": row.suppressed_at, "viewed_at": row.viewed_at,
        }
    finally:
        db.close()


#: (path suffix, method, body) for every ID-bearing People operation.
PEOPLE_RECOMMENDATION_OPS = [
    ("save", "POST", {}),
    ("contacted", "POST", {}),
    ("feedback", "POST", {"relevance_rating": "irrelevant"}),
    ("email", "POST", {}),
    ("outreach-draft", "POST", {"draft_type": "recruiter_introduction"}),
    ("outreach-draft/improve", "POST", {"draft_type": "recruiter_introduction"}),
]


def test_the_owner_can_reach_their_own_people_state(
    client: TestClient, graphs, people_enabled
) -> None:
    """Owner control for the People family.

    This is the assertion the previous matrix could not make: it proves the
    feature is genuinely on and the routes genuinely work, so the cross-user
    refusals that follow mean ownership and not a feature flag.
    """
    a, _ = graphs
    a_recommendation = seed_recommendation(a.user_id, a.job_id, "Alpha")

    listing = client.get(f"/jobs/{a.job_id}/people", headers=a.headers)
    assert listing.status_code == 200, listing.text
    assert listing.json().get("status") != "disabled", (
        "People still disabled — the owner control would be vacuous"
    )
    assert "Alpha Recruiter" in listing.text, "owner cannot see their own recommendation"
    cover("GET", "/jobs/{job_id}/people", kind=SHARED_EFFECT,
          case="owner_can_reach_own_people_state", owner_control=True)

    diagnostics = client.get(f"/jobs/{a.job_id}/people/diagnostics", headers=a.headers)
    assert diagnostics.status_code == 200, diagnostics.text
    cover("GET", "/jobs/{job_id}/people/diagnostics", kind=SHARED_EFFECT,
          case="owner_can_reach_own_people_state", owner_control=True)

    for suffix in ("discover", "broaden"):
        resp = client.post(f"/jobs/{a.job_id}/people/{suffix}", headers=a.headers, json={})
        assert resp.status_code != 500, resp.text[:200]
        cover("POST", f"/jobs/{{job_id}}/people/{suffix}", kind=SHARED_EFFECT,
              case="owner_can_reach_own_people_state", owner_control=True)

    # Reachability for the mutations: not PEOPLE_FEATURE_DISABLED and not the
    # "Recommendation not found" that ownership failure produces.
    for suffix, method, body in PEOPLE_RECOMMENDATION_OPS:
        resp = client.request(
            method, f"/jobs/{a.job_id}/people/{a_recommendation}/{suffix}",
            headers=a.headers, json=body,
        )
        assert resp.status_code != 404, (
            f"owner got 404 on {suffix} -> {resp.text[:160]}"
        )
        cover("POST", f"/jobs/{{job_id}}/people/{{recommendation_id}}/{suffix}",
              case="owner_can_reach_own_people_state", owner_control=True)

    unsave = client.request("DELETE", f"/jobs/{a.job_id}/people/{a_recommendation}/save",
                            headers=a.headers)
    assert unsave.status_code != 404, f"owner got 404 on DELETE save -> {unsave.text[:160]}"
    cover("DELETE", "/jobs/{job_id}/people/{recommendation_id}/save",
          case="owner_can_reach_own_people_state", owner_control=True)


def test_b_cannot_reach_a_private_people_state(
    client: TestClient, graphs, people_enabled
) -> None:
    """The People family attacked with a REAL A-owned recommendation id.

    The previous version of this test used `999999` against a disabled feature,
    so it proved neither that the routes authorize nor that they run at all.
    """
    a, b = graphs
    a_recommendation = seed_recommendation(a.user_id, a.job_id, "Alpha")
    before = recommendation_state(a_recommendation)
    assert before["user_id"] == a.user_id

    # Shared job, per-user rows: B may call these, but A's people must not
    # appear in B's answer.
    for template, path in (
        ("/jobs/{job_id}/people", f"/jobs/{a.job_id}/people"),
        ("/jobs/{job_id}/people/diagnostics", f"/jobs/{a.job_id}/people/diagnostics"),
    ):
        resp = client.get(path, headers=b.headers)
        assert resp.status_code == 200, resp.text
        assert "Alpha Recruiter" not in resp.text, "B saw A's recommendation"
        assert "owner-a@" not in resp.text
        assert "Owner A" not in resp.text
        cover("GET", template, kind=SHARED_EFFECT,
              case="b_cannot_reach_a_private_people_state", isolation_asserted=True)

    # Discovery is a per-user action on a shared job; it must not surface or
    # adopt A's rows.
    for suffix in ("discover", "broaden"):
        resp = client.post(f"/jobs/{a.job_id}/people/{suffix}", headers=b.headers, json={})
        assert resp.status_code != 500, resp.text[:200]
        assert "Alpha Recruiter" not in resp.text, f"{suffix} leaked A's recommendation"
        cover("POST", f"/jobs/{{job_id}}/people/{suffix}", kind=SHARED_EFFECT,
              case="b_cannot_reach_a_private_people_state", isolation_asserted=True)

    # Every ID-bearing operation, with A's real recommendation id.
    failures = []
    for suffix, method, body in PEOPLE_RECOMMENDATION_OPS:
        resp = client.request(
            method, f"/jobs/{a.job_id}/people/{a_recommendation}/{suffix}",
            headers=b.headers, json=body,
        )
        if resp.status_code not in REFUSED:
            failures.append(f"{suffix} -> {resp.status_code} {resp.text[:120]}")
        assert "Alpha Recruiter" not in resp.text, f"{suffix} leaked A's person"
        cover("POST", f"/jobs/{{job_id}}/people/{{recommendation_id}}/{suffix}",
              case="b_cannot_reach_a_private_people_state", side_effect_checked=True)

    unsave = client.request("DELETE", f"/jobs/{a.job_id}/people/{a_recommendation}/save",
                            headers=b.headers)
    if unsave.status_code not in REFUSED:
        failures.append(f"DELETE save -> {unsave.status_code}")
    cover("DELETE", "/jobs/{job_id}/people/{recommendation_id}/save",
          case="b_cannot_reach_a_private_people_state", side_effect_checked=True)

    assert not failures, "unauthorized People operations succeeded:\n  " + "\n  ".join(failures)
    assert recommendation_state(a_recommendation) == before, (
        "B's People attack mutated A's recommendation"
    )

    db = db_session()
    try:
        stolen = db.scalar(
            select(E.PeopleRecommendationFeedback).where(
                E.PeopleRecommendationFeedback.recommendation_id == a_recommendation,
                E.PeopleRecommendationFeedback.user_id == b.user_id,
            )
        )
        assert stolen is None, "B filed feedback against A's recommendation"
    finally:
        db.close()


def test_a_foreign_people_id_and_an_absent_one_are_both_refused(
    client: TestClient, graphs, people_enabled
) -> None:
    """§23: record whether the People family distinguishes foreign from absent."""
    a, b = graphs
    a_recommendation = seed_recommendation(a.user_id, a.job_id, "Alpha")

    foreign = client.post(f"/jobs/{a.job_id}/people/{a_recommendation}/save",
                          headers=b.headers, json={})
    absent = client.post(f"/jobs/{a.job_id}/people/999999/save",
                         headers=b.headers, json={})
    assert foreign.status_code in REFUSED and absent.status_code in REFUSED
    # This family conceals: the owner filter is part of the lookup, so a foreign
    # row and a missing row are indistinguishable. Unlike the session family,
    # there is no existence oracle here.
    assert foreign.status_code == absent.status_code == 404, (
        f"People stopped concealing: foreign={foreign.status_code} absent={absent.status_code}"
    )


def test_b_cannot_trigger_or_read_a_privacy_operation(client: TestClient, graphs) -> None:
    """Privacy routes are current-user scoped; an export must never be another
    account's export.

    History: the Stage 2G-D version wrapped its assertions in
    `if status == 200`, so nothing ran. Stage 2G-D-R1 pinned the 500 that
    NEW-06 caused. With NEW-06 fixed this is finally a real isolation test.
    """
    a, b = graphs

    export_b = client.get("/privacy/export", headers=b.headers)
    assert export_b.status_code == 200, export_b.text
    assert "stranger-b@" in export_b.text, (
        "B's export does not contain B — the isolation assertion would be vacuous"
    )
    assert "owner-a@" not in export_b.text, "B's export contained A's identity"
    assert "Owner A" not in export_b.text

    export_a = client.get("/privacy/export", headers=a.headers)
    assert export_a.status_code == 200, export_a.text
    assert "owner-a@" in export_a.text
    assert "stranger-b@" not in export_a.text, "A's export contained B's identity"
    assert "Stranger B" not in export_a.text

    # A's private artifacts belong to A's export and to no one else's.
    a_documents = {d["document_id"] for d in export_a.json()["documents"]}
    b_documents = {d["document_id"] for d in export_b.json()["documents"]}
    assert a_documents and b_documents, "one export carried no documents"
    assert a_documents.isdisjoint(b_documents), "the two exports shared a document"
    assert a.resume_document_id in a_documents
    assert a.resume_document_id not in b_documents

    # `DELETE /privacy/account` is strictly self-scoped.
    a_before = whoami(client, a.headers)
    deleted = client.request("DELETE", "/privacy/account", headers=b.headers, json={})
    assert deleted.status_code in (200, 204), deleted.text
    assert whoami(client, a.headers) == a_before, "B's account deletion touched A"

    db = db_session()
    try:
        assert db.get(E.User, a.user_id) is not None, "B's deletion removed A's account"
        assert db.get(E.User, b.user_id) is None, "B's own deletion did not remove B"
    finally:
        db.close()


def test_b_cannot_run_job_scoped_work_against_a_private_context(
    client: TestClient, graphs
) -> None:
    """These are job-scoped, and the job is shared — so B may legitimately act on
    it for itself. The invariant is that nothing it does lands on A's rows."""
    a, b = graphs
    before_docs = document_ids_for(a.user_id)
    before_b_docs = document_ids_for(b.user_id)
    before_state = tracker_state(a.user_id, a.tracker_id)

    job_scoped = [
        ("/jobs/{job_id}/match", f"/jobs/{a.job_id}/match", {}),
        ("/jobs/{job_id}/save", f"/jobs/{a.job_id}/save", {}),
        ("/jobs/{job_id}/generate-resume", f"/jobs/{a.job_id}/generate-resume", {}),
        ("/jobs/{job_id}/generate-cover-letter", f"/jobs/{a.job_id}/generate-cover-letter", {}),
        ("/jobs/{job_id}/generate-materials", f"/jobs/{a.job_id}/generate-materials",
         {"types": ["resume", "cover_letter"]}),
    ]
    for _template, path, body in job_scoped:
        resp = client.post(path, headers=b.headers, json=body)
        assert resp.status_code < 500, f"{path} -> {resp.status_code} {resp.text[:160]}"
        # A's private material must never come back in B's response.
        assert "Owner A" not in resp.text, f"{path} leaked A's identity"
        assert "owner-a@" not in resp.text

    assert document_ids_for(a.user_id) == before_docs, "B's job-scoped work created A documents"
    assert tracker_state(a.user_id, a.tracker_id) == before_state, "B altered A's tracker"

    # The private effect landed on B, which is what makes the isolation real
    # rather than a route that simply does nothing.
    after_b_docs = document_ids_for(b.user_id)
    assert after_b_docs > before_b_docs, (
        "B's generation produced no documents — the isolation assertion would be vacuous"
    )
    assert after_b_docs.isdisjoint(before_docs), "B's documents overlap A's"

    # And B still cannot read any of A's documents by id.
    for document_id in before_docs:
        assert client.get(f"/jobs/documents/{document_id}/download/pdf",
                          headers=b.headers).status_code in REFUSED

    for template, _, _ in job_scoped:
        cover("POST", template, kind=SHARED_EFFECT,
              case="b_cannot_run_job_scoped_work_against_a_private_context",
              isolation_asserted=True, side_effect_checked=True)


def test_b_cannot_reach_a_documents_through_the_shared_doc_type_route(
    client: TestClient, graphs
) -> None:
    """`POST /jobs/{job_id}/documents/{doc_type}` — shared job, caller-scoped effect.

    Stage 2G-D-R1 could only assert this at the database, because the route
    answered 500 to every caller (NEW-06). With the response contract fixed the
    isolation is now observable where it matters — in the body B receives.
    """
    a, b = graphs
    before_a = document_ids_for(a.user_id)
    before_b = document_ids_for(b.user_id)

    resp = client.post(f"/jobs/{a.job_id}/documents/resume", headers=b.headers, json={})
    assert resp.status_code == 200, resp.text
    document = resp.json()["document"]

    # B gets its OWN document for the shared job, never A's.
    assert document["document_id"] not in before_a, "B was handed one of A's documents"
    assert "Owner A" not in resp.text and "owner-a@" not in resp.text

    db = db_session()
    try:
        row = db.get(E.GeneratedDocument, document["document_id"])
        assert row is not None and row.user_id == b.user_id, (
            "the document B received is not owned by B"
        )
    finally:
        db.close()

    after_a, after_b = document_ids_for(a.user_id), document_ids_for(b.user_id)
    assert after_a == before_a, "B's call created or altered a document owned by A"
    assert after_b > before_b, (
        "B's call created nothing — the caller-scoped assertion would be vacuous"
    )
    assert after_b.isdisjoint(after_a), "B's new document overlaps A's"

    # And the id B now holds gives it no reach into A's documents.
    for document_id in before_a:
        assert client.get(f"/jobs/documents/{document_id}/download/pdf",
                          headers=b.headers).status_code in REFUSED
    cover("POST", "/jobs/{job_id}/documents/{doc_type}", kind=SHARED_EFFECT,
          case="b_cannot_reach_a_documents_through_shared_doc_type",
          isolation_asserted=True, side_effect_checked=True)


def test_the_owner_can_create_a_document_for_a_shared_job(client: TestClient, graphs) -> None:
    """Owner control for the same route — a real success, not a 500."""
    a, _ = graphs
    before = document_ids_for(a.user_id)
    resp = client.post(f"/jobs/{a.job_id}/documents/resume", headers=a.headers, json={})
    assert resp.status_code == 200, resp.text
    document = resp.json()["document"]
    assert document["document_type"] == "resume"
    assert document["document_id"] not in before
    assert document_ids_for(a.user_id) > before, "owner's own call created no document"
    # The owner can immediately use what the route handed back.
    assert client.get(f"/jobs/documents/{document['document_id']}/download/pdf",
                      headers=a.headers).status_code == 200
    cover("POST", "/jobs/{job_id}/documents/{doc_type}", kind=SHARED_EFFECT,
          case="owner_can_create_document_for_shared_job", owner_control=True)


def test_the_owner_can_run_job_scoped_work_for_themselves(client: TestClient, graphs) -> None:
    """Owner control for the shared-job/private-effect family."""
    a, _ = graphs
    for template, suffix, body in (
        ("/jobs/{job_id}/match", "match", {}),
        ("/jobs/{job_id}/save", "save", {}),
        ("/jobs/{job_id}/generate-resume", "generate-resume", {}),
        ("/jobs/{job_id}/generate-cover-letter", "generate-cover-letter", {}),
        ("/jobs/{job_id}/generate-materials", "generate-materials",
         {"types": ["resume"]}),
    ):
        resp = client.post(f"/jobs/{a.job_id}/{suffix}", headers=a.headers, json=body)
        assert resp.status_code < 400, f"owner refused on {suffix}: {resp.text[:160]}"
        cover("POST", template, kind=SHARED_EFFECT,
              case="owner_can_run_job_scoped_work", owner_control=True)


def document_ids_for(user_id: int) -> set[int]:
    db = db_session()
    try:
        return {
            row.id for row in db.scalars(
                select(E.GeneratedDocument).where(E.GeneratedDocument.user_id == user_id)
            )
        }
    finally:
        db.close()


def test_a_private_graph_is_intact_after_the_entire_matrix(client: TestClient, graphs) -> None:
    """The closing assertion: after every rejected attack above, A's world still
    works exactly as A left it."""
    a, b = graphs

    # Replay the full attack set once more, then verify A end to end.
    for _, path in read_matrix(a):
        client.get(path, headers=b.headers)
    client.post(f"/application-sessions/{a.session_id}/submission-confirmed", headers=b.headers,
                json={"evidence_type": "success_page", "resume_used": True,
                      "cover_letter_mode": "file"})
    client.post(f"/jobs/tracker/{a.tracker_id}/cancel-deletion", headers=b.headers)

    for _, path in read_matrix(a):
        assert client.get(path, headers=a.headers).status_code == 200, f"A lost access to {path}"

    state = tracker_state(a.user_id, a.tracker_id)
    assert state["user_id"] == a.user_id
    assert state["deletion_cancelled_at"] is None
    assert snapshot_count(a.tracker_id) == 1



# --------------------------------------------------------------------------- #
# 10. NEW-05 — exact scope of the session-family existence oracle
# --------------------------------------------------------------------------- #
def session_family_operations() -> list[tuple[str, str]]:
    """Every private operation under /application-sessions/{session_id}."""
    return sorted(
        op for op in private_operations()
        if op[1].startswith("/application-sessions/{session_id}")
    )


def test_new05_scope_is_exactly_the_routes_documented(client: TestClient, graphs) -> None:
    """NEW-05 was documented as "`/application-sessions/{id}` and 4 sub-routes".

    That was a four-fold undercount. The scope is enumerated here from the live
    schema so the documentation cannot drift from the behaviour again.
    """
    a, b = graphs
    absent = 99_999_999
    bodies = dict(SESSION_POST_LIFECYCLE)

    distinguishing: list[str] = []
    concealing: list[str] = []
    for method, template in session_family_operations():
        suffix = template.removeprefix("/application-sessions/{session_id}")
        foreign_path = f"/application-sessions/{a.session_id}{suffix}"
        absent_path = f"/application-sessions/{absent}{suffix}"
        # Fill any remaining placeholders (e.g. {canonical_key}) with vocabulary.
        foreign_path = foreign_path.replace("{canonical_key}", "work_authorization_us")
        absent_path = absent_path.replace("{canonical_key}", "work_authorization_us")
        body = bodies.get(suffix.lstrip("/"), {})

        foreign = client.request(method, foreign_path, headers=b.headers, json=body)
        missing = client.request(method, absent_path, headers=b.headers, json=body)

        assert foreign.status_code in REFUSED, (
            f"{method} {template} foreign -> {foreign.status_code}"
        )
        assert missing.status_code in REFUSED, (
            f"{method} {template} absent -> {missing.status_code}"
        )
        # Existence only: neither answer may carry A's data.
        for response in (foreign, missing):
            assert "Owner A" not in response.text
            assert "owner-a@" not in response.text

        label = f"{method} {template}"
        if foreign.status_code != missing.status_code:
            distinguishing.append(label)
        else:
            concealing.append(label)

    # Pinned so a change in either direction is visible in review.
    assert len(distinguishing) == 20, (
        f"NEW-05 scope moved: {len(distinguishing)} distinguishing routes\n  "
        + "\n  ".join(distinguishing)
    )
    assert sorted(concealing) == [
        "POST /application-sessions/{session_id}/regenerate-cover-letter",
        "POST /application-sessions/{session_id}/regenerate-resume",
    ], f"unexpected concealing set: {concealing}"


def test_tracker_snapshot_and_document_families_conceal(client: TestClient, graphs) -> None:
    """The contrast case for NEW-05: these families answer identically."""
    a, b = graphs
    absent = 99_999_999
    for foreign_path, absent_path in (
        (f"/jobs/tracker/{a.tracker_id}/snapshots", f"/jobs/tracker/{absent}/snapshots"),
        (f"/jobs/tracker/{a.tracker_id}/snapshots/{a.snapshot_id}",
         f"/jobs/tracker/{absent}/snapshots/{absent}"),
        (f"/jobs/documents/{a.resume_document_id}/download/pdf",
         f"/jobs/documents/{absent}/download/pdf"),
    ):
        foreign = client.get(foreign_path, headers=b.headers)
        missing = client.get(absent_path, headers=b.headers)
        assert foreign.status_code == missing.status_code == 404, (
            f"{foreign_path}: foreign={foreign.status_code} absent={missing.status_code}"
        )


# --------------------------------------------------------------------------- #
# 11. Negative controls — the matrix must be load-bearing
# --------------------------------------------------------------------------- #
#: These three tests breach ownership deliberately. The coverage gate excludes
#: them from its "no stranger ever got a 2xx" scan, and each one FAILS if the
#: breach does not occur — which is what makes them controls rather than holes.
NEGATIVE_CONTROLS = frozenset({
    "test_the_session_matrix_would_catch_a_removed_ownership_check",
    "test_the_document_matrix_would_catch_a_removed_ownership_filter",
    "test_the_people_matrix_would_catch_a_removed_ownership_filter",
})
def test_the_session_matrix_would_catch_a_removed_ownership_check(
    client: TestClient, graphs, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Simulate the guard being gone and prove the matrix notices.

    The Stage 2G-D negative controls edited production source by hand and left
    no artefact, so nothing stopped the suite from being decorative. This does
    the same job at test level: `_resolve_session` is patched to skip its
    ownership comparison, and the assertions the real matrix makes are then
    expected to FAIL. Production source is untouched, and monkeypatch restores
    the resolver at teardown.
    """
    from app.routes import applications as module

    a, b = graphs
    # Sanity: with the real guard in place, B is refused.
    assert client.get(f"/application-sessions/{a.session_id}",
                      headers=b.headers).status_code in REFUSED

    def unguarded(session_id, credentials, db, *args, **kwargs):
        from app.models.entities import ApplicationSession

        session = db.get(ApplicationSession, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Not found")
        return session

    monkeypatch.setattr(module, "_resolve_session", unguarded)

    breached = client.get(f"/application-sessions/{a.session_id}", headers=b.headers)
    assert breached.status_code == 200, (
        "removing the ownership comparison did not change the outcome — the "
        "session matrix is not load-bearing"
    )


def test_the_document_matrix_would_catch_a_removed_ownership_filter(
    client: TestClient, graphs, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same proof for the document family, whose filter is an inline
    `record.user_id != user.id` rather than a shared resolver."""
    from app.models.entities import GeneratedDocument

    a, b = graphs
    assert client.get(f"/jobs/documents/{a.resume_document_id}/download/pdf",
                      headers=b.headers).status_code in REFUSED

    real_get = Session.get

    def blind_get(self, entity, ident, *args, **kwargs):
        record = real_get(self, entity, ident, *args, **kwargs)
        if entity is GeneratedDocument and record is not None:
            # Simulate the filter being gone by making A's row look like B's.
            record.user_id = b.user_id
        return record

    monkeypatch.setattr(Session, "get", blind_get)
    breached = client.get(f"/jobs/documents/{a.resume_document_id}/download/pdf",
                          headers=b.headers)
    assert breached.status_code == 200, (
        "making A's document look like B's did not change the outcome — the "
        f"document ownership filter is not the deciding check ({breached.status_code})"
    )


def test_the_people_matrix_would_catch_a_removed_ownership_filter(
    client: TestClient, graphs, people_enabled, monkeypatch: pytest.MonkeyPatch
) -> None:
    """And for People, whose filter lives in `owned_recommendation`."""
    from app.people import service as people_service
    from app.routes import people as people_routes

    a, b = graphs
    a_recommendation = seed_recommendation(a.user_id, a.job_id, "Alpha")
    assert client.post(f"/jobs/{a.job_id}/people/{a_recommendation}/save",
                       headers=b.headers, json={}).status_code in REFUSED

    real = people_service.owned_recommendation

    def unowned(db, user, job_id, recommendation_id):
        from app.models.entities import User as UserModel

        owner = db.get(UserModel, a.user_id)
        return real(db, owner, job_id, recommendation_id)

    monkeypatch.setattr(people_service, "owned_recommendation", unowned)
    monkeypatch.setattr(people_routes, "set_saved", people_service.set_saved)

    breached = client.post(f"/jobs/{a.job_id}/people/{a_recommendation}/save",
                           headers=b.headers, json={})
    assert breached.status_code == 200, (
        "resolving the recommendation as its owner did not change the outcome — "
        "the People matrix is not load-bearing"
    )


# --------------------------------------------------------------------------- #
# 12. The coverage gate
# --------------------------------------------------------------------------- #
def test_every_private_operation_is_dynamically_covered(client: TestClient, graphs) -> None:
    """applicable private operations - dynamically covered = empty set.

    This is the assertion Stage 2G-D asserted in prose and got wrong. Every
    claim registered with `cover()` is re-checked here against the requests the
    recorder actually observed, so a declaration with no matching request is
    reported as missing rather than believed.

    It runs last in the module; the ledger and recorder are module-scoped, so it
    sees everything the matrix did. Under a filtered run (`-k`) the earlier
    cases have not executed, so the gate reports itself as inconclusive rather
    than failing for the wrong reason.
    """
    a, b = graphs
    applicable = private_operations()
    covered, rejected = LEDGER.verify(RECORDER, a.user_id, b.user_id)

    declared = set(LEDGER.entries)
    if len(declared) < len(applicable) and len(RECORDER.records) < 400:
        pytest.skip(
            "partial run: the coverage gate is only meaningful for the whole "
            f"module ({len(declared)} of {len(applicable)} operations declared)"
        )

    missing = applicable - covered
    report = [f"{method} {template}" for method, template in sorted(missing, key=lambda o: o[1])]
    detail = "\n  ".join(
        f"{m} {t}: {reason}" for (m, t), reason in sorted(rejected.items(), key=lambda kv: kv[0][1])
    )
    assert not missing, (
        f"{len(missing)} of {len(applicable)} private operations lack dynamic "
        "cross-user coverage:\n  " + "\n  ".join(report)
        + (f"\n\nrejected claims:\n  {detail}" if detail else "")
    )
    assert not rejected, f"claims not backed by a request:\n  {detail}"

    # And nothing anywhere in the matrix handed a stranger a 2xx — except the
    # negative controls, which remove a guard on purpose and REQUIRE the breach.
    breaches = RECORDER.unauthorized_successes(exclude_tests=NEGATIVE_CONTROLS)
    assert not breaches, "\n".join(
        f"{r.method} {r.template} -> {r.status} (refs {r.refs}) in {r.test}"
        for r in breaches
    )


def test_the_coverage_gate_reports_the_measured_numbers(client: TestClient, graphs) -> None:
    """Print the measurement so the documentation is transcribed, not invented."""
    a, b = graphs
    applicable = private_operations()
    covered, _ = LEDGER.verify(RECORDER, a.user_id, b.user_id)
    if len(LEDGER.entries) < len(applicable):
        pytest.skip("partial run")
    print(
        f"\nB-01 COVERAGE  published={len(openapi_operations())} "
        f"id_bearing={len(id_bearing_operations())} "
        f"shared_excluded={len(SHARED_PUBLIC_OPERATIONS)} "
        f"applicable={len(applicable)} covered={len(covered & applicable)} "
        f"missing={len(applicable - covered)}"
    )
