"""Provider waterfall for People discovery.

One discovery is one user action. Behind it, several providers may be tried in
a configured order until the categories the user asked for are covered:

    compatible cache -> PDL -> Apollo -> optional public web

The rules this module exists to enforce:

* **One user unit, many provider calls.** The caller reserves the user's single
  discovery action before entering the waterfall; nothing here spends another.
* **Independent provider budgets.** A spent PDL allowance stops PDL and nothing
  else. Previously it raised a 429 before any provider ran, which is why an
  exhausted PDL budget looked like "People search is unavailable" even with a
  funded Apollo account.
* **Gap filling, not repetition.** A provider is only asked for the categories
  its predecessors left short, so a good PDL answer never pays for an Apollo
  search of the same category.
* **Failure isolation.** One provider's outage classifies only its own circuit,
  and a later success hides the earlier failure from the user entirely.
* **A hard ceiling.** Total paid calls per discovery are capped regardless of
  how many providers are configured.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol

from app.core.config import settings
from app.people.errors import (
    PeopleErrorCode,
    code_for_reason,
    is_fallback_eligible,
)
from app.people.finalization import ProviderOutcome
from app.people.observability import metric
from app.people.provider_registry import KNOWN_PROVIDERS, normalize_provider_order
from app.people.schemas import PeopleCategory, ProviderPerson

__all__ = ["KNOWN_PROVIDERS", "normalize_provider_order"]

logger = logging.getLogger("jobpilot.people.waterfall")

PEOPLE_CATEGORIES: tuple[PeopleCategory, ...] = (
    "likely_recruiter",
    "potential_hiring_manager",
    "potential_referrer",
)


# Failures that must never be answered by trying a different provider. Each one
# describes the *request*, the *user*, or a deliberate stop — not the provider's
# health — so another provider would fail identically or should not be asked.
_NEVER_FALLBACK: frozenset[PeopleErrorCode] = frozenset(
    {
        PeopleErrorCode.INVALID_INPUT,
        PeopleErrorCode.COMPANY_DOMAIN_UNRESOLVED,
        PeopleErrorCode.USER_BUDGET_EXHAUSTED,
        PeopleErrorCode.REQUEST_CANCELLED,
    }
)


class SkipReason(StrEnum):
    """Why a provider did not run.

    Named individually because collapsing them into "unavailable" is what hid
    the live defect: a provider that was *misconfigured* (enabled, keyed, zero
    budget) logged the same thing as one that was deliberately switched off, so
    nothing in the logs distinguished "nobody wanted Apollo" from "Apollo was
    wanted and silently skipped on every discovery".
    """

    DISABLED = "disabled"
    MISSING_CREDENTIALS = "missing_credentials"
    INVALID_CONFIGURATION = "invalid_configuration"
    DAILY_BUDGET_EXHAUSTED = "daily_budget_exhausted"
    USER_BUDGET_EXHAUSTED = "user_budget_exhausted"
    CIRCUIT_OPEN = "circuit_open"
    TOTAL_CALL_LIMIT_REACHED = "total_call_limit_reached"
    UNSUPPORTED_OPERATION = "unsupported_operation"
    COMPANY_UNRESOLVED = "company_unresolved"


# Skip reasons an operator must act on: the provider was asked for but cannot
# run, as opposed to being legitimately switched off or temporarily spent.
ACTIONABLE_SKIPS: frozenset[SkipReason] = frozenset(
    {SkipReason.MISSING_CREDENTIALS, SkipReason.INVALID_CONFIGURATION}
)


@dataclass(frozen=True)
class ProviderAvailability:
    """Whether one provider may run right now, and why not when it may not."""

    provider: str
    available: bool
    reason: SkipReason | None = None
    detail: str | None = None

    @classmethod
    def ok(cls, provider: str) -> ProviderAvailability:
        return cls(provider=provider, available=True)

    @classmethod
    def blocked(
        cls, provider: str, reason: SkipReason, detail: str | None = None
    ) -> ProviderAvailability:
        return cls(provider=provider, available=False, reason=reason, detail=detail)

    def raise_if_blocked(self) -> None:
        if not self.available and self.reason is not None:
            raise ProviderSkipped(self.reason, self.detail)


class ProviderSkipped(Exception):
    """A provider was not run. Carries the typed, operator-facing reason."""

    def __init__(self, reason: SkipReason | str, detail: str | None = None) -> None:
        value = reason.value if isinstance(reason, SkipReason) else str(reason)
        super().__init__(value)
        self.reason = value
        self.detail = detail


@dataclass(frozen=True)
class CoverageTarget:
    """How much is enough. Reaching every target ends the waterfall."""

    recruiters: int
    managers: int
    referrers: int

    @classmethod
    def from_settings(cls) -> CoverageTarget:
        return cls(
            recruiters=max(0, int(settings.people_coverage_min_recruiters)),
            managers=max(0, int(settings.people_coverage_min_managers)),
            referrers=max(0, int(settings.people_coverage_min_referrers)),
        )

    def required(self, category: PeopleCategory) -> int:
        if category == "likely_recruiter":
            return self.recruiters
        if category == "potential_hiring_manager":
            return self.managers
        return self.referrers


@dataclass
class ProviderAttempt:
    """One provider's turn, recorded for diagnostics and metrics."""

    provider: str
    categories: tuple[PeopleCategory, ...]
    status: str = "pending"
    skip_reason: str | None = None
    # Free-text elaboration of skip_reason for operators. Never contains a
    # credential, a person, or a company.
    skip_detail: str | None = None
    failure_reason: str | None = None
    calls: int = 0
    raw_count: int = 0
    accepted_count: int = 0
    duration_ms: float = 0.0
    # Whether the chain was allowed to continue after this provider, and why.
    fallback_eligible: bool | None = None
    fallback_reason: str | None = None
    # Non-fatal provider problems: an enrichment this provider could not
    # complete while its search results survived. Never enough on their own to
    # fail a run that produced people.
    warnings: list[str] = field(default_factory=list)
    # The typed ProviderOutcome vocabulary, which distinguishes "searched fine,
    # could not enrich" from "could not search at all".
    provider_outcome: str | None = None
    # Per-stage counts for the funnel, all of them integers and none of them
    # derived from a person's data.
    stage_counts: dict[str, int] = field(default_factory=dict)

    @property
    def outcome(self) -> str:
        """One word for the step event: what actually happened to this provider."""

        if self.provider_outcome:
            return self.provider_outcome
        if self.status == "skipped":
            return self.skip_reason or "skipped"
        if self.status == "failed":
            return self.failure_reason or "failed"
        return self.status

    def safe_summary(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "categories": list(self.categories),
            "status": self.status,
            "outcome": self.outcome,
            "skip_reason": self.skip_reason,
            "failure_reason": self.failure_reason,
            "warnings": list(self.warnings),
            "fallback_eligible": self.fallback_eligible,
            "calls": self.calls,
            "raw_count": self.raw_count,
            "accepted_count": self.accepted_count,
            "stage_counts": dict(sorted(self.stage_counts.items())),
            "duration_ms": round(self.duration_ms, 1),
        }


@dataclass
class WaterfallResult:
    """Everything the caller needs to persist one discovery run."""

    candidates: dict[PeopleCategory, list[ProviderPerson]] = field(
        default_factory=lambda: {category: [] for category in PEOPLE_CATEGORIES}
    )
    attempts: list[ProviderAttempt] = field(default_factory=list)
    # Reasons carried forward for the *persisted* run. The user-facing layer
    # only reads these when nothing at all was found.
    failures: list[str] = field(default_factory=list)
    # Non-fatal provider problems across the chain. The finalizer only consults
    # these when nothing at all was accepted, so a rejected enrichment never
    # downgrades a run whose people survived — and never lets an earlier budget
    # stop take the blame for it either.
    warnings: list[str] = field(default_factory=list)
    no_match_categories: set[str] = field(default_factory=set)
    total_calls: int = 0
    duplicates_dropped: int = 0

    @property
    def providers_attempted(self) -> list[str]:
        return [attempt.provider for attempt in self.attempts if attempt.status != "skipped"]

    @property
    def provider_outcomes(self) -> dict[str, str]:
        """Every provider in the chain mapped to the typed outcome vocabulary.

        Derived rather than stored so a step that says nothing still gets a
        truthful outcome, and so the finalization event never has a provider
        missing from it.
        """

        outcomes: dict[str, str] = {}
        for attempt in self.attempts:
            if attempt.provider_outcome:
                value = attempt.provider_outcome
            elif attempt.status == "skipped":
                value = ProviderOutcome.PROVIDER_SKIPPED.value
            elif attempt.status == "failed":
                value = ProviderOutcome.SEARCH_FAILED.value
            elif attempt.accepted_count:
                value = ProviderOutcome.SEARCH_SUCCESS_ENRICHMENT_SUCCESS.value
            else:
                value = ProviderOutcome.SEARCH_NO_MATCH.value
            outcomes[attempt.provider] = value
        return outcomes

    @property
    def any_results(self) -> bool:
        return any(self.candidates[category] for category in PEOPLE_CATEGORIES)

    def coverage(self) -> dict[str, int]:
        return {category: len(self.candidates[category]) for category in PEOPLE_CATEGORIES}

    def safe_summary(self) -> dict[str, object]:
        return {
            "provider_attempts": [attempt.safe_summary() for attempt in self.attempts],
            "providers_attempted": self.providers_attempted,
            "provider_outcomes": self.provider_outcomes,
            "warnings": list(self.warnings),
            "total_provider_calls": self.total_calls,
            "coverage": self.coverage(),
            "duplicates_dropped": self.duplicates_dropped,
            "no_match_categories": sorted(self.no_match_categories),
        }


class ProviderStep(Protocol):
    """One provider's discovery entry point.

    Implementations run their own searches for exactly the categories asked of
    them and return normalized people. They raise :class:`ProviderSkipped` when
    a gate (disabled, no credentials, budget, circuit) says not to run.
    """

    name: str

    def gate(self, categories: tuple[PeopleCategory, ...]) -> None:
        """Raise ProviderSkipped when this provider must not run."""

    async def run(
        self, categories: tuple[PeopleCategory, ...], call_budget: int
    ) -> ProviderStepResult: ...


@dataclass
class ProviderStepResult:
    """What one provider produced."""

    candidates: dict[PeopleCategory, list[ProviderPerson]]
    calls: int = 0
    raw_count: int = 0
    # Categories the provider answered successfully with nobody. A result, not
    # a failure.
    no_match_categories: set[str] = field(default_factory=set)
    failure_reason: str | None = None
    # Problems that cost the run some data but not its people. An Apollo bulk
    # enrichment rejected with 422 belongs here, not in ``failure_reason``: the
    # search succeeded and the people it returned are still real.
    warnings: list[str] = field(default_factory=list)
    # Typed ProviderOutcome value. Left unset when the generic status
    # (success/no_match/failed) already says everything.
    outcome: str | None = None
    # Safe per-stage counts for the acceptance funnel.
    stage_counts: dict[str, int] = field(default_factory=dict)


def configured_provider_order() -> list[str]:
    """The runtime chain, in the order providers will actually be tried.

    Now that there is no inline "primary" stage, this list is the *only* thing
    that decides who runs and when — so PEOPLE_PRIMARY_PROVIDER has to be
    reconciled with it here rather than being silently ignored. A primary that
    is not listed is prepended: it was configured as the provider to try first,
    and dropping it would quietly disable a provider an operator asked for.
    Startup validation separately reports the mismatch so the configuration
    still gets fixed.
    """

    order = [
        name
        for name in normalize_provider_order(settings.people_provider_order)
        if name in KNOWN_PROVIDERS
    ]
    primary = str(settings.people_primary_provider).strip().lower()
    if not order:
        # A missing order must not disable the product; fall back to the primary
        # provider alone.
        return [primary] if primary in KNOWN_PROVIDERS else ["pdl"]
    if primary in KNOWN_PROVIDERS and primary not in order:
        return [primary, *order]
    return order


def categories_below_target(
    candidates: dict[PeopleCategory, list[ProviderPerson]],
    target: CoverageTarget,
) -> tuple[PeopleCategory, ...]:
    """Which categories still need people. Empty means the chain can stop."""

    return tuple(
        category
        for category in PEOPLE_CATEGORIES
        if len(candidates.get(category, [])) < target.required(category)
    )


def may_fall_back(result: ProviderStepResult, *, had_gap: bool) -> tuple[bool, str | None]:
    """Whether the next provider may be tried after this one, and why.

    Returns ``(allowed, reason)``. The reason names the trigger for logs and
    metrics; it is never shown to a user.
    """

    if not had_gap:
        return False, None
    reason = result.failure_reason
    if reason:
        code = code_for_reason(reason)
        if code in _NEVER_FALLBACK:
            return False, None
        if code is PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED:
            return (
                bool(settings.people_provider_fallback_on_budget_exhausted),
                "budget_exhausted",
            )
        if is_fallback_eligible(code):
            return True, reason
        # An unclassified provider failure still leaves a gap another provider
        # can plausibly fill, and cannot be worse than showing nothing.
        if code is PeopleErrorCode.UNKNOWN_PROVIDER_ERROR:
            return True, "unknown_provider_error"
        return False, None
    # The provider answered and simply did not have enough people.
    return bool(settings.people_provider_fallback_on_no_match), "no_match"


async def run_waterfall(
    steps: Sequence[ProviderStep],
    *,
    seed: dict[PeopleCategory, list[ProviderPerson]] | None = None,
    target: CoverageTarget | None = None,
    merge: Callable[
        [dict[PeopleCategory, list[ProviderPerson]], dict[PeopleCategory, list[ProviderPerson]]],
        tuple[dict[PeopleCategory, list[ProviderPerson]], int],
    ]
    | None = None,
    on_attempt: Callable[[ProviderAttempt], None] | None = None,
    discovery_run_id: int | None = None,
) -> WaterfallResult:
    """Run providers in order until coverage is met or the chain is exhausted."""

    target = target or CoverageTarget.from_settings()
    merge_fn = merge or merge_candidates
    result = WaterfallResult()
    if seed:
        # The primary provider already ran; the chain continues from what it
        # found so coverage gaps — and duplicates — are judged against it.
        result.candidates = {
            category: list(seed.get(category, [])) for category in PEOPLE_CATEGORIES
        }
    max_calls = max(1, int(settings.people_provider_max_calls_per_discovery))

    for index, step in enumerate(steps):
        needed = categories_below_target(result.candidates, target)
        if not needed:
            break
        remaining_calls = max_calls - result.total_calls
        attempt = ProviderAttempt(provider=step.name, categories=needed)
        if remaining_calls <= 0:
            attempt.status = "skipped"
            attempt.skip_reason = SkipReason.TOTAL_CALL_LIMIT_REACHED.value
            attempt.fallback_eligible = False
            result.attempts.append(attempt)
            _record_attempt(attempt, on_attempt, discovery_run_id=discovery_run_id)
            break

        try:
            step.gate(needed)
        except ProviderSkipped as skipped:
            attempt.status = "skipped"
            attempt.skip_reason = skipped.reason
            attempt.skip_detail = skipped.detail
            # A skipped provider never got the chance to answer, so the chain
            # continues to the next one.
            attempt.fallback_eligible = True
            result.attempts.append(attempt)
            _record_attempt(attempt, on_attempt, discovery_run_id=discovery_run_id)
            metric(
                "people_provider_attempts_total",
                provider=step.name,
                outcome="skipped",
                reason=skipped.reason,
            )
            continue

        metric("people_provider_attempts_total", provider=step.name, outcome="attempted")
        started = time.monotonic()
        try:
            step_result = await step.run(needed, remaining_calls)
        except Exception as exc:  # noqa: BLE001 - a provider defect must not end the chain
            logger.warning(
                "people_waterfall provider=%s unexpected_error=%s discovery_run_id=%s",
                step.name,
                type(exc).__name__,
                discovery_run_id,
            )
            step_result = ProviderStepResult(
                candidates={category: [] for category in PEOPLE_CATEGORIES},
                failure_reason="provider_unavailable",
            )
        attempt.duration_ms = (time.monotonic() - started) * 1000
        attempt.calls = step_result.calls
        attempt.raw_count = step_result.raw_count
        attempt.failure_reason = step_result.failure_reason
        attempt.warnings = list(step_result.warnings)
        attempt.stage_counts = dict(step_result.stage_counts)
        result.warnings.extend(step_result.warnings)
        result.total_calls += step_result.calls

        merged, duplicates = merge_fn(result.candidates, step_result.candidates)
        accepted = sum(len(rows) for rows in step_result.candidates.values())
        result.candidates = merged
        result.duplicates_dropped += duplicates
        attempt.accepted_count = accepted
        result.no_match_categories |= step_result.no_match_categories
        if step_result.failure_reason:
            result.failures.append(step_result.failure_reason)
            attempt.status = "failed"
            metric(
                "people_provider_attempts_total",
                provider=step.name,
                outcome="failed",
                reason=step_result.failure_reason,
            )
            if code_for_reason(step_result.failure_reason) is (
                PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED
            ):
                metric("people_provider_budget_exhausted_total", provider=step.name)
        elif accepted:
            attempt.status = "success"
            metric("people_provider_success_total", provider=step.name)
        else:
            attempt.status = "no_match"
            metric("people_provider_no_match_total", provider=step.name)
        # The step's own typed outcome wins when it set one: only the step
        # knows whether a successful search was followed by a failed enrichment.
        attempt.provider_outcome = step_result.outcome
        if accepted:
            metric(
                "people_candidates_by_provider_total",
                accepted,
                provider=step.name,
            )
        if duplicates:
            metric("people_candidates_deduplicated_total", duplicates, provider=step.name)

        gap_remains = bool(categories_below_target(result.candidates, target))
        allowed, reason = may_fall_back(step_result, had_gap=gap_remains)
        attempt.fallback_eligible = allowed
        attempt.fallback_reason = reason
        result.attempts.append(attempt)
        _record_attempt(attempt, on_attempt, discovery_run_id=discovery_run_id)

        is_last = index == len(steps) - 1
        if not allowed:
            break
        if not is_last:
            metric(
                "people_provider_fallbacks_total",
                provider=step.name,
                reason=reason or "gap",
            )

    coverage = result.coverage()
    metric(
        "people_discovery_coverage",
        sum(coverage.values()),
        recruiters=coverage["likely_recruiter"],
        managers=coverage["potential_hiring_manager"],
        referrers=coverage["potential_referrer"],
    )
    return result


def _record_attempt(
    attempt: ProviderAttempt,
    on_attempt: Callable[[ProviderAttempt], None] | None,
    *,
    discovery_run_id: int | None = None,
) -> None:
    """Emit one structured step event per provider, then hand it to the caller.

    Every provider in the configured order produces exactly one of these,
    whether it ran, was skipped, failed, or found nobody — so "why was Apollo
    not attempted?" is answerable from the logs alone. An actionable skip is
    logged at WARNING because it means a configured provider cannot work until
    someone changes the configuration.

    Contains no person, no company, no credential: a provider name, a typed
    outcome, counts, and the fallback decision.
    """

    level = (
        logging.WARNING
        if attempt.skip_reason in {reason.value for reason in ACTIONABLE_SKIPS}
        else logging.INFO
    )
    logger.log(
        level,
        "people_provider_step provider=%s outcome=%s fallback_eligible=%s "
        "categories=%s calls=%s accepted=%s duration_ms=%s discovery_run_id=%s%s",
        attempt.provider,
        attempt.outcome,
        "unknown" if attempt.fallback_eligible is None else str(attempt.fallback_eligible).lower(),
        ",".join(attempt.categories) or "none",
        attempt.calls,
        attempt.accepted_count,
        round(attempt.duration_ms, 1),
        discovery_run_id if discovery_run_id is not None else "none",
        f" detail={attempt.skip_detail}" if attempt.skip_detail else "",
    )
    if on_attempt is not None:
        on_attempt(attempt)


# --------------------------------------------------------------------------
# Cross-provider identity
# --------------------------------------------------------------------------


def normalize_linkedin(value: str | None) -> str | None:
    """Comparison key for a LinkedIn profile: host-insensitive, path-only."""

    text = (value or "").strip().lower().rstrip("/")
    if not text or "/in/" not in text:
        return None
    return text.rsplit("/in/", 1)[-1].strip("/") or None


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").split()).lower()


def _identity_keys(person: ProviderPerson) -> list[str]:
    """Every key this person can be recognised by, strongest first.

    1. LinkedIn profile — the same profile is the same human.
    2. Provider crosswalk — the same provider id from the same provider.
    3. Verified work email — only ever set from a verified lookup.
    4. Name + company + title — the weakest, used only when nothing else exists.
    """

    keys: list[str] = []
    linkedin = normalize_linkedin(person.linkedin_url)
    if linkedin:
        keys.append(f"li:{linkedin}")
    if person.provider_person_id:
        keys.append(f"pid:{person.provider}:{person.provider_person_id}")
    email = str(person.evidence.get("verified_work_email") or "").strip().lower()
    if email:
        keys.append(f"em:{email}")
    keys.append(
        "nm:"
        + "|".join(
            (
                _normalize_text(person.full_name),
                _normalize_text(person.current_company_name),
                _normalize_text(person.current_title),
            )
        )
    )
    return keys


def _prefer(existing: ProviderPerson, incoming: ProviderPerson) -> ProviderPerson:
    """Combine two sightings of one person conservatively.

    The earlier provider wins the record itself (the chain is ordered by trust),
    and the later one may only *add* evidence the earlier lacked: a cited
    LinkedIn URL, a company domain, provenance. Employment status never gets
    upgraded by a weaker source — a public-web sighting cannot make an
    unverified employment look verified.
    """

    merged = existing.model_copy(deep=True)
    if not merged.linkedin_url and incoming.linkedin_url:
        merged.linkedin_url = incoming.linkedin_url
        merged.field_provenance = {
            **merged.field_provenance,
            "linkedin_url": incoming.field_provenance.get("linkedin_url", incoming.provider),
        }
    if not merged.current_company_domain and incoming.current_company_domain:
        merged.current_company_domain = incoming.current_company_domain
    if not merged.location and incoming.location:
        merged.location = incoming.location
    if not merged.source_profile_url and incoming.source_profile_url:
        merged.source_profile_url = incoming.source_profile_url
    # Employment evidence: keep the most conservative view.
    if merged.exact_company_match and incoming.exact_company_match is False:
        merged.exact_company_match = False
    if incoming.employment_verified_at and merged.employment_verified_at is None:
        # Only a real verification timestamp from a data provider counts; the
        # public-web adapter never sets one.
        merged.employment_verified_at = incoming.employment_verified_at
    also_seen = list(merged.evidence.get("also_seen_by") or [])
    if incoming.provider != merged.provider and incoming.provider not in also_seen:
        also_seen.append(incoming.provider)
    if also_seen:
        merged.evidence = {**merged.evidence, "also_seen_by": also_seen}
    return merged


def merge_candidates(
    existing: dict[PeopleCategory, list[ProviderPerson]],
    incoming: dict[PeopleCategory, list[ProviderPerson]],
) -> tuple[dict[PeopleCategory, list[ProviderPerson]], int]:
    """Merge a provider's people into the running set, without double-counting.

    A person already found in *any* category is not added again to another one:
    the first provider's categorisation stands, so a recruiter cannot also be
    counted as a referral candidate and inflate coverage.
    """

    merged: dict[PeopleCategory, list[ProviderPerson]] = {
        category: list(existing.get(category, [])) for category in PEOPLE_CATEGORIES
    }
    index: dict[str, tuple[PeopleCategory, int]] = {}
    for category in PEOPLE_CATEGORIES:
        for position, person in enumerate(merged[category]):
            for key in _identity_keys(person):
                index.setdefault(key, (category, position))

    duplicates = 0
    for category in PEOPLE_CATEGORIES:
        for person in incoming.get(category, []):
            keys = _identity_keys(person)
            hit = next((index[key] for key in keys if key in index), None)
            if hit is not None:
                held_category, position = hit
                merged[held_category][position] = _prefer(
                    merged[held_category][position], person
                )
                duplicates += 1
                continue
            merged[category].append(person)
            position = len(merged[category]) - 1
            for key in keys:
                index.setdefault(key, (category, position))
    return merged, duplicates
