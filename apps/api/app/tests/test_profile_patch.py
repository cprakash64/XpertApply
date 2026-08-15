"""Regression contract for isolated main-profile PATCH updates."""

from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401
from app.models.entities import UserProfile


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


def auth(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/auth/signup", json={"email": "profile-patch@example.com", "password": "password123"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def put_baseline(client: TestClient, headers: dict[str, str]) -> dict:
    response = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "Patch Candidate",
            "preferred_name": "Patch",
            "portfolio_url": "https://safe.example",
            "target_roles": ["Old Role"],
            "target_levels": ["Senior"],
            "preferred_locations": ["New York, NY"],
            "skills": ["Python"],
            "requires_sponsorship": False,
            "open_to_relocation": False,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["profile"]


def mutate_profile(**values: object) -> None:
    db = next(app.dependency_overrides[get_db]())
    try:
        profile = db.scalar(select(UserProfile))
        assert profile is not None
        for key, value in values.items():
            setattr(profile, key, value)
        db.commit()
    finally:
        db.close()


def stored_profile() -> UserProfile:
    db = next(app.dependency_overrides[get_db]())
    try:
        profile = db.scalar(select(UserProfile))
        assert profile is not None
        db.expunge(profile)
        return profile
    finally:
        db.close()


def test_patch_scalar_changes_only_supplied_field(client: TestClient) -> None:
    headers = auth(client)
    before = put_baseline(client, headers)

    response = client.patch("/profile", headers=headers, json={"preferred_name": "New name"})

    assert response.status_code == 200, response.text
    profile = response.json()["profile"]
    assert profile["preferred_name"] == "New name"
    assert profile["target_roles"] == before["target_roles"]
    assert profile["portfolio_url"] == before["portfolio_url"]


def test_patch_list_replaces_only_that_list(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch(
        "/profile", headers=headers, json={"target_roles": ["Backend Engineer"]}
    )

    assert response.status_code == 200, response.text
    profile = response.json()["profile"]
    assert profile["target_roles"] == ["Backend Engineer"]
    assert profile["target_levels"] == ["Senior"]
    assert profile["preferred_locations"] == ["New York, NY"]
    assert profile["skills"] == ["Python"]


def test_patch_explicit_empty_list_clears_list(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch("/profile", headers=headers, json={"target_roles": []})

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["target_roles"] == []
    assert stored_profile().target_roles == []


def test_patch_explicit_null_clears_nullable_field(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch("/profile", headers=headers, json={"portfolio_url": None})

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["portfolio_url"] is None
    assert stored_profile().portfolio_url is None


@pytest.mark.parametrize(
    ("field", "value"),
    [("target_roles", None), ("skills", None), ("requires_sponsorship", None), ("full_name", None)],
)
def test_patch_rejects_null_for_non_nullable_field(
    client: TestClient, field: str, value: None
) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch("/profile", headers=headers, json={field: value})

    assert response.status_code == 422
    profile = stored_profile()
    assert profile.target_roles == ["Old Role"]
    assert profile.skills == ["Python"]
    assert profile.requires_sponsorship is False
    assert profile.full_name == "Patch Candidate"


def test_patch_updates_multiple_valid_fields_together(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch(
        "/profile",
        headers=headers,
        json={"target_roles": ["Platform Engineer"], "open_to_relocation": True},
    )

    assert response.status_code == 200, response.text
    profile = stored_profile()
    assert profile.target_roles == ["Platform Engineer"]
    assert profile.open_to_relocation is True


def test_legacy_url_and_nullable_sponsorship_do_not_block_preference_patch(
    client: TestClient,
) -> None:
    headers = auth(client)
    put_baseline(client, headers)
    mutate_profile(portfolio_url="cpandey.com", requires_sponsorship=None)

    response = client.patch(
        "/profile",
        headers=headers,
        json={
            "target_roles": ["Backend Engineer"],
            "target_levels": ["Staff"],
            "preferred_locations": ["Remote"],
            "remote_preference": "remote",
        },
    )

    assert response.status_code == 200, response.text
    wire = response.json()["profile"]
    assert wire["target_roles"] == ["Backend Engineer"]
    assert wire["remote_preference"] == "remote"
    assert wire["portfolio_url"] == "cpandey.com"
    assert wire["requires_sponsorship"] is None
    profile = stored_profile()
    assert profile.portfolio_url == "cpandey.com"
    assert profile.requires_sponsorship is None
    assert profile.full_name == "Patch Candidate"


def test_explicit_patch_of_legacy_url_canonicalizes_it(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)
    mutate_profile(portfolio_url="cpandey.com")

    response = client.patch("/profile", headers=headers, json={"portfolio_url": "cpandey.com"})

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["portfolio_url"] == "https://cpandey.com/"
    assert stored_profile().portfolio_url == "https://cpandey.com/"


def test_invalid_explicit_legacy_url_edit_preserves_old_value(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)
    mutate_profile(portfolio_url="cpandey.com")

    response = client.patch(
        "/profile", headers=headers, json={"portfolio_url": "javascript:alert(1)"}
    )

    assert response.status_code == 422
    assert stored_profile().portfolio_url == "cpandey.com"


def test_patch_does_not_overwrite_newer_unrelated_field(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)
    newer = client.patch("/profile", headers=headers, json={"skills": ["Rust"]})
    assert newer.status_code == 200

    response = client.patch(
        "/profile", headers=headers, json={"target_roles": ["Backend Engineer"]}
    )

    assert response.status_code == 200, response.text
    assert response.json()["profile"]["target_roles"] == ["Backend Engineer"]
    assert response.json()["profile"]["skills"] == ["Rust"]


def test_empty_patch_is_a_successful_no_op(client: TestClient) -> None:
    headers = auth(client)
    before = put_baseline(client, headers)

    response = client.patch("/profile", headers=headers, json={})

    assert response.status_code == 200, response.text
    assert response.json()["profile"] == before


def test_patch_rejects_unknown_fields(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch(
        "/profile", headers=headers, json={"totally_unknown_field": "x"}
    )

    assert response.status_code == 422
    assert stored_profile().target_roles == ["Old Role"]


def test_invalid_mixed_patch_is_rejected_before_any_mutation(client: TestClient) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch(
        "/profile",
        headers=headers,
        json={
            "target_roles": ["Backend Engineer"],
            "portfolio_url": "javascript:alert(1)",
        },
    )

    assert response.status_code == 422
    assert any(item["loc"] == ["body", "portfolio_url"] for item in response.json()["detail"])
    profile = stored_profile()
    assert profile.target_roles == ["Old Role"]
    assert profile.portfolio_url == "https://safe.example/"


def test_patch_reports_multiple_validation_errors_with_field_locations(
    client: TestClient,
) -> None:
    headers = auth(client)
    put_baseline(client, headers)

    response = client.patch(
        "/profile",
        headers=headers,
        json={
            "portfolio_url": "javascript:alert(1)",
            "github_url": "file:///tmp/profile",
        },
    )

    assert response.status_code == 422
    locations = {tuple(item["loc"]) for item in response.json()["detail"]}
    assert ("body", "portfolio_url") in locations
    assert ("body", "github_url") in locations
    profile = stored_profile()
    assert profile.portfolio_url == "https://safe.example/"
    assert profile.github_url is None


def test_patch_requires_authentication(client: TestClient) -> None:
    response = client.patch("/profile", json={"target_roles": ["Backend Engineer"]})
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("raw", "expected_status", "stored"),
    [
        ("cpandey.com", 200, "https://cpandey.com/"),
        ("javascript:alert(1)", 422, None),
    ],
)
def test_put_remains_the_strict_canonical_full_write(
    client: TestClient, raw: str, expected_status: int, stored: str | None
) -> None:
    headers = auth(client)

    response = client.put(
        "/profile", headers=headers, json={"full_name": "PUT Candidate", "portfolio_url": raw}
    )

    assert response.status_code == expected_status
    if stored is not None:
        assert response.json()["profile"]["portfolio_url"] == stored
        assert stored_profile().portfolio_url == stored
