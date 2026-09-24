from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.config import settings
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
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


def test_signup_succeeds(client: TestClient) -> None:
    response = client.post(
        "/auth/signup",
        json={"email": "signup@example.com", "password": "password123"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["access_token"]
    assert body["token_type"] == "bearer"


def test_signup_rejects_invalid_email_and_short_password(client: TestClient) -> None:
    invalid_email = client.post(
        "/auth/signup",
        json={"email": "not-an-email", "password": "password123"},
    )
    short_password = client.post(
        "/auth/signup",
        json={"email": "short@example.com", "password": "12345678"},
    )

    assert invalid_email.status_code == 422
    assert invalid_email.json()["detail"][0]["loc"] == ["body", "email"]
    assert short_password.status_code == 422
    assert short_password.json()["detail"][0]["loc"] == ["body", "password"]
    assert short_password.json()["detail"][0]["ctx"]["min_length"] == 10


def test_signup_normalizes_email_and_creates_one_user_and_profile(client: TestClient) -> None:
    response = client.post(
        "/auth/signup",
        json={"email": "  Person@Example.COM  ", "password": "password123"},
    )
    duplicate = client.post(
        "/auth/signup",
        json={"email": "person@example.com", "password": "password123"},
    )

    assert response.status_code == 200
    assert duplicate.status_code == 409
    me = client.get(
        "/auth/me",
        headers={"Authorization": f"Bearer {response.json()['access_token']}"},
    )
    assert me.status_code == 200
    assert me.json()["email"] == "person@example.com"

    override = app.dependency_overrides[get_db]
    db_generator = override()
    db = next(db_generator)
    try:
        assert db.scalar(select(func.count()).select_from(entities.User)) == 1
        assert db.scalar(select(func.count()).select_from(entities.UserProfile)) == 1
    finally:
        db_generator.close()


def test_duplicate_signup_returns_clean_error(client: TestClient) -> None:
    payload = {"email": "duplicate@example.com", "password": "password123"}

    first = client.post("/auth/signup", json=payload)
    second = client.post("/auth/signup", json=payload)

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"] == "Email already registered"


def test_login_succeeds(client: TestClient) -> None:
    payload = {"email": "login@example.com", "password": "password123"}
    client.post("/auth/signup", json=payload)

    response = client.post("/auth/login", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["access_token"]
    assert body["token_type"] == "bearer"


def test_bad_login_returns_401(client: TestClient) -> None:
    client.post(
        "/auth/signup",
        json={"email": "bad-login@example.com", "password": "password123"},
    )

    response = client.post(
        "/auth/login",
        json={"email": "bad-login@example.com", "password": "wrong-password"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid credentials"


def test_me_works_with_token(client: TestClient) -> None:
    signup = client.post(
        "/auth/signup",
        json={"email": "me@example.com", "password": "password123"},
    )
    token = signup.json()["access_token"]

    response = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["email"] == "me@example.com"


def test_me_without_token_returns_401(client: TestClient) -> None:
    response = client.get("/auth/me")

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing token"


def test_me_with_malformed_token_returns_401(client: TestClient) -> None:
    response = client.get("/auth/me", headers={"Authorization": "Bearer malformed-token"})

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token"


def test_me_with_expired_token_returns_401(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "jwt_expires_minutes", -1)
    signup = client.post(
        "/auth/signup",
        json={"email": "expired@example.com", "password": "password123"},
    )

    response = client.get(
        "/auth/me",
        headers={"Authorization": f"Bearer {signup.json()['access_token']}"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token"
