"""The product rule: fewer people, every one of them actionable.

The live symptom these pin: Apollo returned ``"Priya R███████"`` with no
LinkedIn URL and it rendered as a contact card. There *was* a masked-name check,
but it had one call site inside one provider's step, so every other path — PDL,
public web, persistence, the GET endpoint, the frontend — walked straight past
it.

No provider account is contacted and no credit is spent anywhere in this file.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.core.config import settings
from app.people.actionable import (
    ACTIONABLE_CONTACT_POLICY_VERSION,
    company_key,
    evaluate_actionable_contact,
    is_displayable_record,
    name_rejection,
)
from app.people.schemas import JobPeopleSearchProfile, ProviderPerson

COMPANY = "Northwind Robotics"
DOMAIN = "northwindrobotics.example"


@pytest.fixture(autouse=True)
def _thresholds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "people_min_data_confidence", 0.3)
    monkeypatch.setattr(settings, "people_require_linkedin_for_display", True)


def _profile() -> JobPeopleSearchProfile:
    return JobPeopleSearchProfile(
        company_name=COMPANY,
        company_normalized_name="northwind robotics",
        company_domain=DOMAIN,
        company_aliases=["Northwind"],
        job_title="Senior Backend Engineer",
        role_family="software_engineering",
        recruiter_titles=["Technical Recruiter", "Talent Acquisition Partner"],
        hiring_manager_titles=["Engineering Manager", "Director of Engineering"],
        team_member_titles=["Software Engineer", "Backend Engineer"],
        extraction_confidence=0.9,
    )


def _person(**overrides: object) -> ProviderPerson:
    base = {
        "provider": "brightdata",
        "provider_person_id": "https://www.linkedin.com/in/priya-raghavan",
        "full_name": "Priya Raghavan",
        "current_company_name": COMPANY,
        "current_company_domain": DOMAIN,
        "current_title": "Senior Technical Recruiter",
        "linkedin_url": "https://www.linkedin.com/in/priya-raghavan",
        "current_role_indicator": True,
        "provider_record_observed_at": datetime.now(UTC),
        "provider_employment_updated_at": datetime.now(UTC),
    }
    base.update(overrides)
    return ProviderPerson(**base)  # type: ignore[arg-type]


def _evaluate(person: ProviderPerson, **kwargs: object):
    return evaluate_actionable_contact(
        person,
        _profile(),
        category=kwargs.pop("category", "likely_recruiter"),  # type: ignore[arg-type]
        employment_status=kwargs.pop(
            "employment_status", "exact_company_current_but_unverified_freshness"
        ),  # type: ignore[arg-type]
        **kwargs,  # type: ignore[arg-type]
    )


# --------------------------------------------------------------------------
# Acceptance
# --------------------------------------------------------------------------


def test_a_complete_verified_identity_is_accepted():
    decision = _evaluate(_person())
    assert decision.accepted is True
    assert decision.rejection_reasons == []
    assert decision.candidate is not None
    assert decision.evidence["policy_version"] == ACTIONABLE_CONTACT_POLICY_VERSION
    assert decision.evidence["linkedin_validated"] is True


def test_an_accepted_candidate_carries_the_validated_url_not_the_raw_one():
    decision = _evaluate(
        _person(linkedin_url="https://WWW.LinkedIn.com/in/priya-raghavan/")
    )
    assert decision.accepted is True
    assert decision.candidate.linkedin_url == (
        "https://www.linkedin.com/in/priya-raghavan"
    )


def test_a_work_email_is_optional():
    decision = _evaluate(_person(evidence={}))
    assert decision.accepted is True


# --------------------------------------------------------------------------
# Names
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "Priya R███████",
        "Priya R",
        "Priya R.",
        "Priya ****",
        "John XXXXX",
        "LinkedIn Member",
        "Redacted Person",
    ],
)
def test_a_masked_or_incomplete_name_is_never_displayable(name):
    decision = _evaluate(_person(full_name=name))
    assert decision.accepted is False
    assert {"masked_name", "incomplete_name"} & set(decision.rejection_reasons)


@pytest.mark.parametrize("name", ["Priya Raghavan", "Na Kim", "Jo Ann Smith", "Sam User"])
def test_ordinary_names_are_not_mistaken_for_masking(name):
    """The policy must not withhold real people.

    "Na" is a common surname and "User" is an ordinary word; an over-eager
    placeholder list would silently drop both.
    """

    assert name_rejection(name) is None


# --------------------------------------------------------------------------
# LinkedIn
# --------------------------------------------------------------------------


def test_a_contact_without_linkedin_is_not_a_contact():
    decision = _evaluate(_person(linkedin_url=None))
    assert decision.accepted is False
    assert "missing_linkedin_url" in decision.rejection_reasons


@pytest.mark.parametrize(
    "url",
    [
        "http://www.linkedin.com/in/priya-raghavan",  # not HTTPS
        "https://profiles.invalid/in/priya-raghavan",  # wrong host
        "https://www.linkedin.com/company/northwind",  # a company page
        "https://www.linkedin.com/search/results/people/?keywords=priya",
        "https://www.linkedin.com/posts/priya-raghavan_hiring-activity",
    ],
)
def test_only_a_real_profile_url_counts(url):
    decision = _evaluate(_person(linkedin_url=url))
    assert decision.accepted is False
    assert "invalid_linkedin_url" in decision.rejection_reasons


def test_the_linkedin_requirement_can_be_lifted_for_internal_evaluation_only():
    decision = _evaluate(_person(linkedin_url=None), require_linkedin=False)
    assert decision.accepted is True


# --------------------------------------------------------------------------
# Employment
# --------------------------------------------------------------------------


def test_a_different_company_is_rejected():
    decision = _evaluate(
        _person(current_company_domain="other.example", current_company_name="Other Co")
    )
    assert decision.accepted is False
    assert "company_mismatch" in decision.rejection_reasons


def test_a_parent_or_subsidiary_domain_is_not_the_hiring_company():
    profile = _profile().model_copy(
        update={"parent_company_domain": "northwind-group.example"}
    )
    decision = evaluate_actionable_contact(
        _person(current_company_domain="northwind-group.example"),
        profile,
        category="likely_recruiter",
        employment_status="exact_company_current_but_unverified_freshness",
    )
    assert decision.accepted is False
    assert "company_mismatch" in decision.rejection_reasons


def test_a_former_employee_is_never_presented_as_current():
    decision = _evaluate(_person(), employment_status="former_employee")
    assert decision.accepted is False
    assert "past_employment_only" in decision.rejection_reasons


def test_a_conflicting_current_employer_is_rejected():
    decision = _evaluate(
        _person(), employment_status="conflicting_current_employment"
    )
    assert decision.accepted is False
    assert "conflicting_employment" in decision.rejection_reasons


def test_an_explicit_past_role_indicator_is_rejected():
    decision = _evaluate(_person(current_role_indicator=False))
    assert decision.accepted is False
    assert "past_employment_only" in decision.rejection_reasons


# --------------------------------------------------------------------------
# Title, confidence, ambiguity
# --------------------------------------------------------------------------


def test_a_title_that_does_not_support_the_category_is_rejected():
    decision = _evaluate(
        _person(current_title="Warehouse Operations Associate"),
        category="likely_recruiter",
    )
    assert decision.accepted is False
    assert "title_not_relevant_to_category" in decision.rejection_reasons


def test_a_manager_claim_accepts_an_unambiguous_seniority_token():
    decision = _evaluate(
        _person(current_title="Head of Platform Engineering"),
        category="potential_hiring_manager",
    )
    assert decision.accepted is True


def test_an_ambiguous_identity_is_rejected():
    decision = _evaluate(_person(evidence={"ambiguous_identity": True}))
    assert decision.accepted is False
    assert "ambiguous_identity" in decision.rejection_reasons


def test_confidence_below_the_floor_is_rejected():
    decision = _evaluate(_person(), min_confidence=0.99)
    assert decision.accepted is False
    assert "low_confidence" in decision.rejection_reasons


def test_every_failing_rule_is_reported_not_just_the_first():
    """An operator reading the funnel needs the whole picture."""

    decision = _evaluate(
        _person(
            full_name="Priya R███████",
            linkedin_url=None,
            current_company_domain="other.example",
        )
    )
    assert {"masked_name", "missing_linkedin_url", "company_mismatch"} <= set(
        decision.rejection_reasons
    )


# --------------------------------------------------------------------------
# The read-path guard
# --------------------------------------------------------------------------


def test_a_stored_row_is_re_checked_before_it_is_served():
    ok, reasons = is_displayable_record(
        full_name="Priya Raghavan",
        linkedin_url="https://www.linkedin.com/in/priya-raghavan",
        employment_validation_status="confirmed_exact_company_verified",
    )
    assert ok is True
    assert reasons == []


@pytest.mark.parametrize(
    ("name", "url", "status", "expected"),
    [
        (
            "Priya R███████",
            "https://www.linkedin.com/in/priya",
            "confirmed_exact_company_verified",
            "masked_name",
        ),
        (
            "Priya Raghavan",
            None,
            "confirmed_exact_company_verified",
            "missing_linkedin_url",
        ),
        (
            "Priya Raghavan",
            "https://profiles.invalid/in/priya",
            "confirmed_exact_company_verified",
            "invalid_linkedin_url",
        ),
        (
            "Priya Raghavan",
            "https://www.linkedin.com/in/priya",
            "former_employee",
            "unverified_employment",
        ),
    ],
)
def test_legacy_rows_written_under_a_laxer_contract_are_not_served(
    name, url, status, expected
):
    ok, reasons = is_displayable_record(
        full_name=name, linkedin_url=url, employment_validation_status=status
    )
    assert ok is False
    assert expected in reasons


# --------------------------------------------------------------------------
# Company matching
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("left", "right", "same"),
    [
        ("Acme, Inc.", "Acme", True),
        ("Acme Corporation", "acme corp", True),
        ("Northwind Robotics GmbH", "Northwind Robotics", True),
        # A real extra word is a different organization, and conflating the two
        # is how a contact at the wrong employer reaches a user.
        ("Vanderbilt University", "Vanderbilt University Medical Center", False),
        ("Acme Health", "Acme", False),
    ],
)
def test_company_matching_drops_legal_form_but_never_a_real_word(left, right, same):
    assert (company_key(left) == company_key(right)) is same


def test_a_stale_record_is_not_presented_as_current():
    decision = _evaluate(
        _person(
            provider_record_observed_at=datetime.now(UTC) - timedelta(days=1200),
            provider_employment_updated_at=datetime.now(UTC) - timedelta(days=1200),
        ),
        employment_status="stale_or_uncertain",
    )
    assert decision.accepted is False
    assert "unverified_employment" in decision.rejection_reasons
