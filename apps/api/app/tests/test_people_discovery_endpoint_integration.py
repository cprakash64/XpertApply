"""POST /discover -> database -> GET /people, against a mocked provider account.

These are the regression tests for the live defect that direct decision-function
tests could not catch: PDL stopped on budget, Apollo answered with real people,
Apollo's bulk enrichment was rejected with HTTP 422, and the *persisted* run
still said ``provider_budget_exhausted`` while every Apollo candidate silently
disappeared.

Nothing here contacts a provider account and nothing here spends a credit: the
whole HTTP layer is replaced by :class:`_Transport`.
"""

from __future__ import annotations

import logging
from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.config import settings
from app.db.base import Base
from app.main import app
from app.models.entities import (
    JobPeopleCandidate,
    JobPosting,
    PeopleDiscoveryRun,
    PeopleUserDiscoveryQuota,
    User,
    UserJobPeopleRecommendation,
    UserProfile,
)
from app.people import circuit, pdl_company, providers, service
from app.people.brightdata import VerificationResult
from app.people.openai_web import OpenAIWebPeopleProvider, WebDiscoveryOutcome
from app.people.quota import quota_day
from app.people.schemas import ProviderPerson

COMPANY = "Northwind Robotics"
DOMAIN = "northwindrobotics.example"

PDL_BUDGET_EXHAUSTED = {
    "status": 402,
    "error": {
        "type": "payment_required",
        "message": "You have reached your account maximum",
    },
}

# Apollo's documented request-level rejection shape for bulk_match: one
# top-level message, no per-record field paths.
APOLLO_BULK_422 = {
    "error_code": "INVALID_DETAILS",
    "error_message": "The details parameter could not be processed",
}


def _apollo_person(
    identifier: str,
    *,
    first_name: str,
    last_name: str,
    title: str,
) -> dict:
    """A People Search row: an id, a name, a title, an organization. No LinkedIn.

    Apollo's Search response deliberately withholds contact channels; only
    enrichment reveals them. That is the shape this suite must keep usable.
    """

    return {
        "id": identifier,
        "first_name": first_name,
        "last_name_obfuscated": last_name,
        "title": title,
        "organization": {"name": COMPANY, "primary_domain": DOMAIN},
        "city": "Austin",
        "state": "Texas",
        "last_refreshed_at": datetime.now(UTC).isoformat(),
    }


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


def _session() -> Session:
    return next(app.dependency_overrides[get_db]())


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "people_recommendations_enabled", True)
    monkeypatch.setattr(settings, "people_rollout_mode", "all")
    monkeypatch.setattr(settings, "people_primary_provider", "pdl")
    monkeypatch.setattr(settings, "people_provider_order", ["pdl", "apollo"])
    monkeypatch.setattr(settings, "people_provider_fallback_on_budget_exhausted", True)
    monkeypatch.setattr(settings, "people_provider_fallback_on_no_match", True)
    monkeypatch.setattr(settings, "pdl_api_key", "pdl-test-key-not-a-credential")
    monkeypatch.setattr(settings, "people_pdl_discovery_enabled", True)
    monkeypatch.setattr(settings, "people_pdl_daily_credit_budget", 500)
    monkeypatch.setattr(settings, "people_pdl_per_user_daily_limit", 200)
    monkeypatch.setattr(settings, "apollo_api_key", "apollo-test-key-not-a-credential")
    monkeypatch.setattr(settings, "people_apollo_discovery_enabled", True)
    monkeypatch.setattr(settings, "people_apollo_daily_credit_budget", 200)
    monkeypatch.setattr(settings, "people_apollo_per_user_daily_limit", 100)
    monkeypatch.setattr(settings, "people_apollo_max_enrichments_per_discovery", 4)
    monkeypatch.setattr(settings, "people_openai_web_discovery_enabled", False)
    monkeypatch.setattr(settings, "people_employment_secondary_verification_enabled", False)
    monkeypatch.setattr(settings, "people_min_relevance_score", 0)
    monkeypatch.setattr(settings, "people_min_recruiter_relevance", 0)
    monkeypatch.setattr(settings, "people_min_manager_relevance", 0)
    monkeypatch.setattr(settings, "people_min_referrer_relevance", 0)
    monkeypatch.setattr(settings, "people_min_data_confidence", 0)
    circuit.clear_local_circuits()
    pdl_company.clear_local_pdl_companies()


class _Transport:
    """PDL is out of budget; Apollo searches fine and cannot enrich."""

    def __init__(
        self,
        *,
        search_rows: list[dict] | None = None,
        bulk_status: int = 422,
        apollo_search_status: int = 200,
    ) -> None:
        self.search_rows = search_rows if search_rows is not None else []
        self.bulk_status = bulk_status
        self.apollo_search_status = apollo_search_status
        self.calls: list[str] = []

    async def __aenter__(self) -> _Transport:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        request = httpx.Request(method, url)
        if "peopledatalabs.com" in url and "/company/enrich" in url:
            self.calls.append("pdl_company")
            return httpx.Response(
                200,
                request=request,
                json={
                    "status": 200,
                    "likelihood": 9,
                    "id": f"pdl-{DOMAIN}",
                    "name": COMPANY,
                    "website": DOMAIN,
                },
            )
        if "peopledatalabs.com" in url:
            self.calls.append("pdl_search")
            return httpx.Response(402, request=request, json=PDL_BUDGET_EXHAUSTED)
        if "mixed_people/api_search" in url:
            self.calls.append("apollo_search")
            if self.apollo_search_status != 200:
                return httpx.Response(
                    self.apollo_search_status, request=request, json=APOLLO_BULK_422
                )
            payload = kwargs.get("json") or {}
            wanted = [
                str(value).lower()
                for value in (payload.get("person_titles") or [])  # type: ignore[union-attr]
            ]
            # Apollo answers each category with the people whose titles were
            # asked for; returning every row to every category would merge them
            # into one bucket and hide a real coverage difference.
            rows = [
                row
                for row in self.search_rows
                if any(
                    title in str(row["title"]).lower()
                    or str(row["title"]).lower() in title
                    for title in wanted
                )
            ]
            return httpx.Response(200, request=request, json={"people": rows})
        if "people/bulk_match" in url:
            self.calls.append("apollo_bulk")
            return httpx.Response(
                self.bulk_status, request=request, json=APOLLO_BULK_422
            )
        if "api.apollo.io/api/v1/people/" in url:
            # The bounded single-person completion behind a rejected bulk call.
            self.calls.append("apollo_complete_person")
            return httpx.Response(422, request=request, json=APOLLO_BULK_422)
        self.calls.append(f"unexpected:{url}")
        return httpx.Response(404, request=request, json={})


def _transport(monkeypatch: pytest.MonkeyPatch, transport: _Transport) -> _Transport:
    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **_kw: transport)
    return transport


def _auth(client: TestClient, email: str = "waterfall@example.com") -> dict[str, str]:
    token = client.post(
        "/auth/signup", json={"email": email, "password": "password123"}
    ).json()
    db = _session()
    user = db.scalar(select(User).where(User.email == email))
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    if profile is None:
        profile = UserProfile(user_id=user.id)
        db.add(profile)
    profile.full_name = "Sam Candidate"
    profile.skills = ["Python"]
    db.commit()
    return {"Authorization": f"Bearer {token['access_token']}"}


def _job(external_id: str = "northwind-1") -> int:
    db = _session()
    job = JobPosting(
        external_id=external_id,
        title="Senior Backend Engineer",
        company=COMPANY,
        company_domain=DOMAIN,
        location="Austin, Texas, United States",
        employment_type="full-time",
        seniority_level="senior",
        application_url=f"https://example.com/{external_id}",
        source_url=f"https://example.com/{external_id}",
        description_raw="Build robots.",
        description_clean="Build backend services in Python for robotics.",
        required_skills=["Python"],
        raw_json={},
        hash_for_deduplication=external_id.ljust(64, "0"),
    )
    db.add(job)
    db.commit()
    return job.id


def _latest_run(job_id: int) -> PeopleDiscoveryRun:
    db = _session()
    return db.scalars(
        select(PeopleDiscoveryRun)
        .where(PeopleDiscoveryRun.job_id == job_id)
        .order_by(PeopleDiscoveryRun.id.desc())
    ).first()


def _finalization_events(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("people_waterfall_finalized")
    ]


def _all_people(payload: dict) -> list[dict]:
    return [person for group in payload["categories"].values() for person in group]


DISPLAYABLE_ROWS = [
    _apollo_person(
        "apollo-recruiter-1",
        first_name="Priya",
        last_name="Raghavan",
        title="Senior Technical Recruiter",
    ),
    _apollo_person(
        "apollo-manager-1",
        first_name="Daniel",
        last_name="Okafor",
        title="Engineering Manager, Backend",
    ),
]

# Apollo masks the surname on some plans. A single initial is not a name a user
# could act on, and the display policy rejects it — truthfully, and without
# blaming the provider's budget.
MASKED_ROWS = [
    _apollo_person(
        "apollo-masked-1",
        first_name="Priya",
        last_name="R███████",
        title="Senior Technical Recruiter",
    ),
]


def test_a_linkless_apollo_candidate_is_kept_internally_but_never_displayed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Two rules meeting, and both must hold.

    The finalization rule: PDL's budget stop is not what ended this search, so
    the run must not report it. The product rule: Apollo People Search returns
    no LinkedIn URL, so those people are not contacts a user could act on and
    must not be displayed — however real they are.

    The candidates are still persisted (suppressed) and still available as
    internal identity-resolution hints. They are simply never rendered.
    """

    transport = _transport(monkeypatch, _Transport(search_rows=DISPLAYABLE_ROWS))
    headers = _auth(client)
    job_id = _job()

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        response = client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert _all_people(payload) == [], payload

    assert "apollo_search" in transport.calls
    assert "apollo_bulk" in transport.calls

    run = _latest_run(job_id)
    # The budget did not stop this search, and still must not be blamed for it.
    assert run.status != "provider_budget_exhausted"
    assert run.failure_code != "provider_budget_exceeded"
    assert (run.company_context or {})["providers_attempted"] == ["pdl", "apollo"]

    # Retained internally: the person rows exist, the recommendations are
    # suppressed, and the withholding reason is recorded.
    db = _session()
    suppressed = db.scalars(
        select(UserJobPeopleRecommendation).where(
            UserJobPeopleRecommendation.job_id == job_id
        )
    ).all()
    assert suppressed, "candidates should be retained as internal hints"
    assert all(row.suppressed_at is not None for row in suppressed)
    limitations = {
        reason
        for candidate in db.scalars(select(JobPeopleCandidate)).all()
        for reason in (candidate.recommendation_limitations or [])
    }
    assert "missing_linkedin_url" in limitations

    # A later read returns the same nothing, and never a budget explanation.
    follow_up = client.get(f"/jobs/{job_id}/people", headers=headers).json()
    assert _all_people(follow_up) == []
    assert not any("budget" in warning.lower() for warning in follow_up["warnings"])

    # The user's unit is returned: an integration defect bought them nothing.
    quota_row = db.scalar(select(PeopleUserDiscoveryQuota))
    assert quota_row.discoveries_used == 0
    assert (run.company_context or {})["user_quota_decision"] == "refunded"
    assert len(_finalization_events(caplog)) == 1, _finalization_events(caplog)


def test_a_rejected_bulk_call_never_reports_the_earlier_budget_stop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """No displayable candidate, and two different failures in the chain.

    PDL stopped on budget and Apollo's request was rejected. The budget did not
    stop this search — our own request did — so the run must say so.
    """

    _transport(monkeypatch, _Transport(apollo_search_status=422))
    headers = _auth(client, email="schema@example.com")
    job_id = _job("northwind-schema")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        response = client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert not _all_people(payload)

    run = _latest_run(job_id)
    assert run.status != "provider_budget_exhausted"
    assert run.failure_code != "provider_budget_exceeded"
    assert run.status in {"provider_unavailable", "invalid_request"}

    # The user never sees a provider name, and never sees a budget explanation.
    warnings = " ".join(payload["warnings"]).lower()
    assert "budget" not in warnings
    assert "apollo" not in warnings and "pdl" not in warnings

    assert len(_finalization_events(caplog)) == 1, _finalization_events(caplog)


def test_a_funded_provider_answering_with_nobody_outranks_a_budget_stop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """PDL was blocked; Apollo ran and found nobody.

    The budget blocked one provider. The provider that actually answered was
    never blocked by anything, so telling the user "provider capacity has been
    reached" would be false — the honest answer is that nobody matched.
    """

    _transport(monkeypatch, _Transport(search_rows=[]))
    headers = _auth(client, email="nomatch@example.com")
    job_id = _job("northwind-nomatch")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        payload = client.post(
            f"/jobs/{job_id}/people/discover", headers=headers
        ).json()

    run = _latest_run(job_id)
    assert run.status == "complete"
    assert run.failure_code is None
    assert payload["status"] == "no_reliable_matches"
    assert payload["availability_reason"] == "available"
    assert len(_finalization_events(caplog)) == 1


def test_a_masked_surname_is_rejected_truthfully_not_as_a_budget_stop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A candidate the UI cannot honestly display is dropped, and said so.

    What must NOT happen is the run inheriting PDL's budget stop because the
    display policy — not the budget — is what removed the person.
    """

    _transport(monkeypatch, _Transport(search_rows=MASKED_ROWS))
    headers = _auth(client, email="masked@example.com")
    job_id = _job("northwind-masked")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        response = client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    assert response.status_code == 200, response.text
    run = _latest_run(job_id)
    assert run.status != "provider_budget_exhausted"
    assert len(_finalization_events(caplog)) == 1


def test_a_cache_hit_still_emits_exactly_one_finalization_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The branch that used to log nothing at all."""

    _transport(monkeypatch, _Transport(search_rows=DISPLAYABLE_ROWS))
    headers = _auth(client, email="cache@example.com")
    job_id = _job("northwind-cache")

    client.post(f"/jobs/{job_id}/people/discover", headers=headers)
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        again = client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    assert again.status_code == 200
    events = _finalization_events(caplog)
    assert len(events) == 1, events
    # Whichever cache branch answered, it must be a cache branch: a second
    # click on an unchanged job never re-enters the provider chain.
    assert "cache_decision=hit_" in events[0]


def test_a_quota_rejection_still_emits_exactly_one_finalization_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(settings, "people_user_daily_discovery_limit", 0)
    monkeypatch.setattr(settings, "people_internal_user_daily_discovery_limit", 0)
    _transport(monkeypatch, _Transport(search_rows=DISPLAYABLE_ROWS))
    headers = _auth(client, email="quota@example.com")

    # Seed the ledger at the limit. Driving this through a real discovery is
    # unreliable now that a failed run correctly refunds its unit.
    monkeypatch.setattr(settings, "people_user_daily_discovery_limit", 1)
    db = _session()
    user = db.scalar(select(User).where(User.email == "quota@example.com"))
    db.add(
        PeopleUserDiscoveryQuota(
            user_id=user.id, quota_date=quota_day().isoformat(), discoveries_used=1
        )
    )
    db.commit()
    second_job = _job("northwind-quota-2")
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        rejected = client.post(
            f"/jobs/{second_job}/people/discover", headers=headers
        )

    assert rejected.status_code == 429
    events = _finalization_events(caplog)
    assert len(events) == 1, events
    assert "final_status=rejected" in events[0]
    assert "PEOPLE_USER_DAILY_LIMIT_REACHED" in events[0]


def test_an_openai_web_candidate_outranks_an_earlier_budget_stop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Phase 9 parity, exercised through the real endpoint.

    Nothing here calls OpenAI: the provider's ``discover`` is replaced. What is
    exercised is that the finalizer treats a public-web contact exactly as it
    treats an Apollo one — it outranks PDL's budget stop.
    """

    monkeypatch.setattr(settings, "people_provider_order", ["pdl", "openai_web"])
    monkeypatch.setattr(settings, "people_openai_web_discovery_enabled", True)
    monkeypatch.setattr(settings, "openai_api_key", "openai-test-key-not-a-credential")
    monkeypatch.setattr(settings, "people_openai_web_daily_call_budget", 20)
    monkeypatch.setattr(settings, "people_openai_web_per_user_daily_limit", 10)

    async def _discover(_self: object, **_kwargs: object) -> WebDiscoveryOutcome:
        return WebDiscoveryOutcome(
            candidates=[
                ProviderPerson(
                    provider="openai_web",
                    provider_person_id="openai-web-1",
                    full_name="Alexis Turner",
                    current_company_name=COMPANY,
                    current_company_domain=DOMAIN,
                    current_title="Technical Recruiter",
                    linkedin_url="https://www.linkedin.com/in/alexis-turner",
                    current_role_indicator=True,
                    provider_record_observed_at=datetime.now(UTC),
                    provider_employment_updated_at=datetime.now(UTC),
                )
            ],
            searches_used=1,
        )

    monkeypatch.setattr(OpenAIWebPeopleProvider, "discover", _discover)

    # A public-web sighting is only displayable once Bright Data has confirmed
    # the profile. This test is about finalizer parity, not verification, so
    # the verifier is stubbed to confirm what it was given.
    async def _verify(candidates, **_kwargs):
        return VerificationResult(confirmed=list(candidates))

    monkeypatch.setattr(service, "verify_candidates", _verify)
    _transport(monkeypatch, _Transport(search_rows=[]))
    headers = _auth(client, email="openaiweb@example.com")
    job_id = _job("northwind-openai")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        payload = client.post(
            f"/jobs/{job_id}/people/discover", headers=headers
        ).json()

    run = _latest_run(job_id)
    assert run.status != "provider_budget_exhausted"
    assert _all_people(payload), payload
    assert run.provider == "openai_web" or run.provider.startswith("multi:")
    assert len(_finalization_events(caplog)) == 1


def test_an_explicit_find_people_never_replays_a_failed_incompatible_run(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Runs recorded under the retired contract cannot answer a new search."""

    transport = _transport(monkeypatch, _Transport(search_rows=DISPLAYABLE_ROWS))
    headers = _auth(client, email="replay@example.com")
    job_id = _job("northwind-replay")

    db = _session()
    user = db.scalar(select(User).where(User.email == "replay@example.com"))
    job = db.get(JobPosting, job_id)
    from app.people.service import query_fingerprint

    db.add(
        PeopleDiscoveryRun(
            job_id=job_id,
            user_id=user.id,
            status="provider_budget_exhausted",
            provider="pdl",
            query_fingerprint=query_fingerprint(job),
            failure_code="provider_budget_exceeded",
            safe_failure_message="People search is temporarily unavailable.",
            company_context={"search_contract_version": "people-finalization-v2"},
            started_at=datetime.now(UTC) - timedelta(hours=1),
            completed_at=datetime.now(UTC) - timedelta(hours=1),
        )
    )
    db.commit()

    payload = client.post(
        f"/jobs/{job_id}/people/discover", headers=headers
    ).json()

    # The retired run is not replayed: a real search runs instead, and its
    # honest answer is returned rather than the stored budget message.
    assert "apollo_search" in transport.calls
    assert payload["status"] != "provider_budget_exhausted"
    assert payload["availability_reason"] != "provider_budget_exceeded"
