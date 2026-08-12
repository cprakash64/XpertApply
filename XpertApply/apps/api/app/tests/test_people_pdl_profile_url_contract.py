"""The PDL profile-URL contract, pinned against the provider's *real* wire format.

The production symptom: every company showed "No verified professional profiles
were found for this company yet." while the whole backend test suite passed.

The cause was a format mismatch that no test could see. People Data Labs returns
``linkedin_url`` **without a scheme** — ``"linkedin.com/in/<slug>"`` — and
``linkedin_username`` as a bare slug. ``safe_profile_url`` is the security
boundary and accepts only ``https``, so it was handed a value it must reject.
Every PDL record therefore normalized to ``linkedin_url=None``, and the
actionable gate then rejected all of them as ``missing_linkedin_url``. PDL is
the primary provider, so the feature returned nobody, and stored that as a
verified-empty result.

Every PDL fixture in the suite used ``https://www.linkedin.com/in/...`` — a form
PDL never sends — so the tests agreed with each other and disagreed with
production. These tests use the shapes the provider actually returns, which is
the only reason they would have caught it.

No provider account is contacted and no credit is spent in this file.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.core.config import settings
from app.people.actionable import evaluate_actionable_contact
from app.people.providers import PDL_DISCOVERY_STRATEGY_VERSION, _normalize_pdl
from app.people.schemas import JobPeopleSearchProfile
from app.people.security import (
    canonical_profile_url,
    profile_url_from_provider_username,
    safe_profile_url,
)

COMPANY = "Postman"
DOMAIN = "postman.com"


@pytest.fixture(autouse=True)
def _thresholds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "people_require_linkedin_for_display", True)
    monkeypatch.setattr(settings, "people_min_data_confidence", 0.3)


def _profile() -> JobPeopleSearchProfile:
    return JobPeopleSearchProfile(
        company_name=COMPANY,
        company_normalized_name="postman",
        company_domain=DOMAIN,
        job_title="AI Engineer Intern",
        role_family="machine_learning",
        recruiter_titles=["Technical Recruiter", "University Recruiter"],
        hiring_manager_titles=["Engineering Manager", "Director of Machine Learning"],
        team_member_titles=["Machine Learning Engineer", "Software Engineer"],
        extraction_confidence=0.9,
    )


def _pdl_row(**overrides: object) -> dict:
    """A People Data Labs person record in the shape PDL actually returns."""

    row = {
        "id": "qEnOZ5Oh0poWnQ1luFBfVw_0000",
        "full_name": "Rita Recruiter",
        "job_title": "Technical Recruiter",
        "job_company_name": COMPANY,
        "job_company_website": DOMAIN,
        # No scheme. This is the documented PDL representation.
        "linkedin_url": "linkedin.com/in/rita-recruiter",
        "linkedin_username": "rita-recruiter",
        "job_last_changed": datetime.now(UTC).date().isoformat(),
    }
    row.update(overrides)
    return row


# --- The canonicalizer itself -------------------------------------------------


CANONICAL = "https://www.linkedin.com/in/rita"


@pytest.mark.parametrize(
    "raw",
    [
        # The format that broke production.
        "linkedin.com/in/rita",
        "www.linkedin.com/in/rita",
        # Apollo's legacy scheme.
        "http://www.linkedin.com/in/rita",
        # Already canonical, and regional subdomains — the same global slug.
        "https://www.linkedin.com/in/rita",
        "https://uk.linkedin.com/in/rita",
        # Trailing slash, casing, ports, query and fragment are not different
        # people.
        "linkedin.com/in/rita/",
        "https://LinkedIn.COM/IN/Rita",
        "https://linkedin.com:443/in/rita",
        "linkedin.com/in/rita?utm_source=x&ref=y",
        "linkedin.com/in/rita#experience",
        # A profile subpage is the same person's profile.
        "linkedin.com/in/rita/detail/contact-info",
        "  linkedin.com/in/rita  ",
    ],
)
def test_every_surface_form_reduces_to_one_canonical_string(raw: str) -> None:
    """One person must be one string, because identity is compared by equality.

    ``_same_identity`` (service.py) compares these URLs with ``==``. Any surface
    variation that survives canonicalization becomes a duplicate contact card.
    """

    assert canonical_profile_url(raw) == CANONICAL


@pytest.mark.parametrize(
    "raw",
    [
        "linkedin.com/company/postman",  # a company page is not a person
        "linkedin.com/jobs/view/123",  # nor is a job posting
        "https://www.linkedin.com/pub/rita/1/2/3",  # legacy non-/in/ path
        "linkedin.com/in/",  # no slug identifies nobody
        "https://linkedin.com/in/",
        "evil.com/in/rita",  # host outside LinkedIn
        "linkedin.com.evil.com/in/rita",  # suffix-confusion host
        "https://attacker.example/linkedin.com/in/rita",  # host in the path
        "https://lіnkedin.com/in/rita",  # Cyrillic homoglyph host
        "https://xn--lnkedin-9zg.com/in/rita",  # punycode lookalike
        "javascript:alert(1)",
        "ftp://linkedin.com/in/rita",
        "https://user:pw@linkedin.com/in/rita",  # embedded credentials
        "//linkedin.com/in/rita",  # protocol-relative
        "/in/rita",  # relative path, no host
        "rita-recruiter",  # a bare name is never a URL
        "",
        None,
    ],
)
def test_canonicalization_never_relaxes_the_security_boundary(raw: str | None) -> None:
    """Canonicalizing changes the scheme. It must not widen what is accepted."""

    assert canonical_profile_url(raw) is None


@pytest.mark.parametrize(
    "raw",
    [
        "https://linkedin.com/in/rita/../../company/x",
        "https://linkedin.com/in/../company/x",
        "linkedin.com/in/rita/./../company/x",
    ],
)
def test_path_traversal_cannot_smuggle_a_non_profile_page(raw: str) -> None:
    """A defect found while auditing, not a hypothetical.

    ``safe_profile_url`` checks only that the path *starts with* "/in/", so
    "/in/rita/../../company/x" passed the person-profile gate while resolving,
    in any browser, to a company page. Relative segments are now refused.
    """

    assert canonical_profile_url(raw) is None


def test_the_same_person_from_two_providers_deduplicates() -> None:
    """The duplicate-contact defect, pinned end to end.

    PDL sends "linkedin.com/in/x"; Apollo sends "http://www.linkedin.com/in/x".
    ``_same_identity`` compares canonicalized URLs with ``==``, so before
    host/case normalization the same human survived deduplication and was
    rendered as two contact cards.
    """

    from app.people.service import _same_identity, deduplicate

    def person(provider: str, url: str) -> object:
        from app.people.schemas import ProviderPerson

        return ProviderPerson(
            provider=provider,
            provider_person_id=f"{provider}-1",
            full_name="Rita Recruiter",
            current_company_name=COMPANY,
            current_title="Technical Recruiter",
            linkedin_url=canonical_profile_url(url),
        )

    from_pdl = person("pdl", "linkedin.com/in/rita-recruiter")
    from_apollo = person("apollo", "http://www.linkedin.com/in/Rita-Recruiter")
    from_region = person("pdl", "https://uk.linkedin.com/in/rita-recruiter")

    assert _same_identity(from_pdl, from_apollo)
    assert len(deduplicate([from_pdl, from_apollo, from_region])) == 1


def test_canonicalizer_never_invents_a_url_from_a_name() -> None:
    """The fix must not become a pattern-guesser."""

    for name in ("Rita Recruiter", "rita recruiter", "Rita", "rita.recruiter"):
        assert canonical_profile_url(name) is None


def test_provider_username_helper_accepts_only_a_bare_slug() -> None:
    assert profile_url_from_provider_username("rita-recruiter") == (
        "https://www.linkedin.com/in/rita-recruiter"
    )
    for bad in ("", None, "a/b", "/", "x" * 201):
        assert profile_url_from_provider_username(bad) is None


def test_canonical_output_always_survives_the_unchanged_validator() -> None:
    """Whatever this produces must be independently acceptable to the gate."""

    for raw in (
        "linkedin.com/in/rita",
        "http://www.linkedin.com/in/rita",
        "https://uk.linkedin.com/in/rita",
    ):
        canonical = canonical_profile_url(raw)
        assert canonical is not None
        assert safe_profile_url(canonical) == canonical


# --- Normalization ------------------------------------------------------------


def test_scheme_less_pdl_record_keeps_its_profile_url() -> None:
    person = _normalize_pdl(_pdl_row())
    assert person is not None
    assert person.linkedin_url == "https://www.linkedin.com/in/rita-recruiter"
    assert person.source_profile_url == person.linkedin_url
    assert person.field_provenance["linkedin_url"] == "pdl:provider_url"


def test_username_is_used_only_when_the_provider_sent_no_url() -> None:
    row = _pdl_row()
    row.pop("linkedin_url")
    person = _normalize_pdl(row)
    assert person is not None
    assert person.linkedin_url == "https://www.linkedin.com/in/rita-recruiter"
    # The weaker provenance is recorded rather than hidden.
    assert person.field_provenance["linkedin_url"] == "pdl:provider_username"
    assert person.evidence["linkedin_url_source"] == "provider_username"


def test_record_with_no_usable_profile_reference_stays_unlinked() -> None:
    """Absence must stay absent — never backfilled with a guess."""

    person = _normalize_pdl(
        _pdl_row(linkedin_url="linkedin.com/company/postman", linkedin_username=None)
    )
    assert person is not None
    assert person.linkedin_url is None
    assert person.field_provenance["linkedin_url"] == "pdl:none"


# --- The funnel effect, which is what users actually saw ----------------------


def test_real_shaped_pdl_record_is_accepted_as_an_actionable_contact() -> None:
    """The regression itself: this record used to be dropped, emptying the feature."""

    person = _normalize_pdl(_pdl_row())
    assert person is not None
    decision = evaluate_actionable_contact(
        person,
        _profile(),
        category="likely_recruiter",
        employment_status="exact_company_current_but_unverified_freshness",
    )
    assert decision.accepted, decision.rejection_reasons
    assert "missing_linkedin_url" not in decision.rejection_reasons
    assert decision.candidate is not None
    assert decision.candidate.linkedin_url == "https://www.linkedin.com/in/rita-recruiter"


def test_a_genuinely_linkless_record_is_still_refused() -> None:
    """The fix must not turn the actionable gate off."""

    person = _normalize_pdl(_pdl_row(linkedin_url=None, linkedin_username=None))
    assert person is not None
    decision = evaluate_actionable_contact(
        person,
        _profile(),
        category="likely_recruiter",
        employment_status="exact_company_current_but_unverified_freshness",
    )
    assert not decision.accepted
    assert "missing_linkedin_url" in decision.rejection_reasons


def test_adapter_version_retires_results_stored_by_the_broken_adapter() -> None:
    """A v2 "nobody matched" recorded an adapter defect, not an answer.

    The version feeds PEOPLE_SEARCH_CONTRACT_VERSION, so bumping it invalidates
    those stored negative results instead of replaying them at users.
    """

    from app.people.service import PEOPLE_SEARCH_CONTRACT_VERSION

    assert PDL_DISCOVERY_STRATEGY_VERSION == "pdl-category-search-v3"
    assert PDL_DISCOVERY_STRATEGY_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION
