# ruff: noqa: F811
"""NET-01: work-email discovery behaviour against a faked Hunter HTTP surface.

Every provider answer here is synthetic. These tests prove XpertApply's own
handling of Hunter's documented responses; they are not evidence that a real
Hunter account is configured or working in production.
"""

from __future__ import annotations

import asyncio
import json

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
        self.timeouts: dict[str, object] = {}

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        outer = self

        class Client:
            def __init__(self, *args, **kwargs) -> None:
                self.timeout = kwargs.get("timeout")

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def request(self, method, url, **kwargs):
                path = "finder" if "email-finder" in url else "verifier"
                outer.calls.append((path, dict(kwargs.get("params") or {})))
                outer.timeouts[path] = self.timeout
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


# ---- production limit semantics (NET-PROD-01): what the numbers actually mean ----------------------------------------
def _expire_cache(db: Session, person) -> None:
    from datetime import UTC, datetime, timedelta

    person.email_verified_at = datetime.now(UTC) - timedelta(days=settings.people_email_result_ttl_days + 1)
    db.commit()


def test_per_user_daily_limit_counts_credits_so_two_means_one_found_lookup(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    monkeypatch.setattr(settings, "people_email_per_user_daily_limit", 2)
    monkeypatch.setattr(settings, "people_email_daily_credit_budget", 5)
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["status"] == "verified"  # finder + verifier = 2 credits counted
    _expire_cache(db, person)
    assert _run(db, user, job, rec)["status"] == "budget_exceeded"
    assert fake.count("finder") == 1


def test_per_user_daily_limit_of_three_allows_exactly_two_found_lookups(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    monkeypatch.setattr(settings, "people_email_per_user_daily_limit", 3)
    monkeypatch.setattr(settings, "people_email_daily_credit_budget", 0)
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    statuses = []
    for _ in range(3):
        statuses.append(_run(db, user, job, rec)["status"])
        _expire_cache(db, person)
    assert statuses == ["verified", "verified", "budget_exceeded"]
    assert fake.count("finder") == 2


def test_global_daily_budget_of_five_stops_after_at_most_three_found_lookups(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    monkeypatch.setattr(settings, "people_email_per_user_daily_limit", 0)
    monkeypatch.setattr(settings, "people_email_daily_credit_budget", 5)
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    statuses = []
    for _ in range(5):
        statuses.append(_run(db, user, job, rec)["status"])
        _expire_cache(db, person)
    # The check runs before each call, so the budget can be overshot by one lookup (6 counted, ~4.5 real credits).
    assert statuses == ["verified", "verified", "verified", "budget_exceeded", "budget_exceeded"]
    assert fake.count("finder") == 3


def test_hourly_limit_of_two_blocks_the_third_uncached_attempt(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    service._RATE_BUCKETS.clear()
    monkeypatch.setattr(settings, "people_email_rate_limit_per_hour", 2)
    fake = FakeHunter((503, {}), _found())
    fake.install(monkeypatch)
    first = _run(db, user, job, rec)["status"]
    second = _run(db, user, job, rec)["status"]
    third = _run(db, user, job, rec)["status"]
    assert (first, second) == ("provider_unavailable", "provider_unavailable")
    assert third == "rate_limited"
    assert fake.count("finder") <= 2
    service._RATE_BUCKETS.clear()


def test_cached_answers_do_not_consume_the_hourly_allowance(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    service._RATE_BUCKETS.clear()
    monkeypatch.setattr(settings, "people_email_rate_limit_per_hour", 2)
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    results = [_run(db, user, job, rec)["status"] for _ in range(6)]
    assert results == ["verified"] * 6
    assert fake.count("finder") == 1
    service._RATE_BUCKETS.clear()


def test_email_route_is_closed_to_users_outside_the_internal_rollout_and_open_to_the_listed_one(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi.testclient import TestClient

    from app.core.security import create_access_token, hash_password
    from app.main import app

    user, job, person, rec = _persist_recommendation(db)
    outsider = User(email="outsider@example.com", hashed_password=hash_password("password123"))
    db.add(outsider)
    db.commit()
    monkeypatch.setattr(settings, "people_recommendations_enabled", True)
    monkeypatch.setattr(settings, "people_rollout_mode", "internal")
    monkeypatch.setattr(settings, "people_internal_emails", [user.email])
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    client = TestClient(app)
    out_headers = {"Authorization": f"Bearer {create_access_token(str(outsider.id))}"}
    in_headers = {"Authorization": f"Bearer {create_access_token(str(user.id))}"}
    path = f"/jobs/{job.id}/people/{rec.id}/email"

    assert client.post(path).status_code == 401                       # unauthenticated
    assert client.post(path, headers=out_headers).status_code == 404  # authenticated but outside the rollout
    assert fake.calls == []                                           # no provider request, no credit
    ok = client.post(path, headers=in_headers)
    assert ok.status_code == 200 and ok.json()["status"] == "verified"
    assert fake.count("finder") == 1


# ---- NET-PROD-04: the production "temporarily unavailable" with no Hunter usage ---------------------------------------------
def test_client_timeouts_outlast_hunters_documented_processing_windows(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Hunter's finder may work for its default 10 s and the verifier for up to 20 s before it answers (202). The generic 8 s
    provider timeout cut both off, which the service reported as 'provider_unavailable' while Hunter recorded no usage."""
    user, job, person, rec = _persist_recommendation(db)
    monkeypatch.setattr(settings, "people_provider_timeout_seconds", 8.0)
    fake = FakeHunter(_found(), (200, {"data": {"status": "valid"}}))
    fake.install(monkeypatch)
    _run(db, user, job, rec)
    finder, verifier = fake.timeouts["finder"], fake.timeouts["verifier"]
    assert finder.read >= 12.0 and verifier.read >= 22.0
    # Only the READ phase waits longer; connecting, writing and pool acquisition keep the existing safe limit.
    for t in (finder, verifier):
        assert (t.connect, t.write, t.pool) == (8.0, 8.0, 8.0)


def test_a_hunter_400_is_a_rejected_request_not_a_temporary_outage(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    fake = FakeHunter((400, {"errors": [{"id": "invalid_domain"}]}), _found())
    fake.install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "provider_error"        # not "provider_unavailable": retrying the same request cannot help
    assert out["professional_email"] is None
    assert person.email_verification_status == "not_requested"


@pytest.mark.parametrize(
    "finder,verifier,stage,reason,attempts,status",
    [
        (httpx.ReadTimeout("slow"), (200, {"data": {"status": "valid"}}), "finder", "provider_timeout", 1, None),
        (_found(), httpx.ReadTimeout("slow"), "verifier", "provider_timeout", 2, None),
        ((503, {}), _found(), "finder", "provider_unavailable", 1, 503),
        (_found(), (202, {"data": {}}), "verifier", "provider_unavailable", 2, 202),
        ((400, {"errors": [{"id": "wrong_params"}]}), _found(), "finder", "provider_request_invalid", 1, 400),
    ],
)
def test_a_failed_lookup_logs_only_stage_status_code_and_attempts(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, finder, verifier, stage, reason, attempts, status
) -> None:
    import logging

    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(finder, verifier).install(monkeypatch)
    with caplog.at_level(logging.WARNING):
        _run(db, user, job, rec)
    lines = [r.getMessage() for r in caplog.records if "people_email_lookup_failed" in r.getMessage()]
    assert len(lines) == 1, caplog.text
    line = lines[0]
    assert f"stage={stage}" in line and f"reason={reason}" in line and f"attempts={attempts}" in line
    assert f"http_status={status if status is not None else 'none'}" in line
    for secret in ("synthetic-test-key", GOOD, DOMAIN, person.canonical_full_name, "Rita"):
        assert secret not in caplog.text


# ---- delayed provider responses over a real socket, so httpx's own read timeout is what is being exercised --------------------
class _SlowHunter:
    """A tiny local HTTP server standing in for api.hunter.io, with per-endpoint delays. Counts the requests it receives."""

    def __init__(self, finder_delay: float, verifier_delay: float, finder_body=None, verifier_body=None) -> None:
        self.delays = {"email-finder": finder_delay, "email-verifier": verifier_delay}
        self.bodies = {"email-finder": finder_body or {"data": {"email": GOOD, "score": 90}},
                       "email-verifier": verifier_body or {"data": {"status": "valid"}}}
        self.hits: list[str] = []

    async def _handle(self, reader, writer) -> None:
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
            kind = "email-finder" if "email-finder" in head.split("\r\n")[0] else "email-verifier"
            self.hits.append(kind)
            await asyncio.sleep(self.delays[kind])
            body = json.dumps(self.bodies[kind]).encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\n\r\n" + body)
            await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError, asyncio.CancelledError):
            pass
        finally:
            writer.close()

    def run(self, monkeypatch: pytest.MonkeyPatch, coro_factory):
        real = httpx.AsyncClient

        async def scenario():
            server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]

            class Local(real):
                async def request(self, method, url, **kwargs):
                    return await super().request(method, url.replace("https://api.hunter.io", f"http://127.0.0.1:{port}"), **kwargs)

            monkeypatch.setattr(providers.httpx, "AsyncClient", Local)
            try:
                return await coro_factory()
            finally:
                server.close()
                await server.wait_closed()

        return asyncio.run(scenario())


def _scaled(monkeypatch: pytest.MonkeyPatch, base: float, finder: float, verifier: float) -> None:
    monkeypatch.setattr(settings, "people_provider_timeout_seconds", base)
    monkeypatch.setattr(providers, "_HUNTER_FINDER_TIMEOUT_SECONDS", finder)
    monkeypatch.setattr(providers, "_HUNTER_VERIFIER_TIMEOUT_SECONDS", verifier)


def test_a_slow_but_working_provider_succeeds_instead_of_timing_out(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    _scaled(monkeypatch, base=0.3, finder=3.0, verifier=3.0)      # answers take 0.8 s: longer than the base limit, inside Hunter's window
    server = _SlowHunter(finder_delay=0.8, verifier_delay=0.8)
    out = server.run(monkeypatch, lambda: find_email(db, user, job.id, rec.id))
    assert out["status"] == "verified" and out["professional_email"] == GOOD
    assert server.hits == ["email-finder", "email-verifier"]       # exactly one request each, no retries


def test_the_base_timeout_alone_would_have_cut_the_same_answer_off(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    _scaled(monkeypatch, base=0.3, finder=0.0, verifier=0.0)      # no extra read time: what production ran before
    server = _SlowHunter(finder_delay=0.8, verifier_delay=0.8)
    out = server.run(monkeypatch, lambda: find_email(db, user, job.id, rec.id))
    assert out["status"] == "provider_unavailable"
    assert server.hits == ["email-finder"]


def test_a_real_finder_timeout_is_reported_once_with_its_stage_and_never_retried(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    user, job, person, rec = _persist_recommendation(db)
    _scaled(monkeypatch, base=0.3, finder=0.6, verifier=3.0)
    server = _SlowHunter(finder_delay=1.5, verifier_delay=0.1)
    with caplog.at_level(logging.WARNING):
        out = server.run(monkeypatch, lambda: find_email(db, user, job.id, rec.id))
    assert out["status"] == "provider_unavailable" and out["professional_email"] is None
    assert server.hits == ["email-finder"]
    lines = [r.getMessage() for r in caplog.records if "people_email_lookup_failed" in r.getMessage()]
    assert len(lines) == 1 and "stage=finder" in lines[0] and "reason=provider_timeout" in lines[0] and "attempts=1" in lines[0]
    assert person.email_verification_status == "not_requested"


def test_a_real_verifier_timeout_keeps_the_finder_credit_in_the_budget_and_is_not_retried(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    from sqlalchemy import func, select

    from app.models.entities import PeopleDiscoveryRun

    user, job, person, rec = _persist_recommendation(db)
    _scaled(monkeypatch, base=0.3, finder=3.0, verifier=0.6)
    server = _SlowHunter(finder_delay=0.1, verifier_delay=1.5)
    with caplog.at_level(logging.WARNING):
        out = server.run(monkeypatch, lambda: find_email(db, user, job.id, rec.id))
    assert out["status"] == "provider_unavailable"
    assert server.hits == ["email-finder", "email-verifier"]
    assert any("stage=verifier" in r.getMessage() and "attempts=2" in r.getMessage() for r in caplog.records)
    assert db.scalar(select(func.sum(PeopleDiscoveryRun.provider_credits_used)).where(PeopleDiscoveryRun.provider == "hunter")) == 1


# ---- error classification and the diagnostic line -------------------------------------------------------------------------------
@pytest.mark.parametrize("error_id", ["invalid_first_name", "invalid_last_name", "invalid_full_name"])
def test_a_name_hunter_refuses_becomes_identity_uncertain_a_state_with_no_retry_button(
    db: Session, monkeypatch: pytest.MonkeyPatch, error_id: str
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    FakeHunter((400, {"errors": [{"id": error_id, "details": "Rita Recruiter is not a name"}]}), _found()).install(monkeypatch)
    out = _run(db, user, job, rec)
    assert out["status"] == "identity_uncertain" and out["professional_email"] is None
    assert person.email_verification_status == "not_requested"


@pytest.mark.parametrize("status,error_id", [(400, "invalid_domain"), (400, "wrong_params"), (404, None)])
def test_other_rejected_requests_are_a_service_problem_not_a_temporary_outage(
    db: Session, monkeypatch: pytest.MonkeyPatch, status: int, error_id
) -> None:
    user, job, person, rec = _persist_recommendation(db)
    body = {"errors": [{"id": error_id}]} if error_id else {}
    fake = FakeHunter((status, body), _found())
    fake.install(monkeypatch)
    assert _run(db, user, job, rec)["status"] == "provider_error"
    assert fake.count("finder") == 1                              # one request, no automatic retry


def test_the_failure_line_carries_an_allowlisted_provider_error_id_and_never_free_text(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    user, job, person, rec = _persist_recommendation(db)
    hostile = {"errors": [{"id": "rita.recruiter@acme.example", "details": "Rita Recruiter at acme.example"}]}
    FakeHunter((400, hostile), _found()).install(monkeypatch)
    with caplog.at_level(logging.DEBUG):
        _run(db, user, job, rec)
    line = next(r.getMessage() for r in caplog.records if "people_email_lookup_failed" in r.getMessage())
    assert "provider_error=none" in line
    for forbidden in ("rita", "Rita", "acme", "@", "synthetic-test-key"):
        assert forbidden not in caplog.text
    caplog.clear()
    FakeHunter((400, {"errors": [{"id": "invalid_domain"}]}), _found()).install(monkeypatch)
    with caplog.at_level(logging.WARNING):
        _run(db, user, job, rec)
    assert "provider_error=invalid_domain" in next(r.getMessage() for r in caplog.records if "people_email_lookup_failed" in r.getMessage())


def test_a_successful_lookup_writes_no_failure_line_and_nothing_sensitive(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    user, job, person, rec = _persist_recommendation(db)
    FakeHunter(_found(), (200, {"data": {"status": "valid"}})).install(monkeypatch)
    with caplog.at_level(logging.DEBUG):
        assert _run(db, user, job, rec)["status"] == "verified"
    assert "people_email_lookup_failed" not in caplog.text
    for forbidden in (GOOD, "Rita", DOMAIN, "synthetic-test-key"):
        assert forbidden not in caplog.text


def test_log_tokens_are_reduced_to_a_safe_alphabet() -> None:
    assert service._log_token("provider_timeout") == "provider_timeout"
    for hostile in ("a@b.c", "Rita Recruiter", "x" * 200, "domain.example", "", None):
        assert service._log_token(hostile) in {"other"}
