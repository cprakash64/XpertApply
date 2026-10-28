"""Password recovery, end to end through the real routes.

Email goes through the real ``outbox`` backend (a file per message) or, in the
SMTP tests, through the real SMTP client to a local sink socket; nothing here
replaces the delivery code with a mock, except the one test that injects a
delivery FAILURE on purpose.
"""

from __future__ import annotations

import email as emaillib
import logging
import re
import socketserver
import threading
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core import config_validation
from app.core.config import settings
from app.core.email import EmailDeliveryError, send_email
from app.core.security import ALGORITHM, create_access_token
from app.db.base import Base
from app.main import app
from app.models import entities
from app.services import password_reset as recovery

ORIGIN = "https://app.example.test"
PASSWORD = "correct horse battery"
NEW_PASSWORD = "a brand new passphrase"


@pytest.fixture()
def outbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "email_backend", "outbox")
    monkeypatch.setattr(settings, "email_outbox_dir", str(tmp_path / "outbox"))
    monkeypatch.setattr(settings, "web_base_url", ORIGIN)
    monkeypatch.setattr(settings, "password_reset_token_ttl_minutes", 30)
    return tmp_path / "outbox"


@pytest.fixture()
def session_factory() -> Generator[sessionmaker[Session], None, None]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override() -> Generator[Session, None, None]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    try:
        yield factory
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client(session_factory, outbox) -> TestClient:  # noqa: ARG001
    return TestClient(app)


def signup(client: TestClient, address: str = "ada@example.com") -> str:
    response = client.post("/auth/signup", json={"email": address, "password": PASSWORD})
    assert response.status_code == 200
    return response.json()["access_token"]


def mails(outbox: Path) -> list[emaillib.message.Message]:
    if not outbox.exists():
        return []
    return [emaillib.message_from_bytes(path.read_bytes()) for path in sorted(outbox.glob("*.eml"))]


def body_of(message) -> str:
    part = message.get_body(preferencelist=("plain",)) if hasattr(message, "get_body") else None
    return (
        (part or message).get_payload(decode=True).decode()
        if not message.is_multipart()
        else message.get_payload()[0].get_payload(decode=True).decode()
    )


def token_from(message) -> str:
    match = re.search(r"/reset-password#token=([A-Za-z0-9_\-]+)", body_of(message))
    assert match, body_of(message)
    return match.group(1)


def request_reset(client: TestClient, address: str):
    return client.post("/auth/password-reset/request", json={"email": address})


# --------------------------------------------------------------------------- #
# availability: the feature never pretends
# --------------------------------------------------------------------------- #
def test_recovery_reports_itself_unavailable_without_a_delivery_path(client, monkeypatch) -> None:
    monkeypatch.setattr(settings, "email_backend", "disabled")
    assert client.get("/auth/password-reset/availability").json() == {"available": False}
    response = request_reset(client, "ada@example.com")
    assert response.status_code == 503
    assert "not available" in response.json()["detail"]


def test_smtp_backend_without_a_host_is_not_available(monkeypatch) -> None:
    monkeypatch.setattr(settings, "email_backend", "smtp")
    monkeypatch.setattr(settings, "smtp_host", None)
    assert settings.password_reset_available is False
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
    assert settings.password_reset_available is True


# --------------------------------------------------------------------------- #
# request: generic answers, real email
# --------------------------------------------------------------------------- #
def test_existing_account_gets_one_email_with_a_fragment_link(client, outbox) -> None:
    signup(client)
    response = request_reset(client, "Ada@Example.com")
    assert response.status_code == 202
    sent = mails(outbox)
    assert len(sent) == 1
    assert sent[0]["To"] == "ada@example.com"
    assert sent[0]["Auto-Submitted"] == "auto-generated"
    text = body_of(sent[0])
    assert f"{ORIGIN}/reset-password#token=" in text
    assert "?token=" not in text  # never in the query string
    assert "30 minutes" in text
    assert PASSWORD not in text


def test_unknown_account_gets_the_identical_response_and_no_email(client, outbox) -> None:
    signup(client)
    known = request_reset(client, "ada@example.com")
    unknown = request_reset(client, "nobody@example.com")
    assert (unknown.status_code, unknown.json()) == (known.status_code, known.json())
    assert [m["To"] for m in mails(outbox)] == ["ada@example.com"]


def test_invalid_email_format_is_a_validation_error_not_an_oracle(client) -> None:
    assert request_reset(client, "not-an-email").status_code == 422


def test_link_origin_comes_from_configuration_never_the_host_header(client, outbox) -> None:
    signup(client)
    client.post(
        "/auth/password-reset/request",
        json={"email": "ada@example.com"},
        headers={"Host": "evil.test", "X-Forwarded-Host": "evil.test", "Origin": "https://evil.test"},
    )
    text = body_of(mails(outbox)[0])
    assert ORIGIN in text and "evil.test" not in text


def test_token_is_random_stored_only_as_a_hash_and_expires(client, outbox, session_factory) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    assert len(token) >= 43  # 256 bits, url-safe
    with session_factory() as db:
        rows = db.scalars(select(entities.PasswordResetToken)).all()
        assert len(rows) == 1
        assert token not in rows[0].token_hash and rows[0].token_hash == recovery.hash_token(token)
        remaining = recovery.aware(rows[0].expires_at) - datetime.now(UTC)
        assert timedelta(minutes=29) < remaining <= timedelta(minutes=30)


def test_a_new_request_supersedes_the_earlier_link(client, outbox) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    request_reset(client, "ada@example.com")
    first, second = (token_from(m) for m in mails(outbox))
    assert first != second
    assert client.post("/auth/password-reset/verify", json={"token": first}).json() == {"valid": False}
    assert client.post("/auth/password-reset/verify", json={"token": second}).json() == {"valid": True}


def test_provider_only_account_gets_a_note_and_no_token(client, outbox, session_factory) -> None:
    with session_factory() as db:
        db.add(entities.User(email="google@example.com", hashed_password=None))
        db.commit()
    assert request_reset(client, "google@example.com").status_code == 202
    sent = mails(outbox)
    assert len(sent) == 1
    assert "reset-password" not in body_of(sent[0]) and "Google" in body_of(sent[0])
    with session_factory() as db:
        assert db.scalars(select(entities.PasswordResetToken)).all() == []


# --------------------------------------------------------------------------- #
# abuse protection
# --------------------------------------------------------------------------- #
def test_per_recipient_rate_limit_is_identical_for_known_and_unknown(client, outbox) -> None:
    signup(client)
    for address in ("ada@example.com", "nobody@example.com"):
        statuses = [request_reset(client, address).status_code for _ in range(4)]
        assert statuses == [202, 202, 202, 429]
    limited = request_reset(client, "ada@example.com")
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) >= 1
    assert len(mails(outbox)) == 3  # the cap also stops mail-bombing the account owner


def test_per_client_rate_limit(client, monkeypatch) -> None:
    monkeypatch.setattr(settings, "password_reset_per_client_hourly_limit", 5)
    codes = [request_reset(client, f"user{i}@example.com").status_code for i in range(7)]
    assert codes == [202] * 5 + [429] * 2


# --------------------------------------------------------------------------- #
# confirm: tokens and passwords
# --------------------------------------------------------------------------- #
def test_full_reset_changes_the_password_and_does_not_log_in(client, outbox) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    response = client.post("/auth/password-reset/confirm", json={"token": token, "new_password": NEW_PASSWORD})
    assert response.status_code == 200
    assert response.json() == {"status": "password_updated"}  # no access_token: no auto-login
    assert client.post("/auth/login", json={"email": "ada@example.com", "password": PASSWORD}).status_code == 401
    login = client.post("/auth/login", json={"email": "ada@example.com", "password": NEW_PASSWORD})
    assert login.status_code == 200 and login.json()["access_token"]


def test_a_token_works_exactly_once(client, outbox) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    assert (
        client.post("/auth/password-reset/confirm", json={"token": token, "new_password": NEW_PASSWORD}).status_code
        == 200
    )
    reuse = client.post("/auth/password-reset/confirm", json={"token": token, "new_password": "another passphrase 1"})
    assert reuse.status_code == 400
    assert client.post("/auth/login", json={"email": "ada@example.com", "password": NEW_PASSWORD}).status_code == 200
    assert client.post("/auth/password-reset/verify", json={"token": token}).json() == {"valid": False}


def test_expired_unknown_and_garbled_tokens_get_the_same_clear_error(client, outbox, session_factory) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    with session_factory() as db:
        row = db.scalars(select(entities.PasswordResetToken)).one()
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    errors = {
        client.post("/auth/password-reset/confirm", json={"token": candidate, "new_password": NEW_PASSWORD}).json()[
            "detail"
        ]
        for candidate in (token, "x" * 43, "not-a-real-token-but-long-enough-1234")
    }
    assert errors == {"This reset link is invalid or has expired. Request a new one."}
    assert client.post("/auth/login", json={"email": "ada@example.com", "password": PASSWORD}).status_code == 200


@pytest.mark.parametrize("weak", ["short", "123456789", ""])
def test_weak_password_is_refused_and_the_token_survives(client, outbox, weak) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    assert client.post("/auth/password-reset/confirm", json={"token": token, "new_password": weak}).status_code == 422
    assert client.post("/auth/password-reset/verify", json={"token": token}).json() == {"valid": True}


def test_password_equal_to_the_email_is_refused_and_the_token_survives(client, outbox) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    refused = client.post("/auth/password-reset/confirm", json={"token": token, "new_password": "ada@example.com"})
    assert refused.status_code == 422
    assert client.post("/auth/password-reset/verify", json={"token": token}).json() == {"valid": True}


def test_longest_allowed_password_is_accepted(client, outbox) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    long_password = "p" * 128
    assert (
        client.post("/auth/password-reset/confirm", json={"token": token, "new_password": long_password}).status_code
        == 200
    )
    assert client.post("/auth/login", json={"email": "ada@example.com", "password": long_password}).status_code == 200


def test_verify_does_not_consume_the_token(client, outbox) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    for _ in range(3):
        assert client.post("/auth/password-reset/verify", json={"token": token}).json() == {"valid": True}
    assert (
        client.post("/auth/password-reset/confirm", json={"token": token, "new_password": NEW_PASSWORD}).status_code
        == 200
    )


def test_confirm_attempts_are_rate_limited(client) -> None:
    codes = [
        client.post(
            "/auth/password-reset/confirm", json={"token": f"{i:044d}", "new_password": NEW_PASSWORD}
        ).status_code
        for i in range(22)
    ]
    assert codes[:20] == [400] * 20 and codes[20:] == [429, 429]


# --------------------------------------------------------------------------- #
# sessions
# --------------------------------------------------------------------------- #
def test_reset_revokes_sessions_issued_before_it(client, outbox) -> None:
    old_token = signup(client)
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {old_token}"}).status_code == 200
    request_reset(client, "ada@example.com")
    token = token_from(mails(outbox)[0])
    client.post("/auth/password-reset/confirm", json={"token": token, "new_password": NEW_PASSWORD})
    stale = client.get("/auth/me", headers={"Authorization": f"Bearer {old_token}"})
    assert stale.status_code == 401
    fresh = client.post("/auth/login", json={"email": "ada@example.com", "password": NEW_PASSWORD}).json()[
        "access_token"
    ]
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {fresh}"}).status_code == 200


def test_tokens_without_iat_are_refused_only_after_a_password_change(client, outbox, session_factory) -> None:
    signup(client)
    with session_factory() as db:
        user_id = db.scalars(select(entities.User)).one().id
    legacy = jwt.encode(
        {"sub": str(user_id), "exp": datetime.now(UTC) + timedelta(hours=1)}, settings.secret_key, algorithm=ALGORITHM
    )
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {legacy}"}).status_code == 200  # never changed
    request_reset(client, "ada@example.com")
    client.post(
        "/auth/password-reset/confirm", json={"token": token_from(mails(outbox)[0]), "new_password": NEW_PASSWORD}
    )
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {legacy}"}).status_code == 401


def test_a_login_in_the_same_second_as_the_reset_is_not_rejected(client, outbox, session_factory) -> None:
    signup(client)
    request_reset(client, "ada@example.com")
    client.post(
        "/auth/password-reset/confirm", json={"token": token_from(mails(outbox)[0]), "new_password": NEW_PASSWORD}
    )
    with session_factory() as db:
        user_id = db.scalars(select(entities.User)).one().id
    assert (
        client.get("/auth/me", headers={"Authorization": f"Bearer {create_access_token(str(user_id))}"}).status_code
        == 200
    )


# --------------------------------------------------------------------------- #
# delivery failure and logging
# --------------------------------------------------------------------------- #
def test_delivery_failure_does_not_change_the_response_or_leak(client, monkeypatch, caplog) -> None:
    signup(client)

    def boom(**_kwargs):
        raise EmailDeliveryError("SMTP delivery failed (ConnectionRefusedError).")

    monkeypatch.setattr(recovery, "send_email", boom)
    with caplog.at_level(logging.INFO):
        response = request_reset(client, "ada@example.com")
    assert response.status_code == 202 and response.json()["status"] == "accepted"
    assert any("recovery email failed" in r.getMessage() for r in caplog.records)
    assert "ada@example.com" not in caplog.text


def test_logs_never_contain_the_token_the_password_or_the_address(client, outbox, caplog) -> None:
    signup(client)
    with caplog.at_level(logging.DEBUG):
        request_reset(client, "ada@example.com")
        token = token_from(mails(outbox)[0])
        client.post("/auth/password-reset/confirm", json={"token": token, "new_password": NEW_PASSWORD})
    for secret in (token, NEW_PASSWORD, "ada@example.com"):
        assert secret not in caplog.text


# --------------------------------------------------------------------------- #
# real SMTP against a local sink
# --------------------------------------------------------------------------- #
class _SinkHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        def reply(line: str) -> None:
            self.wfile.write((line + "\r\n").encode())

        reply("220 sink ESMTP")
        data_mode, lines, rcpt = False, [], []
        for raw in self.rfile:
            line = raw.decode(errors="replace").rstrip("\r\n")
            if data_mode:
                if line == ".":
                    data_mode = False
                    self.server.messages.append(("\n".join(lines), list(rcpt)))  # type: ignore[attr-defined]
                    reply("250 queued")
                else:
                    lines.append(line[1:] if line.startswith("..") else line)
                continue
            verb = line.split(" ", 1)[0].upper()
            if verb in {"EHLO", "HELO"}:
                reply("250 sink")
            elif verb == "MAIL":
                reply("250 ok")
            elif verb == "RCPT":
                rcpt.append(line)
                reply("250 ok")
            elif verb == "DATA":
                data_mode, lines = True, []
                reply("354 go")
            elif verb == "QUIT":
                reply("221 bye")
                return
            else:
                reply("250 ok")


class _Sink(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    messages: list[tuple[str, list[str]]]


@pytest.fixture()
def smtp_sink(monkeypatch: pytest.MonkeyPatch) -> Generator[_Sink, None, None]:
    server = _Sink(("127.0.0.1", 0), _SinkHandler)
    server.messages = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(settings, "email_backend", "smtp")
    monkeypatch.setattr(settings, "smtp_host", "127.0.0.1")
    monkeypatch.setattr(settings, "smtp_port", server.server_address[1])
    monkeypatch.setattr(settings, "smtp_security", "none")
    monkeypatch.setattr(settings, "smtp_username", None)
    monkeypatch.setattr(settings, "web_base_url", ORIGIN)
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def test_real_smtp_delivery_reaches_the_sink(smtp_sink, session_factory) -> None:  # noqa: ARG001
    client = TestClient(app)
    signup(client)
    assert request_reset(client, "ada@example.com").status_code == 202
    assert len(smtp_sink.messages) == 1
    raw, recipients = smtp_sink.messages[0]
    assert "ada@example.com" in recipients[0]
    message = emaillib.message_from_string(raw)
    assert message["Subject"] == "Reset your XpertApply password"
    assert f"{ORIGIN}/reset-password#token=" in raw.replace("=\n", "")


def test_smtp_failure_is_a_typed_error_and_the_request_still_answers_generically(
    monkeypatch,
    session_factory,  # noqa: ARG001
) -> None:
    monkeypatch.setattr(settings, "email_backend", "smtp")
    monkeypatch.setattr(settings, "smtp_host", "127.0.0.1")
    monkeypatch.setattr(settings, "smtp_port", 1)  # nothing listens here
    monkeypatch.setattr(settings, "smtp_security", "none")
    monkeypatch.setattr(settings, "smtp_timeout_seconds", 2)
    with pytest.raises(EmailDeliveryError):
        send_email(to="a@example.com", subject="s", text="t")
    client = TestClient(app)
    signup(client)
    response = request_reset(client, "ada@example.com")
    assert response.status_code == 202


def test_header_injection_in_recipient_is_refused() -> None:
    with pytest.raises(EmailDeliveryError):
        send_email(to="a@example.com\r\nBcc: x@example.com", subject="s", text="t")


# --------------------------------------------------------------------------- #
# production configuration
# --------------------------------------------------------------------------- #
class _Cfg:
    def __init__(self, **values) -> None:
        self.__dict__.update(
            dict(
                email_backend="smtp",
                smtp_host="smtp.example.com",
                smtp_security="starttls",
                email_from="XpertApply <no-reply@example.com>",
                web_base_url="https://app.example.com",
            )
            | values
        )


def _names(cfg: _Cfg) -> set[str]:
    return {f.setting for f in config_validation._check_email_recovery(cfg)}


def test_production_accepts_a_proper_recovery_configuration_and_disabled() -> None:
    assert _names(_Cfg()) == set()
    assert _names(_Cfg(email_backend="disabled", web_base_url="http://localhost:3000")) == set()


@pytest.mark.parametrize(
    "overrides,expected",
    [
        ({"email_backend": "outbox"}, {"EMAIL_BACKEND"}),
        ({"smtp_host": ""}, {"SMTP_HOST"}),
        ({"smtp_security": "none"}, {"SMTP_SECURITY"}),
        ({"email_from": "no-reply@localhost"}, {"EMAIL_FROM"}),
        ({"web_base_url": "http://app.example.com"}, {"WEB_BASE_URL"}),
        ({"web_base_url": "https://app.example.com/login"}, {"WEB_BASE_URL"}),
        ({"web_base_url": "https://localhost"}, {"WEB_BASE_URL"}),
    ],
)
def test_production_refuses_unsafe_recovery_configuration(overrides, expected) -> None:
    assert _names(_Cfg(**overrides)) == expected
