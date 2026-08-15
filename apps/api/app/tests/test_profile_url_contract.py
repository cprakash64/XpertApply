"""Executable invariant for every user-editable profile URL write path."""

from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401
from app.models.entities import UserProfile
from app.schemas.profile import UserProfileIn


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db() -> Generator[Session, None, None]:
        db = testing_session()
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


def auth(client: TestClient, email: str = "profile-url@example.com") -> dict[str, str]:
    response = client.post(
        "/auth/signup", json={"email": email, "password": "password123"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def stored_profile() -> UserProfile:
    db = next(app.dependency_overrides[get_db]())
    try:
        profile = db.scalar(select(UserProfile))
        assert profile is not None
        db.expunge(profile)
        return profile
    finally:
        db.close()


VALID_URLS = [
    (None, None),
    ("", None),
    ("   ", None),
    ("cpandey.com", "https://cpandey.com/"),
    ("www.cpandey.com", "https://www.cpandey.com/"),
    ("cpandey.com/projects", "https://cpandey.com/projects"),
    ("https://cpandey.com", "https://cpandey.com/"),
    ("http://cpandey.com", "http://cpandey.com/"),
    (
        "https://cpandey.com/projects?q=1",
        "https://cpandey.com/projects?q=1",
    ),
]

INVALID_URLS = [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///etc/passwd",
    "ftp://cpandey.com",
    "not a url",
    "://broken",
    "https://",
]


@pytest.mark.parametrize(("raw", "canonical"), VALID_URLS)
def test_put_profile_normalizes_named_url_and_persists_string(
    client: TestClient, raw: str | None, canonical: str | None
) -> None:
    headers = auth(client)

    response = client.put(
        "/profile",
        headers=headers,
        json={"full_name": "URL Candidate", "portfolio_url": raw},
    )

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["portfolio_url"] == canonical
    assert stored_profile().portfolio_url == canonical
    assert client.get("/profile", headers=headers).json()["profile"]["portfolio_url"] == canonical


@pytest.mark.parametrize("field", ["linkedin_url", "github_url", "portfolio_url", "x_url"])
def test_every_named_profile_url_uses_the_same_policy(client: TestClient, field: str) -> None:
    headers = auth(client)

    response = client.put(
        "/profile", headers=headers, json={"full_name": "URL Candidate", field: "cpandey.com"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["profile"][field] == "https://cpandey.com/"
    assert getattr(stored_profile(), field) == "https://cpandey.com/"


@pytest.mark.parametrize("bad", INVALID_URLS)
def test_put_profile_rejects_invalid_url_without_overwriting_profile(
    client: TestClient, bad: str
) -> None:
    headers = auth(client)
    baseline = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "Keep Me",
            "portfolio_url": "https://safe.example",
            "target_roles": ["Backend Engineer"],
        },
    )
    assert baseline.status_code == 200

    response = client.put(
        "/profile",
        headers=headers,
        json={"full_name": "Destroy Me", "portfolio_url": bad, "target_roles": []},
    )

    assert response.status_code == 422
    persisted = client.get("/profile", headers=headers).json()["profile"]
    assert persisted["full_name"] == "Keep Me"
    assert persisted["portfolio_url"] == "https://safe.example/"
    assert persisted["target_roles"] == ["Backend Engineer"]


def test_additional_link_uses_the_same_canonical_policy(client: TestClient) -> None:
    headers = auth(client)

    response = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "URL Candidate",
            "additional_links": [{"label": "Personal site", "url": "cpandey.com"}],
        },
    )

    assert response.status_code == 200, response.text
    expected = [{"label": "Personal site", "url": "https://cpandey.com/"}]
    assert response.json()["profile"]["additional_links"] == expected
    assert stored_profile().additional_links == expected


@pytest.mark.parametrize("bad", INVALID_URLS)
def test_additional_link_rejects_invalid_url(client: TestClient, bad: str) -> None:
    headers = auth(client)
    response = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "URL Candidate",
            "additional_links": [{"label": "Bad", "url": bad}],
        },
    )
    assert response.status_code == 422
    assert stored_profile().additional_links in (None, [])


def import_payload(
    url: str | None,
    *,
    full_name: str = "Imported Candidate",
    field: str = "portfolio_url",
) -> dict:
    return {
        "sections": ["basic_info", "links"],
        "overwrite": True,
        "draft": {
            "basic_info": {"full_name": full_name},
            "links": {field: url},
        },
    }


@pytest.mark.parametrize(("raw", "canonical"), VALID_URLS)
def test_import_apply_normalizes_and_persists_named_url(
    client: TestClient, raw: str | None, canonical: str | None
) -> None:
    headers = auth(client)

    response = client.post(
        "/profile/import/apply", headers=headers, json=import_payload(raw)
    )

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["portfolio_url"] == canonical
    assert stored_profile().portfolio_url == canonical
    assert client.get("/profile", headers=headers).json()["profile"]["portfolio_url"] == canonical


@pytest.mark.parametrize("field", ["linkedin_url", "github_url", "portfolio_url"])
def test_every_imported_named_url_uses_the_same_policy(
    client: TestClient, field: str
) -> None:
    headers = auth(client)

    response = client.post(
        "/profile/import/apply",
        headers=headers,
        json=import_payload("cpandey.com", field=field),
    )

    assert response.status_code == 200, response.text
    assert response.json()["profile"][field] == "https://cpandey.com/"
    assert getattr(stored_profile(), field) == "https://cpandey.com/"


def test_import_basic_info_link_fallback_is_also_canonical(client: TestClient) -> None:
    headers = auth(client)
    payload = import_payload(None)
    payload["draft"]["basic_info"]["portfolio_url"] = "cpandey.com/projects"

    response = client.post("/profile/import/apply", headers=headers, json=payload)

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["portfolio_url"] == "https://cpandey.com/projects"
    assert stored_profile().portfolio_url == "https://cpandey.com/projects"


def test_blank_import_url_remains_absent(client: TestClient) -> None:
    headers = auth(client)

    response = client.post(
        "/profile/import/apply", headers=headers, json=import_payload("   ")
    )

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["portfolio_url"] is None
    assert stored_profile().portfolio_url is None


@pytest.mark.parametrize("bad", INVALID_URLS)
def test_import_apply_rejects_invalid_url_before_any_write(
    client: TestClient, bad: str
) -> None:
    headers = auth(client)
    baseline = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "Keep Me",
            "portfolio_url": "https://safe.example",
            "target_roles": ["Backend Engineer"],
        },
    )
    assert baseline.status_code == 200

    response = client.post(
        "/profile/import/apply",
        headers=headers,
        json=import_payload(bad, full_name="Destroy Me"),
    )

    assert response.status_code == 422
    persisted = client.get("/profile", headers=headers).json()["profile"]
    assert persisted["full_name"] == "Keep Me"
    assert persisted["portfolio_url"] == "https://safe.example/"
    assert persisted["target_roles"] == ["Backend Engineer"]


def test_every_write_path_produces_profile_input_the_canonical_schema_accepts(
    client: TestClient,
) -> None:
    direct_headers = auth(client, "direct-url@example.com")
    direct = client.put(
        "/profile",
        headers=direct_headers,
        json={
            "full_name": "Direct Candidate",
            "portfolio_url": "cpandey.com",
            "additional_links": [{"label": "Blog", "url": "blog.cpandey.com"}],
        },
    )
    assert direct.status_code == 200

    import_headers = auth(client, "import-url@example.com")
    imported = client.post(
        "/profile/import/apply",
        headers=import_headers,
        json=import_payload("cpandey.com/projects"),
    )
    assert imported.status_code == 200

    for headers in (direct_headers, import_headers):
        wire = client.get("/profile", headers=headers).json()["profile"]
        # Signup rows intentionally represent an unanswered sponsorship field as
        # null while the replace schema takes a bool.  The client canonicalizes
        # that unrelated legacy distinction with Boolean(value) before PUT.
        canonical_input = {**wire, "requires_sponsorship": bool(wire["requires_sponsorship"])}
        validated = UserProfileIn.model_validate(canonical_input).model_dump(mode="json")
        assert validated["portfolio_url"].startswith("https://cpandey.com")


def test_get_profile_preserves_legacy_bare_domain_without_repairing_row(
    client: TestClient,
) -> None:
    headers = auth(client)
    db = next(app.dependency_overrides[get_db]())
    try:
        profile = db.scalar(select(UserProfile))
        assert profile is not None
        profile.portfolio_url = "cpandey.com"
        db.commit()
    finally:
        db.close()

    wire = client.get("/profile", headers=headers).json()["profile"]

    assert wire["portfolio_url"] == "cpandey.com"
    assert stored_profile().portfolio_url == "cpandey.com"
    assert (
        UserProfileIn.model_validate(
            {**wire, "requires_sponsorship": bool(wire["requires_sponsorship"])}
        ).model_dump(mode="json")["portfolio_url"]
        == "https://cpandey.com/"
    )


@pytest.mark.parametrize("bad", INVALID_URLS)
def test_canonical_schema_rejects_unsupported_or_malformed_url(bad: str) -> None:
    with pytest.raises(ValidationError):
        UserProfileIn(portfolio_url=bad)
