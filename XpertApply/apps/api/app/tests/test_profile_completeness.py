"""Profile completion and autofill readiness: scoring rules, endpoint, privacy."""

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
from app.models import entities as E
from app.profile.completeness import (
    AUTOFILL_REQUIREMENTS,
    COMPLETION_SECTIONS,
    ProfileSignals,
    autofill_readiness,
    profile_completion,
)


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


def auth(client: TestClient, email: str = "pc@mailbox.test-domain.co") -> dict[str, str]:
    token = client.post(
        "/auth/signup", json={"email": email, "password": "password123"}
    ).json()
    return {"Authorization": f"Bearer {token['access_token']}"}


FULL_PROFILE = {
    "full_name": "Chandra Pandey",
    "application_email": "chandra@mailbox.test-domain.co",
    "phone": "602-555-0100",
    "location_city": "Phoenix",
    "location_state": "AZ",
    "location_country": "United States",
    "work_authorization": "authorized_us",
    "target_roles": ["Backend Engineer"],
    "target_levels": ["Junior"],
    "preferred_locations": ["United States"],
    "remote_preference": "remote",
    "skills": ["Python", "FastAPI"],
    "linkedin_url": "https://linkedin.com/in/chandra",
}

FULL_CAREER = {
    "education": [{"school": "Arizona State University", "degree": "BS"}],
    "experience": [
        {
            "company": "Cardinal Health",
            "title": "Software Engineer",
            "bullets": ["Built Python services"],
            "technologies": ["Python"],
            "currently_working": True,
        }
    ],
    "projects": [{"name": "Luna AI", "bullets": ["RAG pipeline"], "technologies": ["Python"]}],
    "certifications": [],
    "awards": [],
}


def completeness(client: TestClient, headers: dict[str, str]) -> dict:
    resp = client.get("/profile/completeness", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def answer_legal(client: TestClient, headers: dict[str, str]) -> None:
    for field, answer in (
        ("work_authorization_us", "yes"),
        ("sponsorship_required_now", "no"),
        ("sponsorship_required_future", "no"),
    ):
        resp = client.put(
            "/profile/application-eligibility",
            headers=headers,
            json={"field": field, "answer": answer},
        )
        assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- #
# Pure scoring rules
# --------------------------------------------------------------------------- #
def profile_stub(**overrides) -> E.UserProfile:
    defaults = {
        "first_name": "",
        "last_name": "",
        "full_name": "",
        "application_email": "",
        "phone": "",
        "location_city": "",
        "location_country": "",
        "linkedin_url": "",
        "github_url": "",
        "portfolio_url": "",
        "target_roles": [],
        "preferred_locations": [],
        "skills": [],
    }
    return E.UserProfile(**{**defaults, **overrides})


def test_missing_profile_scores_zero_rather_than_raising():
    signals = ProfileSignals(profile=None)
    assert profile_completion(signals)["percent"] == 0
    assert autofill_readiness(signals)["percent"] == 0
    # Everything is reported as missing, so the UI has a full to-do list.
    assert len(autofill_readiness(signals)["missing"]) == len(AUTOFILL_REQUIREMENTS)


def test_empty_profile_row_scores_zero():
    signals = ProfileSignals(profile=profile_stub())
    assert profile_completion(signals)["percent"] == 0
    assert autofill_readiness(signals)["percent"] == 0


def test_fully_populated_profile_scores_one_hundred():
    signals = ProfileSignals(
        profile=profile_stub(
            first_name="Chandra",
            last_name="Pandey",
            full_name="Chandra Pandey",
            application_email="c@example.test",
            phone="602-555-0100",
            location_city="Phoenix",
            location_country="United States",
            linkedin_url="https://linkedin.com/in/c",
            target_roles=["Backend Engineer"],
            preferred_locations=["United States"],
            skills=["Python"],
        ),
        education_count=1,
        experience_count=1,
        skills=["Python"],
        answered_legal_fields={
            "work_authorization_us",
            "sponsorship_required_now",
            "sponsorship_required_future",
        },
    )
    assert profile_completion(signals)["percent"] == 100
    assert autofill_readiness(signals)["percent"] == 100
    assert profile_completion(signals)["missing"] == []


def test_legacy_full_name_only_profile_still_counts_as_named():
    """A profile that predates the structured-name split has a usable name."""
    signals = ProfileSignals(profile=profile_stub(full_name="Chandra Pandey"))
    assert "identity" in profile_completion(signals)["satisfied"]


def test_location_requires_city_and_country():
    city_only = ProfileSignals(profile=profile_stub(location_city="Phoenix"))
    assert "location" not in autofill_readiness(city_only)["satisfied"]

    both = ProfileSignals(
        profile=profile_stub(location_city="Phoenix", location_country="United States")
    )
    assert "location" in autofill_readiness(both)["satisfied"]


def test_completion_and_readiness_are_independent_scores():
    """A rich career history with no phone is complete but not autofill-ready."""
    signals = ProfileSignals(
        profile=profile_stub(
            first_name="Chandra",
            last_name="Pandey",
            application_email="c@example.test",
            location_city="Phoenix",
            location_country="United States",
            linkedin_url="https://linkedin.com/in/c",
            target_roles=["Backend Engineer"],
            preferred_locations=["United States"],
            skills=["Python"],
        ),
        education_count=2,
        experience_count=3,
        skills=["Python"],
    )
    assert profile_completion(signals)["percent"] == 100
    readiness = autofill_readiness(signals)
    assert readiness["percent"] < 100
    assert {item["key"] for item in readiness["missing"]} >= {"phone", "work_authorization"}


def test_missing_entries_carry_a_human_label():
    signals = ProfileSignals(profile=profile_stub())
    labels = {item["label"] for item in autofill_readiness(signals)["missing"]}
    assert "Phone number" in labels
    assert "Application email" in labels


def test_scoring_rules_have_unique_keys():
    for rules in (COMPLETION_SECTIONS, AUTOFILL_REQUIREMENTS):
        keys = [key for key, _, _ in rules]
        assert len(keys) == len(set(keys))


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #
def test_completeness_requires_authentication(client: TestClient):
    assert client.get("/profile/completeness").status_code == 401


def test_completeness_reports_zero_for_a_brand_new_account(client: TestClient):
    headers = auth(client)
    payload = completeness(client, headers)
    assert payload["completion"]["percent"] == 0
    assert payload["autofillReadiness"]["percent"] == 0


def test_completeness_rises_as_the_profile_is_filled_in(client: TestClient):
    headers = auth(client, "rising@mailbox.test-domain.co")
    before = completeness(client, headers)["completion"]["percent"]

    client.put("/profile", headers=headers, json=FULL_PROFILE)
    after_profile = completeness(client, headers)["completion"]["percent"]
    assert after_profile > before

    client.put("/profile/career", headers=headers, json=FULL_CAREER)
    assert completeness(client, headers)["completion"]["percent"] == 100


def test_autofill_readiness_reaches_full_only_with_the_legal_answers(client: TestClient):
    headers = auth(client, "ready@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)

    partial = completeness(client, headers)["autofillReadiness"]
    assert partial["percent"] < 100
    assert {item["key"] for item in partial["missing"]} == {
        "work_authorization",
        "sponsorship",
    }

    answer_legal(client, headers)
    assert completeness(client, headers)["autofillReadiness"]["percent"] == 100


def test_autofill_readiness_does_not_depend_on_eeo(client: TestClient):
    """Voluntary demographics must never gate readiness."""
    headers = auth(client, "eeo@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)
    answer_legal(client, headers)

    assert completeness(client, headers)["autofillReadiness"]["percent"] == 100

    # Declining every EEO question must not move the score.
    resp = client.put(
        "/profile/demographics",
        headers=headers,
        json={
            "gender": "prefer_not_to_say",
            "race_ethnicity": ["prefer_not_to_say"],
            "veteran_status": "prefer_not_to_say",
            "disability_status": "prefer_not_to_say",
        },
    )
    assert resp.status_code in (200, 422), resp.text
    assert completeness(client, headers)["autofillReadiness"]["percent"] == 100


def test_completeness_never_returns_sensitive_values(client: TestClient):
    """The payload carries scores and field NAMES, never stored answers."""
    headers = auth(client, "privacy@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)
    answer_legal(client, headers)

    body = client.get("/profile/completeness", headers=headers).text
    for leaked in ("602-555-0100", "chandra@mailbox.test-domain.co", "Chandra"):
        assert leaked not in body
    for demographic in ("gender", "race", "veteran", "disability", "password"):
        assert demographic not in body.lower()


def test_completeness_is_scoped_to_the_signed_in_user(client: TestClient):
    filled = auth(client, "filled@mailbox.test-domain.co")
    empty = auth(client, "empty@mailbox.test-domain.co")
    client.put("/profile", headers=filled, json=FULL_PROFILE)
    client.put("/profile/career", headers=filled, json=FULL_CAREER)

    assert completeness(client, filled)["completion"]["percent"] == 100
    assert completeness(client, empty)["completion"]["percent"] == 0


def test_get_profile_contract_is_unchanged(client: TestClient):
    """The extension reads GET /profile; adding completeness must not alter it."""
    headers = auth(client, "contract@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)

    profile = client.get("/profile", headers=headers).json()["profile"]
    for key in (
        "full_name",
        "first_name",
        "last_name",
        "application_email",
        "phone",
        "phone_e164",
        "location_city",
        "location_country",
        "linkedin_url",
        "work_authorization",
        "work_authorization_status",
        "requires_sponsorship",
        "target_roles",
        "remote_preference",
        "work_preference",
        "skills",
        "workday_password_configured",
    ):
        assert key in profile, f"GET /profile must keep returning {key}"
    # And it must still never leak the stored secret itself.
    assert "workday_password" not in profile
    assert "workday_password_ciphertext" not in profile
    assert profile["workday_password_configured"] is False


def test_completeness_uses_a_bounded_number_of_queries(client: TestClient):
    """Section counts must not become one query per section."""
    from sqlalchemy import event

    headers = auth(client, "queries@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)

    db = next(app.dependency_overrides[get_db]())
    statements: list[str] = []

    @event.listens_for(db.get_bind(), "before_cursor_execute")
    def _record(conn, cursor, statement, params, context, executemany):
        statements.append(statement)

    completeness(client, headers)
    db.close()
    assert len(statements) <= 6, f"unexpected query fan-out: {len(statements)}"


def test_profile_row_is_reused_across_both_scores(client: TestClient):
    """Both scores come from one gather, so they always agree on the same data."""
    headers = auth(client, "shared@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    payload = completeness(client, headers)
    assert set(payload) == {"completion", "autofillReadiness", "enrichment"}
    for key in ("completion", "autofillReadiness"):
        score = payload[key]
        assert set(score) == {"percent", "satisfied", "missing"}
        assert 0 <= score["percent"] <= 100
    # Enrichment is a report, never a score.
    assert set(payload["enrichment"]) == {
        "certifications",
        "awards",
        "publications",
        "projects",
    }


# --------------------------------------------------------------------------- #
# Migration 0030: X + open-ended professional links
# --------------------------------------------------------------------------- #
def test_new_link_fields_round_trip(client: TestClient):
    headers = auth(client, "links@mailbox.test-domain.co")
    resp = client.put(
        "/profile",
        headers=headers,
        json={
            **FULL_PROFILE,
            "x_url": "https://x.com/chandra",
            "additional_links": [
                {"label": "Google Scholar", "url": "https://scholar.google.com/citations?user=x"},
                {"label": "Kaggle", "url": "https://kaggle.com/chandra"},
            ],
        },
    )
    assert resp.status_code == 200, resp.text

    profile = client.get("/profile", headers=headers).json()["profile"]
    assert profile["x_url"] == "https://x.com/chandra"
    assert [link["label"] for link in profile["additional_links"]] == [
        "Google Scholar",
        "Kaggle",
    ]


def test_profiles_without_the_new_fields_still_serialize(client: TestClient):
    """A row written before 0030 has NULL in both columns."""
    headers = auth(client, "legacylinks@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)

    profile = client.get("/profile", headers=headers).json()["profile"]
    assert profile["x_url"] is None
    # Never null — an absent list is an empty list.
    assert profile["additional_links"] == []


def test_existing_named_links_are_untouched_by_the_new_fields(client: TestClient):
    headers = auth(client, "keeplinks@mailbox.test-domain.co")
    client.put(
        "/profile",
        headers=headers,
        json={
            **FULL_PROFILE,
            "github_url": "https://github.com/chandra",
            "portfolio_url": "https://chandra.dev",
            "additional_links": [{"label": "Blog", "url": "https://blog.example"}],
        },
    )
    profile = client.get("/profile", headers=headers).json()["profile"]
    assert profile["linkedin_url"] == "https://linkedin.com/in/chandra"
    assert profile["github_url"] == "https://github.com/chandra"
    # HttpUrl normalizes a bare host with a trailing slash. That predates this
    # change and applies equally to the three original link columns.
    assert profile["portfolio_url"].rstrip("/") == "https://chandra.dev"


def test_unsafe_link_schemes_are_rejected_at_the_api(client: TestClient):
    headers = auth(client, "unsafelinks@mailbox.test-domain.co")
    for bad in ("javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"):
        resp = client.put(
            "/profile",
            headers=headers,
            json={**FULL_PROFILE, "additional_links": [{"label": "Bad", "url": bad}]},
        )
        assert resp.status_code == 422, f"{bad} must be rejected"

    resp = client.put(
        "/profile", headers=headers, json={**FULL_PROFILE, "x_url": "javascript:alert(1)"}
    )
    assert resp.status_code == 422


def test_additional_links_require_a_label(client: TestClient):
    headers = auth(client, "labelless@mailbox.test-domain.co")
    resp = client.put(
        "/profile",
        headers=headers,
        json={**FULL_PROFILE, "additional_links": [{"label": "", "url": "https://example.test"}]},
    )
    assert resp.status_code == 422


def test_additional_links_are_bounded(client: TestClient):
    """An unbounded list is an unbounded row; 20 is far beyond real use."""
    headers = auth(client, "manylinks@mailbox.test-domain.co")
    resp = client.put(
        "/profile",
        headers=headers,
        json={
            **FULL_PROFILE,
            "additional_links": [
                {"label": f"Link {i}", "url": f"https://example.test/{i}"} for i in range(21)
            ],
        },
    )
    assert resp.status_code == 422


def test_malformed_stored_links_are_dropped_rather_than_served(client: TestClient):
    """The column is JSON; nothing guarantees its shape forever."""
    headers = auth(client, "junklinks@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)

    db = next(app.dependency_overrides[get_db]())
    profile = db.scalar(select(E.UserProfile))
    profile.additional_links = [
        {"label": "Good", "url": "https://good.example"},
        {"label": "", "url": "https://nolabel.example"},
        {"url": "https://nolabelkey.example"},
        "not-a-dict",
        None,
    ]
    db.commit()
    db.close()

    links = client.get("/profile", headers=headers).json()["profile"]["additional_links"]
    assert links == [{"label": "Good", "url": "https://good.example"}]


# --------------------------------------------------------------------------- #
# Optional sections never gate either score
# --------------------------------------------------------------------------- #
def test_optional_sections_are_absent_from_both_rule_sets():
    """Certifications, awards and publications must not be requirements."""
    scored = {key for key, _, _ in COMPLETION_SECTIONS} | {
        key for key, _, _ in AUTOFILL_REQUIREMENTS
    }
    for optional in ("certifications", "awards", "publications", "eeo", "demographics"):
        assert optional not in scored


def test_a_profile_with_no_publications_can_still_be_complete(client: TestClient):
    """A candidate with no papers is not an incomplete candidate."""
    headers = auth(client, "nopubs@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)
    answer_legal(client, headers)

    payload = completeness(client, headers)
    assert payload["completion"]["percent"] == 100
    assert payload["autofillReadiness"]["percent"] == 100
    assert payload["enrichment"]["publications"] == 0


def test_adding_publications_does_not_change_either_score(client: TestClient):
    headers = auth(client, "addpubs@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)
    before = completeness(client, headers)

    client.put(
        "/profile/career",
        headers=headers,
        json={**FULL_CAREER, "publications": [{"title": "A paper", "venue": "IEEE"}]},
    )
    after = completeness(client, headers)

    assert after["completion"]["percent"] == before["completion"]["percent"]
    assert after["autofillReadiness"]["percent"] == before["autofillReadiness"]["percent"]
    # It is reported, just never scored.
    assert after["enrichment"]["publications"] == 1


def test_new_grad_profile_reaches_full_completion_without_enrichment(client: TestClient):
    """A student with education, one internship and skills is a complete profile."""
    headers = auth(client, "newgrad@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put(
        "/profile/career",
        headers=headers,
        json={
            "education": [{"school": "Arizona State University", "degree": "BS"}],
            "experience": [{"company": "Intern Co", "title": "Intern"}],
            "projects": [],
            "certifications": [],
            "awards": [],
            "publications": [],
        },
    )
    assert completeness(client, headers)["completion"]["percent"] == 100


def test_ask_each_time_is_reported_as_a_choice_not_an_omission(client: TestClient):
    headers = auth(client, "askeach@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)
    for field in ("work_authorization_us", "sponsorship_required_now", "sponsorship_required_future"):
        client.put(
            "/profile/application-eligibility",
            headers=headers,
            json={"field": field, "answer": "answer_each_time"},
        )

    readiness = completeness(client, headers)["autofillReadiness"]
    by_key = {item["key"]: item for item in readiness["missing"]}
    # Still not autofillable — that is the honest reading.
    assert "work_authorization" in by_key
    assert "sponsorship" in by_key
    # ...but reported as a deliberate choice rather than a gap.
    assert by_key["work_authorization"]["reason"] == "ask_each_time"
    assert "per application" in by_key["work_authorization"]["label"]


def test_a_genuinely_unanswered_field_is_not_labelled_as_a_choice(client: TestClient):
    headers = auth(client, "unanswered@mailbox.test-domain.co")
    client.put("/profile", headers=headers, json=FULL_PROFILE)
    client.put("/profile/career", headers=headers, json=FULL_CAREER)

    readiness = completeness(client, headers)["autofillReadiness"]
    by_key = {item["key"]: item for item in readiness["missing"]}
    assert "reason" not in by_key["work_authorization"]
