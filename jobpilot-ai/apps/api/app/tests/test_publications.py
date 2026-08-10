"""Publications: persistence, replace semantics, isolation, and URL safety."""

from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401
from app.models import entities as E


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def auth(client: TestClient, email: str = "pub@mailbox.test-domain.co") -> dict[str, str]:
    token = client.post(
        "/auth/signup", json={"email": email, "password": "password123"}
    ).json()
    return {"Authorization": f"Bearer {token['access_token']}"}


PUB = {
    "title": "Efficient Video Event Detection at the Edge",
    "venue": "IEEE",
    "authors": ["C. Pandey", "A. Researcher"],
    "publication_date": "2025-03-01",
    "url": "https://ieeexplore.ieee.org/document/12345",
    "doi": "10.1109/EXAMPLE.2025.12345",
    "description": "A low-latency detection pipeline for constrained devices.",
}


def save_career(client: TestClient, headers: dict[str, str], publications: list[dict]):
    return client.put(
        "/profile/career",
        headers=headers,
        json={
            "education": [],
            "experience": [],
            "projects": [],
            "certifications": [],
            "awards": [],
            "publications": publications,
        },
    )


def read_publications(client: TestClient, headers: dict[str, str]) -> list[dict]:
    resp = client.get("/profile/career", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["publications"]


# --------------------------------------------------------------------------- #
# CRUD via the existing replace semantics
# --------------------------------------------------------------------------- #
def test_publications_round_trip(client: TestClient):
    headers = auth(client)
    assert save_career(client, headers, [PUB]).status_code == 200

    stored = read_publications(client, headers)
    assert len(stored) == 1
    assert stored[0]["title"] == PUB["title"]
    assert stored[0]["venue"] == "IEEE"
    assert stored[0]["authors"] == ["C. Pandey", "A. Researcher"]
    assert stored[0]["doi"] == "10.1109/EXAMPLE.2025.12345"
    assert str(stored[0]["publication_date"]).startswith("2025-03-01")


def test_empty_by_default(client: TestClient):
    headers = auth(client, "emptypub@mailbox.test-domain.co")
    assert read_publications(client, headers) == []


def test_saving_replaces_rather_than_appends(client: TestClient):
    """Matches every other career table: PUT is a full replace."""
    headers = auth(client, "replacepub@mailbox.test-domain.co")
    save_career(client, headers, [PUB, {**PUB, "title": "Second paper"}])
    assert len(read_publications(client, headers)) == 2

    save_career(client, headers, [{**PUB, "title": "Only one left"}])
    remaining = read_publications(client, headers)
    assert [p["title"] for p in remaining] == ["Only one left"]


def test_deleting_all_publications(client: TestClient):
    headers = auth(client, "delpub@mailbox.test-domain.co")
    save_career(client, headers, [PUB])
    save_career(client, headers, [])
    assert read_publications(client, headers) == []


def test_optional_fields_may_be_omitted(client: TestClient):
    """A preprint may have no DOI; an in-press paper may have no date."""
    headers = auth(client, "minimalpub@mailbox.test-domain.co")
    assert save_career(client, headers, [{"title": "Untitled work in progress"}]).status_code == 200

    stored = read_publications(client, headers)[0]
    assert stored["title"] == "Untitled work in progress"
    assert stored["venue"] is None
    assert stored["doi"] is None
    assert stored["publication_date"] is None
    assert stored["url"] is None


def test_title_is_required(client: TestClient):
    headers = auth(client, "notitle@mailbox.test-domain.co")
    assert save_career(client, headers, [{"title": ""}]).status_code == 422
    assert save_career(client, headers, [{"venue": "IEEE"}]).status_code == 422


def test_authors_are_never_auto_populated(client: TestClient):
    """The user's own name must not be injected into the author list."""
    headers = auth(client, "authors@mailbox.test-domain.co")
    client.put(
        "/profile",
        headers=headers,
        json={"full_name": "Chandra Pandey", "location_country": "United States"},
    )
    save_career(client, headers, [{"title": "Solo work", "authors": []}])

    stored = read_publications(client, headers)[0]
    assert stored["authors"] == []


# --------------------------------------------------------------------------- #
# Security
# --------------------------------------------------------------------------- #
def test_unsafe_url_schemes_are_rejected(client: TestClient):
    headers = auth(client, "unsafepub@mailbox.test-domain.co")
    for bad in ("javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"):
        resp = save_career(client, headers, [{**PUB, "url": bad}])
        assert resp.status_code == 422, f"{bad} must be rejected"


def test_career_endpoints_require_authentication(client: TestClient):
    assert client.get("/profile/career").status_code == 401
    assert (
        client.put(
            "/profile/career",
            json={
                "education": [],
                "experience": [],
                "projects": [],
                "certifications": [],
                "awards": [],
                "publications": [PUB],
            },
        ).status_code
        == 401
    )


def test_publications_are_scoped_to_the_signed_in_user(client: TestClient):
    """No parameter can widen the query — ownership comes from the token."""
    mine = auth(client, "pubmine@mailbox.test-domain.co")
    theirs = auth(client, "pubtheirs@mailbox.test-domain.co")
    save_career(client, mine, [PUB])

    assert len(read_publications(client, mine)) == 1
    assert read_publications(client, theirs) == []

    # And saving as the other user cannot touch the first user's rows.
    save_career(client, theirs, [{"title": "Their own paper"}])
    assert [p["title"] for p in read_publications(client, mine)] == [PUB["title"]]


def test_publications_declare_a_cascading_owner_fk():
    """Deleting a user must take their publications with them.

    Asserted on the declared constraint rather than by deleting a row: SQLite
    does not enforce ON DELETE CASCADE unless PRAGMA foreign_keys is on, so a
    behavioural test here would prove nothing about production. The real
    cascade is exercised against PostgreSQL in the migration verification.
    """
    fks = list(E.Publication.__table__.foreign_keys)
    assert len(fks) == 1
    fk = fks[0]
    assert fk.column.table.name == "users"
    assert fk.ondelete == "CASCADE"


def test_stored_text_is_returned_verbatim_not_rendered(client: TestClient):
    """Storage keeps what the user typed; escaping is the renderer's job."""
    headers = auth(client, "xsspub@mailbox.test-domain.co")
    payload = {**PUB, "title": "<script>alert(1)</script>", "authors": ["<img onerror=x>"]}
    assert save_career(client, headers, [payload]).status_code == 200

    stored = read_publications(client, headers)[0]
    assert stored["title"] == "<script>alert(1)</script>"
    # No HTML was interpreted or stripped server-side — it is inert text.
    assert stored["authors"] == ["<img onerror=x>"]


def test_long_values_are_bounded(client: TestClient):
    headers = auth(client, "longpub@mailbox.test-domain.co")
    assert save_career(client, headers, [{**PUB, "title": "x" * 301}]).status_code == 422
    assert save_career(client, headers, [{**PUB, "doi": "x" * 121}]).status_code == 422
    too_many = [{**PUB, "authors": [f"Author {i}" for i in range(51)]}]
    assert save_career(client, headers, too_many).status_code == 422


def test_malformed_date_is_rejected(client: TestClient):
    headers = auth(client, "baddate@mailbox.test-domain.co")
    bad_date = [{**PUB, "publication_date": "not-a-date"}]
    assert save_career(client, headers, bad_date).status_code == 422


def test_publications_do_not_disturb_other_career_sections(client: TestClient):
    headers = auth(client, "coexist@mailbox.test-domain.co")
    resp = client.put(
        "/profile/career",
        headers=headers,
        json={
            "education": [{"school": "ASU", "degree": "MS"}],
            "experience": [{"company": "Acme", "title": "Engineer"}],
            "projects": [],
            "certifications": [{"name": "CKA"}],
            "awards": [{"name": "Dean's List"}],
            "publications": [PUB],
        },
    )
    assert resp.status_code == 200, resp.text

    career = client.get("/profile/career", headers=headers).json()
    assert len(career["education"]) == 1
    assert len(career["experience"]) == 1
    assert len(career["certifications"]) == 1
    assert len(career["awards"]) == 1
    assert len(career["publications"]) == 1
