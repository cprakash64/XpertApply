"""The private-beta chain, end to end: brightdata -> openai_web -> pdl.

POST /discover -> database -> GET /people, through the real FastAPI routes and
a real (SQLite) database, with every provider replaced at the transport or
method boundary. No provider account is contacted and no credit is spent.

What these pin that unit tests could not:

* the chain runs in the configured order, and PDL is genuinely last;
* the chain stops as soon as coverage is met, so a good Bright Data answer never
  pays for an OpenAI or PDL search;
* one provider's failure cannot erase another provider's valid contacts;
* masked or linkless records never reach the response, whichever provider
  produced them;
* one deliberate search costs exactly one quota unit, and reopening costs none.
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
    JobPosting,
    PeopleDiscoveryRun,
    PeopleUserDiscoveryQuota,
    User,
    UserProfile,
)
from app.people import brightdata, circuit, pdl_company, providers, service
from app.people.openai_web import OpenAIWebPeopleProvider, WebDiscoveryOutcome
from app.people.schemas import ProviderPerson

COMPANY = "Northwind Robotics"
DOMAIN = "northwindrobotics.example"

PDL_BUDGET_EXHAUSTED = {
    "status": 402,
    "error": {"type": "payment_required", "message": "account maximum"},
}


def _bd_row(slug: str, name: str, title: str, *, company: str = COMPANY) -> dict:
    return {
        "name": name,
        "url": f"https://www.linkedin.com/in/{slug}",
        "position": title,
        "current_company": {"name": company},
        "city": "Austin",
        "country_code": "US",
    }


RECRUITERS = [
    _bd_row("priya-raghavan", "Priya Raghavan", "Senior Technical Recruiter"),
    _bd_row("sam-okonkwo", "Sam Okonkwo", "Technical Recruiter"),
]
MANAGER = _bd_row("daniel-okafor", "Daniel Okafor", "Engineering Manager")
REFERRERS = [
    _bd_row("lena-fischer", "Lena Fischer", "Senior Software Engineer"),
    _bd_row("ravi-menon", "Ravi Menon", "Backend Engineer"),
]
# What Apollo-style masking looks like when it reaches any provider.
MASKED = _bd_row("x", "Priya R███████", "Technical Recruiter")


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
def _beta_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    """The private-beta configuration, with every provider mocked."""

    monkeypatch.setattr(settings, "people_recommendations_enabled", True)
    monkeypatch.setattr(settings, "people_rollout_mode", "all")
    monkeypatch.setattr(
        settings, "people_provider_order", ["brightdata", "openai_web", "pdl"]
    )
    monkeypatch.setattr(settings, "people_primary_provider", "brightdata")
    # Bright Data, fully configured so the discovery step is live.
    monkeypatch.setattr(settings, "people_brightdata_discovery_enabled", True)
    monkeypatch.setattr(settings, "brightdata_api_token", "bd-token-not-a-secret")
    monkeypatch.setattr(settings, "people_brightdata_dataset_id", "gd_profiles")
    monkeypatch.setattr(
        settings, "people_brightdata_discovery_dataset_id", "gd_discovery"
    )
    monkeypatch.setattr(settings, "people_brightdata_daily_record_budget", 500)
    monkeypatch.setattr(settings, "people_brightdata_per_user_daily_limit", 200)
    monkeypatch.setattr(settings, "people_brightdata_max_records_per_discovery", 10)
    monkeypatch.setattr(settings, "people_brightdata_poll_interval_seconds", 0.001)
    monkeypatch.setattr(settings, "people_brightdata_max_poll_seconds", 0.5)
    # OpenAI public web.
    monkeypatch.setattr(settings, "people_openai_web_discovery_enabled", True)
    monkeypatch.setattr(settings, "openai_api_key", "openai-key-not-a-secret")
    monkeypatch.setattr(settings, "people_openai_web_daily_call_budget", 50)
    monkeypatch.setattr(settings, "people_openai_web_per_user_daily_limit", 20)
    # PDL, last.
    monkeypatch.setattr(settings, "pdl_api_key", "pdl-key-not-a-secret")
    monkeypatch.setattr(settings, "people_pdl_discovery_enabled", True)
    monkeypatch.setattr(settings, "people_pdl_daily_credit_budget", 500)
    monkeypatch.setattr(settings, "people_pdl_per_user_daily_limit", 200)
    # Apollo stays off for customer-facing discovery.
    monkeypatch.setattr(settings, "people_apollo_discovery_enabled", False)
    monkeypatch.setattr(settings, "people_employment_secondary_verification_enabled", False)
    for name in (
        "people_min_relevance_score",
        "people_min_recruiter_relevance",
        "people_min_manager_relevance",
        "people_min_referrer_relevance",
        "people_min_data_confidence",
    ):
        monkeypatch.setattr(settings, name, 0)
    circuit.clear_local_circuits()
    pdl_company.clear_local_pdl_companies()


class _BrightDataTransport:
    """Trigger -> progress -> snapshot, per the documented lifecycle."""

    def __init__(self, rows_by_call: list[list[dict]] | None = None, *, status: int = 200):
        self.rows_by_call = rows_by_call if rows_by_call is not None else []
        self.status = status
        self.calls: list[str] = []
        self._snapshot = 0

    async def request(self, method, url, *, params=None, json=None, headers=None):
        request = httpx.Request(method, url)
        if url.endswith("/trigger"):
            self.calls.append("bd_trigger")
            if self.status != 200:
                return httpx.Response(self.status, request=request, json={"error": "x"})
            return httpx.Response(
                200, request=request, json={"snapshot_id": f"s_{self._snapshot}"}
            )
        if "/progress/" in url:
            self.calls.append("bd_progress")
            return httpx.Response(200, request=request, json={"status": "ready"})
        self.calls.append("bd_snapshot")
        rows = (
            self.rows_by_call[self._snapshot]
            if self._snapshot < len(self.rows_by_call)
            else []
        )
        self._snapshot += 1
        return httpx.Response(200, request=request, json=rows)


class _PDLTransport:
    def __init__(self, *, rows: list[dict] | None = None, budget_exhausted: bool = True):
        self.rows = rows or []
        self.budget_exhausted = budget_exhausted
        self.calls: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def request(self, method: str, url: str, **kwargs):
        request = httpx.Request(method, url)
        if "/company/enrich" in url:
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
        self.calls.append("pdl_search")
        if self.budget_exhausted:
            return httpx.Response(402, request=request, json=PDL_BUDGET_EXHAUSTED)
        return httpx.Response(
            200,
            request=request,
            json={"data": self.rows, "total": len(self.rows)},
        )


def _install(
    monkeypatch: pytest.MonkeyPatch,
    *,
    bd: _BrightDataTransport | None = None,
    pdl: _PDLTransport | None = None,
    web: list[ProviderPerson] | None = None,
    web_failure: str | None = None,
) -> dict[str, object]:
    bd = bd if bd is not None else _BrightDataTransport()
    pdl = pdl if pdl is not None else _PDLTransport()
    # The step constructs its own provider, so the class is replaced with a
    # factory that injects the fake transport.
    monkeypatch.setattr(
        service,
        "BrightDataPeopleProvider",
        lambda *_a, **_kw: brightdata.BrightDataPeopleProvider(client=bd),
    )
    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **_kw: pdl)

    calls: list[str] = []

    async def _discover(_self, **_kwargs):
        calls.append("openai_web")
        return WebDiscoveryOutcome(
            candidates=list(web or []),
            searches_used=1,
            failure_reason=web_failure,
        )

    monkeypatch.setattr(OpenAIWebPeopleProvider, "discover", _discover)
    return {"bd": bd, "pdl": pdl, "web_calls": calls}


def _auth(client: TestClient, email: str) -> dict[str, str]:
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


def _job(external_id: str) -> int:
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


def _people(payload: dict) -> list[dict]:
    return [person for group in payload["categories"].values() for person in group]


def _latest_run(job_id: int) -> PeopleDiscoveryRun:
    db = _session()
    return db.scalars(
        select(PeopleDiscoveryRun)
        .where(PeopleDiscoveryRun.job_id == job_id)
        .order_by(PeopleDiscoveryRun.id.desc())
    ).first()


def _finalizations(caplog) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("people_waterfall_finalized")
    ]


# --------------------------------------------------------------------------
# Scenario A — Bright Data answers, chain stops, contacts persist and re-read
# --------------------------------------------------------------------------


def test_brightdata_success_persists_and_is_returned_by_get(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    harness = _install(
        monkeypatch,
        bd=_BrightDataTransport(
            [RECRUITERS, [MANAGER], REFERRERS, RECRUITERS, [MANAGER], REFERRERS]
        ),
    )
    headers = _auth(client, "bd-success@example.com")
    job_id = _job("chain-bd-success")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        response = client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    assert response.status_code == 200, response.text
    people = _people(response.json())
    assert len(people) == 5, response.json()

    # Every displayed contact is actionable.
    for person in people:
        assert person["professional_profile_url"].startswith(
            "https://www.linkedin.com/in/"
        )
        assert len(person["full_name"].split()) >= 2
        assert person["current_company"] == COMPANY

    run = _latest_run(job_id)
    assert run.status in {"complete", "partial"}
    assert run.provider == "brightdata"
    context = run.company_context or {}
    assert context["accepted_candidate_sources"] == {"brightdata": 5}

    # Coverage was met by Bright Data, so nothing downstream was ever paid for.
    assert harness["web_calls"] == []
    assert harness["pdl"].calls == []
    assert context["providers_attempted"] == ["brightdata"]

    # GET returns exactly what was persisted, and spends nothing.
    follow_up = client.get(f"/jobs/{job_id}/people", headers=headers).json()
    assert len(_people(follow_up)) == 5
    assert harness["pdl"].calls == []

    db = _session()
    assert db.scalar(select(PeopleUserDiscoveryQuota)).discoveries_used == 1
    assert len(_finalizations(caplog)) == 1


# --------------------------------------------------------------------------
# Scenario B — Bright Data insufficient, OpenAI supplies a sourced contact
# --------------------------------------------------------------------------


def test_openai_web_fills_the_gap_bright_data_left(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    sourced = ProviderPerson(
        provider="openai_web",
        provider_person_id="https://www.linkedin.com/in/alexis-turner",
        full_name="Alexis Turner",
        current_company_name=COMPANY,
        current_company_domain=DOMAIN,
        current_title="Technical Recruiter",
        linkedin_url="https://www.linkedin.com/in/alexis-turner",
        current_role_indicator=True,
        provider_record_observed_at=datetime.now(UTC),
        provider_employment_updated_at=datetime.now(UTC),
    )
    harness = _install(
        monkeypatch,
        bd=_BrightDataTransport([[], [], []]),
        web=[sourced],
    )
    headers = _auth(client, "web-fallback@example.com")
    job_id = _job("chain-web-fallback")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        payload = client.post(
            f"/jobs/{job_id}/people/discover", headers=headers
        ).json()

    people = _people(payload)
    assert [person["full_name"] for person in people] == ["Alexis Turner"]
    assert people[0]["professional_profile_url"] == (
        "https://www.linkedin.com/in/alexis-turner"
    )

    run = _latest_run(job_id)
    context = run.company_context or {}
    # Bright Data ran first and answered with nobody; OpenAI answered second.
    assert context["providers_attempted"][:2] == ["brightdata", "openai_web"]
    assert context["accepted_candidate_sources"] == {"openai_web": 1}
    assert "bd_trigger" in harness["bd"].calls
    assert harness["web_calls"] == ["openai_web"]
    assert len(_finalizations(caplog)) == 1


# --------------------------------------------------------------------------
# Scenario C — everything masked or linkless: neutral empty state
# --------------------------------------------------------------------------


def test_masked_and_linkless_results_produce_a_neutral_empty_state(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    linkless = ProviderPerson(
        provider="openai_web",
        provider_person_id="pdl-linkless",
        full_name="Jordan Nolinked",
        current_company_name=COMPANY,
        current_company_domain=DOMAIN,
        current_title="Technical Recruiter",
        linkedin_url=None,
        current_role_indicator=True,
        provider_record_observed_at=datetime.now(UTC),
    )
    _install(
        monkeypatch,
        bd=_BrightDataTransport([[MASKED], [MASKED], [MASKED]]),
        web=[linkless],
        pdl=_PDLTransport(budget_exhausted=True),
    )
    headers = _auth(client, "all-masked@example.com")
    job_id = _job("chain-all-masked")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        payload = client.post(
            f"/jobs/{job_id}/people/discover", headers=headers
        ).json()

    assert _people(payload) == []
    # A neutral state, not an alarming one, and never a provider name.
    joined = " ".join(payload["warnings"]).lower()
    assert "brightdata" not in joined and "openai" not in joined and "pdl" not in joined
    # No masked fragment leaks into the response at all.
    assert "███" not in str(payload)
    assert "Priya R" not in str(payload)
    assert len(_finalizations(caplog)) == 1


# --------------------------------------------------------------------------
# Scenario D — one provider's failure cannot erase another's contacts
# --------------------------------------------------------------------------


def test_a_provider_failure_never_erases_another_providers_contacts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Bright Data fails outright; OpenAI's sourced contact must still stand."""

    sourced = ProviderPerson(
        provider="openai_web",
        provider_person_id="https://www.linkedin.com/in/robin-vega",
        full_name="Robin Vega",
        current_company_name=COMPANY,
        current_company_domain=DOMAIN,
        current_title="Engineering Manager",
        linkedin_url="https://www.linkedin.com/in/robin-vega",
        current_role_indicator=True,
        provider_record_observed_at=datetime.now(UTC),
        provider_employment_updated_at=datetime.now(UTC),
    )
    _install(
        monkeypatch,
        bd=_BrightDataTransport(status=500),
        web=[sourced],
        pdl=_PDLTransport(budget_exhausted=True),
    )
    headers = _auth(client, "mixed-failure@example.com")
    job_id = _job("chain-mixed-failure")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        payload = client.post(
            f"/jobs/{job_id}/people/discover", headers=headers
        ).json()

    people = _people(payload)
    assert [person["full_name"] for person in people] == ["Robin Vega"]

    run = _latest_run(job_id)
    # A real contact outranks every provider failure in the chain.
    assert run.status in {"partial", "complete"}
    assert run.failure_code is None
    assert (run.company_context or {})["accepted_candidate_sources"] == {
        "openai_web": 1
    }
    assert len(_finalizations(caplog)) == 1


# --------------------------------------------------------------------------
# Scenario E — quota: one click, one unit; reopening costs nothing
# --------------------------------------------------------------------------


def test_one_deliberate_search_costs_exactly_one_unit_across_the_chain(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = _install(
        monkeypatch,
        bd=_BrightDataTransport([RECRUITERS, [MANAGER], REFERRERS]),
    )
    headers = _auth(client, "quota-chain@example.com")
    job_id = _job("chain-quota")

    client.post(f"/jobs/{job_id}/people/discover", headers=headers)
    db = _session()
    assert db.scalar(select(PeopleUserDiscoveryQuota)).discoveries_used == 1
    calls_after_search = len(harness["bd"].calls)

    # Rendering, reopening and re-reading are free.
    for _ in range(3):
        client.get(f"/jobs/{job_id}/people", headers=headers)
    db = _session()
    assert db.scalar(select(PeopleUserDiscoveryQuota)).discoveries_used == 1
    assert len(harness["bd"].calls) == calls_after_search

    # A repeated POST is answered from cache: still one unit, still no calls.
    client.post(f"/jobs/{job_id}/people/discover", headers=headers)
    db = _session()
    assert db.scalar(select(PeopleUserDiscoveryQuota)).discoveries_used == 1
    assert len(harness["bd"].calls) == calls_after_search


# --------------------------------------------------------------------------
# Scenario F — legacy weak cache is not served
# --------------------------------------------------------------------------


def test_a_legacy_weak_cached_result_is_never_served(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = _install(
        monkeypatch,
        bd=_BrightDataTransport([RECRUITERS, [MANAGER], REFERRERS]),
    )
    headers = _auth(client, "legacy-cache@example.com")
    job_id = _job("chain-legacy")

    from app.people.service import query_fingerprint

    db = _session()
    user = db.scalar(select(User).where(User.email == "legacy-cache@example.com"))
    job = db.get(JobPosting, job_id)
    db.add(
        PeopleDiscoveryRun(
            job_id=job_id,
            user_id=user.id,
            status="complete",
            provider="apollo",
            query_fingerprint=query_fingerprint(job),
            company_context={
                # Recorded under a retired contract, when masked linkless
                # records still counted as contacts.
                "search_contract_version": "people-finalization-v3",
            },
            started_at=datetime.now(UTC) - timedelta(hours=2),
            completed_at=datetime.now(UTC) - timedelta(hours=2),
        )
    )
    db.commit()

    payload = client.post(f"/jobs/{job_id}/people/discover", headers=headers).json()

    # The retired run is not replayed: a real search ran and produced contacts.
    assert "bd_trigger" in harness["bd"].calls
    assert len(_people(payload)) == 5


def test_pdl_is_reached_only_when_the_providers_before_it_fall_short(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = _install(
        monkeypatch,
        bd=_BrightDataTransport([[], [], []]),
        web=[],
        pdl=_PDLTransport(budget_exhausted=True),
    )
    headers = _auth(client, "pdl-last@example.com")
    job_id = _job("chain-pdl-last")

    client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    run = _latest_run(job_id)
    attempted = (run.company_context or {})["providers_attempted"]
    # The whole point of the refactor: PDL is last, not first.
    assert attempted == ["brightdata", "openai_web", "pdl"]
    assert harness["pdl"].calls, "PDL should have been reached once others fell short"
