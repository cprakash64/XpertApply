"""Bounded live verification that the PDL adapter works against the real API.

The scheme-less-``linkedin_url`` incident was invisible to the whole test suite
because every fixture encoded the shape the code wanted rather than the shape
People Data Labs sends. Fixtures cannot close that gap — only a real response
can. This script is that check, and it is deliberately the *only* thing in the
repository that spends provider credit.

    python -m scripts.verify_pdl_live --confirm-live-call --company postman.com

It is **opt-in**: without ``--confirm-live-call`` it does nothing. It is never
imported by the test suite and must never be wired into CI.

Cost is bounded and printed before anything is spent: at most one company
enrichment plus one person search per category (default: one category).

**Nothing identifying is printed.** No API key, no raw payload, no full name, no
profile URL, no email. People are reported only as aggregate counts, plus a
per-record shape summary (initials, whether a URL arrived, and whether it
carried a scheme) — which is precisely what is needed to confirm the contract
and nothing more.
"""

from __future__ import annotations

import argparse
import asyncio
import time
from collections import Counter
from typing import Any

from app.core.config import settings
from app.people.actionable import evaluate_actionable_contact
from app.people.providers import (
    PDLPeopleProvider,
    ProviderUnavailable,
)
from app.people.schemas import JobPeopleSearchProfile, PeopleCategory, PeopleSearchQuery

# Categories map to the three product sections.
_CATEGORIES: tuple[PeopleCategory, ...] = (
    "likely_recruiter",
    "potential_hiring_manager",
    "potential_referrer",
)

_TITLES: dict[PeopleCategory, list[str]] = {
    "likely_recruiter": [
        "Technical Recruiter",
        "Recruiter",
        "Talent Acquisition Partner",
        "University Recruiter",
    ],
    "potential_hiring_manager": [
        "Engineering Manager",
        "Director of Engineering",
        "Head of Machine Learning",
    ],
    "potential_referrer": [
        "Software Engineer",
        "Machine Learning Engineer",
        "Senior Software Engineer",
    ],
}


def _initials(full_name: str) -> str:
    """"Rita Recruiter" -> "R.R." — enough to tell records apart, and no more."""

    return ".".join(part[0].upper() for part in full_name.split() if part)[:8] + "."


def _profile(company_name: str, domain: str) -> JobPeopleSearchProfile:
    return JobPeopleSearchProfile(
        company_name=company_name,
        company_normalized_name=company_name.lower(),
        company_domain=domain,
        job_title="Software Engineer",
        role_family="software_engineering",
        recruiter_titles=_TITLES["likely_recruiter"],
        hiring_manager_titles=_TITLES["potential_hiring_manager"],
        team_member_titles=_TITLES["potential_referrer"],
        extraction_confidence=0.9,
    )


async def _run_category(
    provider: PDLPeopleProvider,
    profile: JobPeopleSearchProfile,
    category: PeopleCategory,
    limit: int,
) -> dict[str, Any]:
    query = PeopleSearchQuery(
        category=category,
        company_name=profile.company_name,
        company_domain=profile.company_domain,
        company_aliases=[],
        titles=_TITLES[category],
        title_group=f"{category}_live_check",
        location_filter_mode="none",
        limit=limit,
    )

    started = time.monotonic()
    status = "success"
    rows: list[Any] = []
    try:
        rows = await provider.search_people(query)
    except ProviderUnavailable as exc:
        status = f"provider_unavailable:{exc.reason}"
    latency_ms = int((time.monotonic() - started) * 1000)

    raw_count = int(getattr(provider, "last_search_raw_count", len(rows)))
    normalized = int(getattr(provider, "last_search_normalized_count", len(rows)))

    accepted = 0
    rejections: Counter[str] = Counter()
    shapes: list[str] = []
    for person in rows:
        decision = evaluate_actionable_contact(
            person,
            profile,
            category=category,
            employment_status="exact_company_current_but_unverified_freshness",
        )
        if decision.accepted:
            accepted += 1
        for reason in decision.rejection_reasons:
            rejections[reason] += 1
        shapes.append(
            f"{_initials(person.full_name)} url={'yes' if person.linkedin_url else 'no'} "
            f"src={person.field_provenance.get('linkedin_url', '?')}"
        )

    return {
        "category": category,
        "status": status,
        "latency_ms": latency_ms,
        "raw_result_count": raw_count,
        "normalized_result_count": normalized,
        "actionable_accepted": accepted,
        "rejections_by_reason": dict(rejections),
        "record_shapes": shapes[:10],
    }


async def _main(args: argparse.Namespace) -> int:
    if not (settings.pdl_api_key or "").strip():
        print("PDL_API_KEY is not set. Live verification is BLOCKED.")
        return 2

    categories = (
        _CATEGORIES if args.all_categories else (args.category,)  # type: ignore[assignment]
    )
    max_calls = len(categories) + (1 if args.resolve_company else 0)
    print("=" * 72)
    print("LIVE PDL VERIFICATION — this spends real provider credit.")
    print(f"  company        : {args.company}")
    print(f"  categories     : {', '.join(categories)}")
    print(f"  max records    : {args.limit} per category")
    print(f"  max API calls  : {max_calls}")
    print("  api key        : [set, not printed]")
    print("=" * 72)

    if not args.confirm_live_call:
        print("\nDry run. Re-run with --confirm-live-call to actually call PDL.")
        return 0

    provider = PDLPeopleProvider()
    domain = args.company.strip().lower()
    company_name = args.company_name or domain.split(".")[0]
    profile = _profile(company_name, domain)

    if args.resolve_company:
        started = time.monotonic()
        try:
            identity = await provider.resolve_company(
                raw_name=company_name,
                normalized_name=company_name.lower(),
                verified_domain=domain,
            )
            print(
                f"\ncompany_resolution: searchable={identity.searchable} "
                f"latency_ms={int((time.monotonic() - started) * 1000)}"
            )
        except ProviderUnavailable as exc:
            print(f"\ncompany_resolution: FAILED reason={exc.reason}")

    results = []
    for category in categories:
        result = await _run_category(provider, profile, category, args.limit)
        results.append(result)
        print(f"\n--- {result['category']} ---")
        print(f"  status                  : {result['status']}")
        print(f"  latency_ms              : {result['latency_ms']}")
        print(f"  raw_result_count        : {result['raw_result_count']}")
        print(f"  normalized_result_count : {result['normalized_result_count']}")
        print(f"  actionable_accepted     : {result['actionable_accepted']}")
        print(f"  rejections_by_reason    : {result['rejections_by_reason']}")
        for shape in result["record_shapes"]:
            print(f"    - {shape}")

    usage = await provider.get_usage()
    total_norm = sum(r["normalized_result_count"] for r in results)
    total_acc = sum(r["actionable_accepted"] for r in results)
    missing_url = sum(
        r["rejections_by_reason"].get("missing_linkedin_url", 0) for r in results
    )

    print("\n" + "=" * 72)
    print("VERDICT")
    print(f"  provider requests        : {usage.requests}")
    print(f"  credits (provider count) : {usage.credits_used}")
    print(f"  normalized total         : {total_norm}")
    print(f"  accepted total           : {total_acc}")
    if total_norm:
        print(f"  acceptance ratio         : {total_acc / total_norm:.1%}")
        print(f"  missing-URL reject ratio : {missing_url / total_norm:.1%}")
    # A provider failure is not a pass. This script exists because the product
    # reported "nobody found" for what was really an integration failure; it
    # must not make the same mistake about itself.
    failed = [r for r in results if r["status"] != "success"]
    if failed:
        print("\n  INCONCLUSIVE: the provider did not answer, so nothing was verified.")
        for result in failed:
            print(f"    {result['category']}: {result['status']}")
        return 2
    if total_norm == 0:
        print(
            "\n  INCONCLUSIVE: the provider answered but returned no records for this\n"
            "  query. Contract not exercised. Try another company or category."
        )
        return 2
    if missing_url / total_norm > 0.5:
        print("\n  FAIL: profile URLs are still being dropped after canonicalization.")
        return 1
    if total_acc == 0:
        print("\n  FAIL: records normalized but none accepted. Inspect rejections above.")
        return 1
    print("\n  PASS: PDL records survive normalization and the actionable gate.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm-live-call",
        action="store_true",
        help="Required. Without it this prints the plan and exits.",
    )
    parser.add_argument("--company", default="postman.com", help="Company domain.")
    parser.add_argument("--company-name", default=None)
    parser.add_argument("--category", default="likely_recruiter", choices=_CATEGORIES)
    parser.add_argument("--all-categories", action="store_true")
    parser.add_argument("--limit", type=int, default=5, help="Max records per category.")
    parser.add_argument("--resolve-company", action="store_true")
    args = parser.parse_args()
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
