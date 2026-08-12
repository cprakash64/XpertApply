"""Compare provider record budgets against result quality, deterministically.

The 16→9 Person Search reduction was made on reasoning alone: "the funnel now
accepts more, so we can fetch less." That is plausible and completely unverified,
and it shipped alongside a configuration where the referral display cap (5) is
higher than the referral fetch limit (4) — a category made structurally unable
to fill. This harness exists to test the reduction instead of arguing about it.

**What this measures, and what it does not.** It runs the *real* production
gates — ``validate_current_employment``, ``evaluate_actionable_contact``,
``score_candidate``, ``candidate_rejection_reasons`` and the display caps — over
fixed candidate pools. So it faithfully measures *what the pipeline does with a
given pool*. It does **not** measure provider recall: the pools are synthetic,
and their composition is an assumption, not an observation.

The composition is anchored to the only real evidence available:

* Samsara discovery run 73 (stored locally): recruiter pool 4 raw → 1 accepted;
  referral pool 8 raw → 0 accepted pre-fix, 4 of 4 stored candidates accepted
  after the title-ontology v3 and referral-scoring fixes.
* One live PDL all-category run: 15 raw → 15 normalized → 11 accepted (73.3%).

Candidates are ordered as a provider returns them — best match first — because
truncating a ranked list is exactly what a smaller fetch limit does.

No provider is contacted and no credit is spent.

    python -m evaluation.people_recommendations.cost_strategy_benchmark
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))

from app.core.config import settings  # noqa: E402
from app.people.actionable import evaluate_actionable_contact  # noqa: E402
from app.people.employment_validation import validate_current_employment  # noqa: E402
from app.people.intelligence import expand_titles  # noqa: E402
from app.people.schemas import (  # noqa: E402
    JobPeopleSearchProfile,
    PeopleCategory,
    ProviderPerson,
)
from app.people.scoring import confidence, score_candidate  # noqa: E402

NOW = datetime(2026, 8, 3, tzinfo=UTC)

# Display caps actually configured in this environment.
DISPLAY_CAPS: dict[PeopleCategory, int] = {
    "likely_recruiter": settings.people_max_displayed_recruiters,
    "potential_hiring_manager": settings.people_max_displayed_managers,
    "potential_referrer": settings.people_max_displayed_referrers,
}


@dataclass(frozen=True)
class Strategy:
    name: str
    recruiter: int
    manager: int
    referral: int
    combined_team_pool: bool = False

    @property
    def total(self) -> int:
        return self.recruiter + self.manager + self.referral


STRATEGIES = (
    Strategy("A: 4/4/8 (previous)", 4, 4, 8),
    Strategy("B: 2/3/5", 2, 3, 5),
    Strategy("C: 2/3/4 (current)", 2, 3, 4),
    # D fetches one shared technical pool of 5 and classifies locally, so the
    # manager and referral columns draw from the same paid records.
    Strategy("D: 2 + shared 5", 2, 5, 0, combined_team_pool=True),
    # D with a pool large enough that referrals survive manager precedence.
    Strategy("D8: 2 + shared 8", 2, 8, 0, combined_team_pool=True),
    # E restores the manager fetch that B and C both regress on.
    Strategy("E: 2/4/4", 2, 4, 4),
)


@dataclass
class Candidate:
    """One record as a provider would return it."""

    title: str
    domain: str
    days_since_observed: int = 10
    current: bool = True
    profile_url: str | None = "https://www.linkedin.com/in/person-{i}"
    previous_employers: list[str] = field(default_factory=list)


@dataclass
class JobFixture:
    label: str
    job_title: str
    role_family: str | None
    company: str
    domain: str
    location: str | None
    recruiter_pool: list[Candidate]
    team_pool: list[Candidate]


def _person(index: int, candidate: Candidate, company: str) -> ProviderPerson:
    url = candidate.profile_url
    if url and "{i}" in url:
        url = url.format(i=index)
    observed = NOW - timedelta(days=candidate.days_since_observed)
    return ProviderPerson(
        provider="pdl",
        provider_person_id=f"pdl-{index}",
        full_name=f"Person Number{index}",
        current_company_name=company,
        current_company_domain=candidate.domain,
        current_title=candidate.title,
        location="San Francisco, California",
        linkedin_url=url,
        provider_record_observed_at=observed,
        provider_employment_updated_at=observed,
        current_role_indicator=candidate.current,
        previous_employers=candidate.previous_employers,
    )


def _profile(fixture: JobFixture) -> JobPeopleSearchProfile:
    recruiters, managers, team = expand_titles(fixture.job_title, fixture.role_family)
    return JobPeopleSearchProfile(
        company_name=fixture.company,
        company_normalized_name=fixture.company.lower(),
        company_domain=fixture.domain,
        job_title=fixture.job_title,
        role_family=fixture.role_family,
        department="Engineering" if fixture.role_family else None,
        location=fixture.location,
        recruiter_titles=recruiters,
        hiring_manager_titles=managers,
        team_member_titles=team,
        extraction_confidence=0.9,
    )


def _accepts(
    person: ProviderPerson,
    profile: JobPeopleSearchProfile,
    category: PeopleCategory,
) -> bool:
    """The real production gate chain for one candidate."""

    employment = validate_current_employment(person, profile, now=NOW)
    decision = evaluate_actionable_contact(
        person, profile, category=category, employment_status=employment.status
    )
    if not decision.accepted:
        return False
    score = score_candidate(
        category, person, profile, relationship_signals_available=False
    )
    threshold = {
        "likely_recruiter": settings.people_min_recruiter_relevance,
        "potential_hiring_manager": settings.people_min_manager_relevance,
        "potential_referrer": settings.people_min_referrer_relevance,
    }[category]
    return score >= threshold and confidence(person) >= settings.people_min_data_confidence


def _classify(person: ProviderPerson, profile: JobPeopleSearchProfile) -> PeopleCategory | None:
    """Strategy D: one paid pool, classified locally by display precedence."""

    for category in ("likely_recruiter", "potential_hiring_manager", "potential_referrer"):
        if _accepts(person, profile, category):  # type: ignore[arg-type]
            return category  # type: ignore[return-value]
    return None


def run_strategy(fixture: JobFixture, strategy: Strategy) -> dict[str, object]:
    profile = _profile(fixture)
    accepted: dict[PeopleCategory, int] = {
        "likely_recruiter": 0,
        "potential_hiring_manager": 0,
        "potential_referrer": 0,
    }
    fetched = 0
    seen: set[str] = set()

    # Recruiter pool.
    for index, candidate in enumerate(fixture.recruiter_pool[: strategy.recruiter]):
        fetched += 1
        person = _person(index, candidate, fixture.company)
        if person.linkedin_url in seen:
            continue
        if _accepts(person, profile, "likely_recruiter"):
            seen.add(person.linkedin_url or f"id{index}")
            accepted["likely_recruiter"] += 1

    if strategy.combined_team_pool:
        # One paid pool serving both manager and referral sections.
        for offset, candidate in enumerate(fixture.team_pool[: strategy.manager]):
            fetched += 1
            person = _person(100 + offset, candidate, fixture.company)
            if person.linkedin_url in seen:
                continue
            category = _classify(person, profile)
            if category is not None:
                seen.add(person.linkedin_url or f"id{offset}")
                accepted[category] += 1
    else:
        # Separate manager and referral queries draw from the same underlying
        # employee population, which is why the same pool is sliced twice.
        for offset, candidate in enumerate(fixture.team_pool[: strategy.manager]):
            fetched += 1
            person = _person(200 + offset, candidate, fixture.company)
            if _accepts(person, profile, "potential_hiring_manager"):
                seen.add(person.linkedin_url or f"m{offset}")
                accepted["potential_hiring_manager"] += 1
        for offset, candidate in enumerate(fixture.team_pool[: strategy.referral]):
            fetched += 1
            person = _person(300 + offset, candidate, fixture.company)
            if person.linkedin_url in seen:
                continue
            if _accepts(person, profile, "potential_referrer"):
                accepted["potential_referrer"] += 1

    displayed = {
        category: min(count, DISPLAY_CAPS[category])
        for category, count in accepted.items()
    }
    return {
        "records_fetched": fetched,
        "accepted": accepted,
        "displayed": displayed,
        "empty_categories": [c for c, n in displayed.items() if n == 0],
        "paid_records_rejected": fetched - sum(accepted.values()),
    }


# --- Fixtures -----------------------------------------------------------------


def _recruiters(domain: str) -> list[Candidate]:
    """Ranked recruiter pool: real recruiters first, then noise."""

    return [
        Candidate("Technical Recruiter", domain),
        Candidate("University Recruiter", domain),
        Candidate("Recruiting Coordinator", domain, days_since_observed=400),
        Candidate("Technical Recruiter", domain, current=False),
    ]


def _engineers(domain: str) -> list[Candidate]:
    """Ranked technical pool mixing managers and individual contributors."""

    return [
        Candidate("Engineering Manager", domain),
        Candidate("Senior Software Engineer", domain),
        Candidate("Software Engineer", domain),
        Candidate("Director of Engineering", domain),
        Candidate("Senior Software Engineer", domain, profile_url=None),
        Candidate("Software Engineer", domain, current=False),
        Candidate("Software Engineer", domain, days_since_observed=900),
        Candidate("Software Engineer", "contractor.example"),
    ]


FIXTURES = [
    JobFixture("Software Engineering Internship", "Software Engineering Internship 2027",
               "software_engineering", "Samsara", "samsara.com", "San Francisco, California",
               _recruiters("samsara.com"), _engineers("samsara.com")),
    JobFixture("Machine Learning Engineer", "Machine Learning Engineer", "machine_learning",
               "Postman", "postman.com", "San Francisco, California",
               _recruiters("postman.com"), _engineers("postman.com")),
    JobFixture("Backend/Platform Engineer", "Backend Platform Engineer", "software_engineering",
               "Vercel", "vercel.com", "Remote", _recruiters("vercel.com"), _engineers("vercel.com")),
    JobFixture("Product Manager", "Senior Product Manager", "product", "Chime", "chime.com",
               "San Francisco, California", _recruiters("chime.com"),
               [Candidate("Group Product Manager", "chime.com"),
                Candidate("Product Manager", "chime.com"),
                Candidate("Senior Product Manager", "chime.com"),
                Candidate("Director of Product", "chime.com"),
                Candidate("Product Manager", "chime.com", current=False),
                Candidate("Software Engineer", "chime.com"),
                Candidate("Product Manager", "chime.com", days_since_observed=900),
                Candidate("Product Designer", "chime.com")]),
    JobFixture("Civil Engineer", "Civil Engineer", None, "Bechtel", "bechtel.com", "Houston, Texas",
               _recruiters("bechtel.com"),
               [Candidate("Civil Engineering Manager", "bechtel.com"),
                Candidate("Senior Civil Engineer", "bechtel.com"),
                Candidate("Civil Engineer", "bechtel.com"),
                Candidate("Structural Engineer", "bechtel.com"),
                Candidate("Software Engineer", "bechtel.com"),
                Candidate("Civil Engineer", "bechtel.com", current=False),
                Candidate("Project Engineer", "bechtel.com"),
                Candidate("Civil Engineer", "bechtel.com", days_since_observed=900)]),
    JobFixture("Sales role", "Enterprise Account Executive", "sales", "Flock Safety",
               "flocksafety.com", "Atlanta, Georgia", _recruiters("flocksafety.com"),
               [Candidate("Sales Manager", "flocksafety.com"),
                Candidate("Enterprise Account Executive", "flocksafety.com"),
                Candidate("Account Executive", "flocksafety.com"),
                Candidate("Director of Sales", "flocksafety.com"),
                Candidate("Account Executive", "flocksafety.com", current=False),
                Candidate("Software Engineer", "flocksafety.com"),
                Candidate("Sales Development Representative", "flocksafety.com"),
                Candidate("Account Executive", "flocksafety.com", days_since_observed=900)]),
    JobFixture("Non-technical operations", "Operations Coordinator", None, "Mongodb",
               "mongodb.com", "New York, New York", _recruiters("mongodb.com"),
               [Candidate("Operations Manager", "mongodb.com"),
                Candidate("Operations Coordinator", "mongodb.com"),
                Candidate("Business Operations Analyst", "mongodb.com"),
                Candidate("Director of Operations", "mongodb.com"),
                Candidate("Operations Coordinator", "mongodb.com", current=False),
                Candidate("Software Engineer", "mongodb.com"),
                Candidate("Operations Associate", "mongodb.com"),
                Candidate("Operations Coordinator", "mongodb.com", days_since_observed=900)]),
    JobFixture("Remote role", "Senior Software Engineer, Remote", "software_engineering",
               "Bosch", "bosch.com", "Remote", _recruiters("bosch.com"), _engineers("bosch.com")),
    JobFixture("Site-specific role", "Embedded Software Engineer, Stuttgart",
               "embedded_systems", "Bosch", "bosch.com", "Stuttgart, Germany",
               _recruiters("bosch.com"), _engineers("bosch.com")),
]


def main() -> int:
    print(f"Display caps: {DISPLAY_CAPS}")
    print(f"Fixtures: {len(FIXTURES)}   (synthetic pools; measures pipeline, not provider recall)\n")
    totals: dict[str, dict[str, int]] = {}
    for strategy in STRATEGIES:
        agg = {"records": 0, "recruiter": 0, "manager": 0, "referral": 0,
               "empty_slots": 0, "rejected": 0}
        for fixture in FIXTURES:
            result = run_strategy(fixture, strategy)
            agg["records"] += int(result["records_fetched"])
            displayed = result["displayed"]  # type: ignore[index]
            agg["recruiter"] += displayed["likely_recruiter"]
            agg["manager"] += displayed["potential_hiring_manager"]
            agg["referral"] += displayed["potential_referrer"]
            agg["empty_slots"] += len(result["empty_categories"])  # type: ignore[arg-type]
            agg["rejected"] += int(result["paid_records_rejected"])
        totals[strategy.name] = agg

    header = (
        f"{'strategy':24} {'records':>8} {'recr':>5} {'mgr':>5}"
        f" {'refr':>5} {'empty':>6} {'wasted':>7}"
    )
    print(header)
    print("-" * len(header))
    for name, agg in totals.items():
        print(f"{name:24} {agg['records']:8} {agg['recruiter']:5} {agg['manager']:5} "
              f"{agg['referral']:5} {agg['empty_slots']:6} {agg['rejected']:7}")

    baseline = totals["A: 4/4/8 (previous)"]
    print("\nvs Strategy A:")
    for name, agg in totals.items():
        if name == "A: 4/4/8 (previous)":
            continue
        saving = 100 * (1 - agg["records"] / max(1, baseline["records"]))
        lost = {
            "recruiter": baseline["recruiter"] - agg["recruiter"],
            "manager": baseline["manager"] - agg["manager"],
            "referral": baseline["referral"] - agg["referral"],
        }
        print(
            f"  {name:24} records -{saving:4.0f}%   coverage delta {lost}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
