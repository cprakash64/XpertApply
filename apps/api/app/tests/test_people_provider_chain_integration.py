"""The private-beta chain, end to end: openai_web -> pdl, verified by Bright Data.

POST /discover -> database -> GET /people, through the real FastAPI routes and
a real (SQLite) database, with every provider replaced at the transport or
method boundary. No provider account is contacted and no credit is spent.

What these pin that unit tests could not:

* OpenAI discovers a cited LinkedIn URL and Bright Data confirms it against the
  real profile before any of it can be displayed;
* an unconfirmed profile is withheld, however plausible the sighting was;
* the chain runs in the configured order, and PDL is genuinely last;
* the chain stops as soon as coverage is met;
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
from app.people import brightdata, circuit, pdl_company, providers
from app.people.openai_web import OpenAIWebPeopleProvider, WebDiscoveryOutcome
from app.people.schemas import ProviderPerson

COMPANY = "Northwind Robotics"
DOMAIN = "northwindrobotics.example"

PDL_BUDGET_EXHAUSTED = {
    "status": 402,
    "error": {"type": "payment_required", "message": "account maximum"},
}


def _sighting(slug: str, name: str, title: str) -> ProviderPerson:
    """What OpenAI's public-web step returns: a cited profile URL, unverified."""

    url = f"https://www.linkedin.com/in/{slug}"
    return ProviderPerson(
        provider="openai_web",
        provider_person_id=url,
        full_name=name,
        current_company_name=COMPANY,
        current_company_domain=DOMAIN,
        current_title=title,
        linkedin_url=url,
        current_role_indicator=True,
        provider_record_observed_at=datetime.now(UTC),
        provider_employment_updated_at=datetime.now(UTC),
        evidence={"supporting_sources": ["https://example.com/newsroom"]},
    )


def _bd_row(slug: str, name: str, title: str, *, company: str = COMPANY) -> dict:
    return {
        "name": name,
        "url": f"https://www.linkedin.com/in/{slug}",
        "position": title,
        "current_company": {"name": company},
        "city": "Austin",
        "country_code": "US",
    }


# What OpenAI reports, and what Bright Data confirms about the same people.
SIGHTINGS = [
    _sighting("priya-raghavan", "Priya Raghavan", "Recruiter"),
    _sighting("daniel-okafor", "Daniel Okafor", "Engineering Manager"),
]
VERIFIED_ROWS = [
    _bd_row("priya-raghavan", "Priya Raghavan", "Senior Technical Recruiter"),
    _bd_row("daniel-okafor", "Daniel Okafor", "Engineering Manager"),
]


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
        settings, "people_provider_order", ["openai_web", "brightdata", "pdl"]
    )
    monkeypatch.setattr(settings, "people_primary_provider", "openai_web")
    # Bright Data verifies; it never discovers.
    monkeypatch.setattr(settings, "people_brightdata_verification_enabled", True)
    monkeypatch.setattr(settings, "brightdata_api_token", "bd-token-not-a-secret")
    monkeypatch.setattr(settings, "people_brightdata_dataset_id", "gd_profiles")
    monkeypatch.setattr(settings, "people_brightdata_daily_record_budget", 500)
    monkeypatch.setattr(settings, "people_brightdata_per_user_daily_limit", 200)
    monkeypatch.setattr(settings, "people_brightdata_max_records_per_discovery", 10)
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
    """The documented synchronous collect-by-URL endpoint, and nothing else."""

    def __init__(self, rows: list[dict] | None = None, *, status: int = 200):
        self.rows = rows if rows is not None else []
        self.status = status
        self.calls: list[str] = []

    async def request(self, method, url, *, params=None, json=None, headers=None):
        request = httpx.Request(method, url)
        assert url.endswith("/scrape"), f"only collect-by-URL is supported: {url}"
        self.calls.append("bd_scrape")
        if self.status != 200:
            return httpx.Response(self.status, request=request, json={"error": "x"})
        requested = {item["url"] for item in (json or [])}
        return httpx.Response(
            200,
            request=request,
            json=[row for row in self.rows if row["url"] in requested],
        )


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
    # Capture the real class before replacing the name, or the factory would
    # recurse into its own patch.
    real_class = brightdata.BrightDataPeopleProvider
    monkeypatch.setattr(
        brightdata,
        "BrightDataPeopleProvider",
        lambda *_a, **_kw: real_class(client=bd),
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
# The corrected happy path: OpenAI discovers, Bright Data verifies
# --------------------------------------------------------------------------


def test_openai_discovers_and_brightdata_verifies_then_get_returns_them(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    harness = _install(
        monkeypatch,
        bd=_BrightDataTransport(VERIFIED_ROWS),
        web=SIGHTINGS,
    )
    headers = _auth(client, "verified@example.com")
    job_id = _job("chain-verified")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        response = client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    assert response.status_code == 200, response.text
    people = _people(response.json())
    assert len(people) == 2, response.json()

    # OpenAI found them; Bright Data confirmed them; the verified record is what
    # is shown — note the title comes from Bright Data, not from the sighting.
    assert harness["web_calls"] == ["openai_web"]
    assert "bd_scrape" in harness["bd"].calls
    by_name = {person["full_name"]: person for person in people}
    assert by_name["Priya Raghavan"]["current_title"] == "Senior Technical Recruiter"
    for person in people:
        assert person["professional_profile_url"].startswith(
            "https://www.linkedin.com/in/"
        )
        assert person["current_company"] == COMPANY

    run = _latest_run(job_id)
    assert run.status in {"complete", "partial"}
    context = run.company_context or {}
    assert context["verification"]["provider"] == "brightdata"
    assert context["verification"]["confirmed"] == 2
    assert "brightdata" in context["providers_attempted"]

    # GET returns exactly what was persisted, and spends nothing more.
    calls_after = len(harness["bd"].calls)
    follow_up = client.get(f"/jobs/{job_id}/people", headers=headers).json()
    assert len(_people(follow_up)) == 2
    assert len(harness["bd"].calls) == calls_after

    db = _session()
    assert db.scalar(select(PeopleUserDiscoveryQuota)).discoveries_used == 1
    assert len(_finalizations(caplog)) == 1


# --------------------------------------------------------------------------
# Verification failures
# --------------------------------------------------------------------------


def test_a_sighting_bright_data_cannot_confirm_is_never_displayed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Bright Data returns nothing for the URL: the profile is not shown."""

    _install(monkeypatch, bd=_BrightDataTransport([]), web=SIGHTINGS)
    headers = _auth(client, "unconfirmed@example.com")
    job_id = _job("chain-unconfirmed")

    with caplog.at_level(logging.INFO, logger="jobpilot.people"):
        payload = client.post(
            f"/jobs/{job_id}/people/discover", headers=headers
        ).json()

    assert _people(payload) == []
    run = _latest_run(job_id)
    assert (run.company_context or {})["verification"]["rejected"] == {
        "verification_no_record": 2
    }
    assert len(_finalizations(caplog)) == 1


def test_a_person_who_has_left_the_company_is_rejected_by_verification(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact failure verification exists to catch."""

    moved_on = [
        _bd_row(
            "priya-raghavan",
            "Priya Raghavan",
            "Senior Technical Recruiter",
            company="Somewhere Else Inc",
        )
    ]
    _install(monkeypatch, bd=_BrightDataTransport(moved_on), web=[SIGHTINGS[0]])
    headers = _auth(client, "moved-on@example.com")
    job_id = _job("chain-moved-on")

    payload = client.post(f"/jobs/{job_id}/people/discover", headers=headers).json()

    assert _people(payload) == []
    run = _latest_run(job_id)
    rejected = (run.company_context or {})["verification"]["rejected"]
    # Counted twice on purpose: the normalizer notes the employer did not match,
    # and verification records that the candidate was therefore not confirmed.
    assert rejected["verification_company_mismatch"] == 1
    assert rejected["company_mismatch"] == 1


def test_an_unsupported_url_is_dropped_before_a_record_is_spent(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OpenAI returned something that is not a profile URL."""

    unsupported = SIGHTINGS[0].model_copy(
        update={"linkedin_url": "https://www.linkedin.com/company/northwind"}
    )
    harness = _install(monkeypatch, bd=_BrightDataTransport([]), web=[unsupported])
    headers = _auth(client, "unsupported-url@example.com")
    job_id = _job("chain-unsupported-url")

    payload = client.post(f"/jobs/{job_id}/people/discover", headers=headers).json()

    assert _people(payload) == []
    # A company page could never be verified, so no Bright Data record is bought.
    assert harness["bd"].calls == []


def test_verification_being_unavailable_withholds_the_candidates(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No verifier means no evidence, and no evidence means nothing displayed."""

    monkeypatch.setattr(settings, "people_brightdata_verification_enabled", False)
    harness = _install(monkeypatch, bd=_BrightDataTransport(VERIFIED_ROWS), web=SIGHTINGS)
    headers = _auth(client, "no-verifier@example.com")
    job_id = _job("chain-no-verifier")

    payload = client.post(f"/jobs/{job_id}/people/discover", headers=headers).json()

    assert _people(payload) == []
    assert harness["bd"].calls == []
    run = _latest_run(job_id)
    assert (run.company_context or {})["verification"]["failure_reason"] == (
        "provider_not_configured"
    )


def test_a_verification_outage_never_erases_a_structured_providers_contacts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """PDL answers with its own contract, so a Bright Data outage cannot hurt it."""

    pdl_rows = [
        {
            "id": "pdl-1",
            "full_name": "Robin Vega",
            "job_title": "Technical Recruiter",
            "job_title_role": "human_resources",
            "job_company_name": COMPANY,
            "job_company_website": DOMAIN,
            "job_last_changed": datetime.now(UTC).isoformat(),
            "linkedin_url": "https://www.linkedin.com/in/robin-vega",
        }
    ]
    _install(
        monkeypatch,
        bd=_BrightDataTransport(status=500),
        web=SIGHTINGS,
        pdl=_PDLTransport(rows=pdl_rows, budget_exhausted=False),
    )
    headers = _auth(client, "bd-outage@example.com")
    job_id = _job("chain-bd-outage")

    payload = client.post(f"/jobs/{job_id}/people/discover", headers=headers).json()

    names = {person["full_name"] for person in _people(payload)}
    # The unverifiable public-web sightings are gone; PDL's contact stands.
    assert names == {"Robin Vega"}


# --------------------------------------------------------------------------
# Order, quota and cache
# --------------------------------------------------------------------------


def test_pdl_is_reached_only_when_the_providers_before_it_fall_short(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = _install(
        monkeypatch,
        bd=_BrightDataTransport([]),
        web=[],
        pdl=_PDLTransport(budget_exhausted=True),
    )
    headers = _auth(client, "pdl-last@example.com")
    job_id = _job("chain-pdl-last")

    client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    run = _latest_run(job_id)
    attempted = (run.company_context or {})["providers_attempted"]
    # OpenAI first, PDL last. Bright Data is a verification stage, not a
    # discovery provider, so it only appears when there was something to verify.
    assert attempted[0] == "openai_web"
    assert attempted[-1] == "pdl"
    assert harness["pdl"].calls, "PDL should have been reached once others fell short"


def test_one_deliberate_search_costs_exactly_one_unit_across_the_chain(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = _install(
        monkeypatch, bd=_BrightDataTransport(VERIFIED_ROWS), web=SIGHTINGS
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
    # A repeated POST is answered from cache.
    client.post(f"/jobs/{job_id}/people/discover", headers=headers)

    db = _session()
    assert db.scalar(select(PeopleUserDiscoveryQuota)).discoveries_used == 1
    assert len(harness["bd"].calls) == calls_after_search


def test_a_legacy_weak_cached_result_is_never_served(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = _install(
        monkeypatch, bd=_BrightDataTransport(VERIFIED_ROWS), web=SIGHTINGS
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

    # The retired run is not replayed: a real search ran and was verified.
    assert harness["web_calls"] == ["openai_web"]
    assert len(_people(payload)) == 2
