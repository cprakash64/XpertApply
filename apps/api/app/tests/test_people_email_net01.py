# ruff: noqa: F811
"""NET-01: work-email discovery behaviour against a faked Hunter HTTP surface.

Every provider answer here is synthetic. These tests prove XpertApply's own
handling of Hunter's documented responses; they are not evidence that a real
Hunter account is configured or working in production.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.entities import User
from app.people import providers, service
from app.people.service import find_email
from app.tests.test_people_recommendations import (  # noqa: F401  (db is a fixture)
    _persist_recommendation,
    db,
)

DOMAIN = "acme.example"
GOOD = f"rita.recruiter@{DOMAIN}"


class FakeHunter:
    """Replaces httpx.AsyncClient inside providers.py with scripted responses."""

    def __init__(self, finder, verifier) -> None:
        self.finder = finder
        self.verifier = verifier
        self.calls: list[tuple[str, dict]] = []

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        outer = self

        class Client:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def request(self, method, url, **kwargs):
                path = "finder" if "email-finder" in url else "verifier"
                outer.calls.append((path, dict(kwargs.get("params") or {})))
                scripted = outer.finder if path == "finder" else outer.verifier
                if isinstance(scripted, Exception):
                    raise scripted
                status, body = scripted
                return httpx.Response(
                    status, json=body, request=httpx.Request(method, url)
                )

        monkeypatch.setattr(providers.httpx, "AsyncClient", Client)

    def count(self, kind: str) -> int:
        return sum(1 for k, _ in self.calls if k == kind)


@pytest.fixture(autouse=True)
def _hunter_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "people_email_discovery_enabled", True)
    monkeypatch.setattr(settings, "hunter_api_key", "synthetic-test-key")
    monkeypatch.setattr(settings, "people_email_daily_credit_budget", 50)
    monkeypatch.setattr(settings, "people_email_per_user_daily_limit", 20)
    monkeypatch.setattr(settings, "people_email_rate_limit_per_hour", 100)


def _run(db: Session, user, job, recommendation) -> dict:
    return asyncio.run(find_email(db, user, job.id, recommendation.id))


def _found(email: str | None = GOOD):
    return 200, {"data": {"email": email, "score": 91}}


def test_verified_email_is_returned_when_hunter_uses_the_current_status_field(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    # Hunter documents `result` as deprecated in favour of `status`.
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid", "email": GOOD}}))
    fake.install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "verified"
    assert out["professional_email"] == GOOD


def test_deprecated_result_field_still_verifies(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(_found(), (200, {"data": {"result": "deliverable"}}))
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["status"] == "verified"


@pytest.mark.parametrize(
    "body,expected",
    [
        ({"status": "accept_all"}, "accept_all"),
        ({"status": "invalid"}, "not_found"),
        ({"status": "webmail"}, "risky"),
        ({"status": "disposable"}, "risky"),
        ({"status": "unknown"}, "unknown"),
        ({}, "unknown"),
    ],
)
def test_non_deliverable_statuses_never_show_an_email(
    db: Session, monkeypatch: pytest.MonkeyPatch, body, expected
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(_found(), (200, {"data": body})).install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == expected
    assert out["professional_email"] is None


@pytest.mark.parametrize("code", [202, 222])
def test_in_progress_verification_is_retryable_and_not_cached(
    db: Session, monkeypatch: pytest.MonkeyPatch, code: int
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(_found(), (code, {"data": {}}))
    fake.install(monkeypatch)
    first = _run(db, user, job, rec)
    assert first["status"] == "provider_unavailable"
    assert person.email_verification_status == "not_requested"
    # A later success must be possible: nothing may have been cached as final.
    fake.verifier = (200, {"data": {"status": "valid"}})
    second = _run(db, user, job, rec)
    assert second["status"] == "verified"
    assert second["professional_email"] == GOOD


def test_claimed_email_451_is_a_permanent_do_not_process(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter((451, {"errors": [{"id": "claimed_email"}]}), _found())
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["status"] == "not_found"
    assert _run(db, user, job, rec)["status"] == "not_found"
    assert fake.count("finder") == 1  # not asked again for the cache window


@pytest.mark.parametrize(
    "scripted,expected",
    [
        ((401, {"errors": [{"id": "authentication_failed"}]}), "provider_error"),
        ((403, {"errors": []}), "rate_limited"),  # Hunter: 403 = request rate limit
        ((503, {}), "provider_unavailable"),
        (httpx.RemoteProtocolError("boom"), "provider_unavailable"),
        (httpx.ReadTimeout("slow"), "provider_unavailable"),
    ],
)
def test_provider_failures_are_recoverable_and_never_persisted(
    db: Session, monkeypatch: pytest.MonkeyPatch, scripted, expected
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(scripted, _found())
    fake.install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == expected
    assert out["professional_email"] is None
    # Transient failures are about the provider, not about this person.
    assert person.email_verification_status == "not_requested"
    assert person.professional_email_ciphertext is None
    # ...so a later attempt really is made.
    fake.finder = _found()
    fake.verifier = (200, {"data": {"status": "valid"}})
    assert _run(db, user, job, rec)["status"] == "verified"


def test_missing_provider_key_is_a_clean_unavailable_state(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    monkeypatch.setattr(settings, "hunter_api_key", None)
    fake = FakeHunter(_found(), _found())
    fake.install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "provider_error"
    assert fake.calls == []


def test_no_email_found_is_cached_and_costs_one_request(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(_found(None), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["status"] == "not_found"
    assert _run(db, user, job, rec)["status"] == "not_found"
    assert fake.count("finder") == 1
    assert fake.count("verifier") == 0


def test_address_on_another_domain_is_never_trusted(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(_found("someone@gmail.com"), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "not_found"
    assert out["professional_email"] is None
    assert fake.count("verifier") == 0


def test_verified_result_is_reused_without_new_provider_calls(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    for _ in range(3):
        assert _run(db, user, job, rec)["professional_email"] == GOOD
    assert fake.count("finder") == 1
    assert fake.count("verifier") == 1


def test_name_is_cleaned_before_it_reaches_the_finder(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    person.canonical_full_name = "Dr. Rita M. Recruiter, PhD"
    db.commit()
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    _run(db, user, job, rec)
    params = next(p for k, p in fake.calls if k == "finder")
    assert (params["first_name"], params["last_name"]) == ("Rita", "Recruiter")


@pytest.mark.parametrize("name", ["Madonna", "", "   ", "Dr. PhD", "J. K."])
def test_unusable_names_are_not_sent_to_the_provider(
    db: Session, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    person.canonical_full_name = name
    db.commit()
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "identity_uncertain"
    assert fake.calls == []
    assert person.email_verification_status == "not_requested"


def test_another_users_recommendation_is_not_reachable(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    intruder = User(email="intruder@example.com", hashed_password="x")
    db.add(intruder)
    db.commit()
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(find_email(db, intruder, job.id, rec.id))
    assert exc.value.status_code == 404
    assert fake.calls == []


def test_disabled_flag_makes_no_provider_call(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    monkeypatch.setattr(settings, "people_email_discovery_enabled", False)
    fake = FakeHunter(_found(), _found())
    fake.install(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        _run(db, user, job, rec)
    assert exc.value.status_code == 404
    assert fake.calls == []


def test_legacy_transient_status_is_not_shown_as_a_final_state(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    person.email_verification_status = "rate_limited"
    db.commit()
    monkeypatch.setattr(settings, "people_recommendations_enabled", True)
    monkeypatch.setattr(settings, "people_rollout_mode", "all")
    payload = service.recommendations_payload(db, user, job.id)
    shown = [p for items in payload["categories"].values() for p in items]
    assert shown and shown[0]["email_status"] == "not_requested"


def test_suppression_451_purges_a_previously_stored_address(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["professional_email"] == GOOD
    assert person.professional_email_ciphertext is not None
    # The cache window passes and Hunter now reports the address as claimed.
    person.email_verified_at = person.email_verified_at.replace(year=2000)
    db.commit()
    fake.finder = (451, {"errors": [{"id": "claimed_email"}]})
    out = _run(db, user, job, rec)
    assert out["status"] == "not_found"
    assert out["professional_email"] is None
    db.refresh(person)
    assert person.professional_email_ciphertext is None
    assert person.professional_email_hash is None


def test_verifier_451_also_clears_and_never_shows_the_address(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(_found(), (451, {"errors": [{"id": "claimed_email"}]})).install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "not_found"
    assert out["professional_email"] is None
    assert person.professional_email_ciphertext is None


def test_quota_exhaustion_is_not_reported_as_a_retryable_rate_limit(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter((429, {"errors": [{"id": "usage_limit"}]}), _found())
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["status"] == "budget_exceeded"
    assert person.email_verification_status == "not_requested"
    # The budget circuit now holds paid calls; a retry must not reach Hunter.
    before = fake.count("finder")
    _run(db, user, job, rec)
    assert fake.count("finder") == before


def test_cached_results_are_marked_cached_and_fresh_ones_are_not(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(_found(None), _found()).install(monkeypatch)
    assert _run(db, user, job, rec)["cached"] is False
    assert _run(db, user, job, rec)["cached"] is True


def test_unrecognised_verifier_status_is_unknown_and_hidden(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(_found(), (200, {"data": {"status": "brand_new_value"}})).install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "unknown"
    assert out["professional_email"] is None


def test_unparseable_provider_body_is_a_recoverable_state(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    FakeHunter((200, ["not", "an", "object"]), _found()).install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] in {"provider_unavailable", "provider_error", "not_found"}
    assert out["professional_email"] is None


def test_credit_spent_before_a_verifier_failure_counts_against_the_budget(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy import func, select

    from app.models.entities import PeopleDiscoveryRun

    user, job, person, rec = _persist_recommendation(db)
    monkeypatch.setattr(settings, "people_email_daily_credit_budget", 3)
    fake = FakeHunter(_found(), (503, {}))
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["status"] == "provider_unavailable"
    used = db.scalar(select(func.sum(PeopleDiscoveryRun.provider_credits_used)).where(PeopleDiscoveryRun.provider == "hunter"))
    assert used == 1
    # Repeated retries are bounded by the budget instead of repeating the paid finder forever.
    for _ in range(6):
        _run(db, user, job, rec)
    assert fake.count("finder") <= 3
    assert _run(db, user, job, rec)["status"] == "budget_exceeded"


def test_inferred_pattern_address_is_never_shown_and_never_verified(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter(
        (200, {"data": {"email": GOOD, "score": 90, "provenance": "inferred"}}),
        (200, {"data": {"status": "valid"}}),
    )
    fake.install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "not_found"
    assert out["professional_email"] is None
    assert fake.count("verifier") == 0


def test_sourced_address_with_found_provenance_is_still_verified(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(
        (200, {"data": {"email": GOOD, "provenance": "found"}}),
        (200, {"data": {"status": "valid"}}),
    ).install(monkeypatch)
    assert _run(db, user, job, rec)["professional_email"] == GOOD


@pytest.mark.parametrize("scripted", [(503, {}), (200, {"data": {"status": "valid"}})])
def test_the_provider_key_never_reaches_the_logs(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, scripted
) -> None:
    import logging

    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(_found(), scripted).install(monkeypatch)
    with caplog.at_level(logging.DEBUG):
        _run(db, user, job, rec)
    assert "synthetic-test-key" not in caplog.text
    assert GOOD not in caplog.text
