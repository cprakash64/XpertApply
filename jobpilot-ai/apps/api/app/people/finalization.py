"""The one place a discovery decides what it is going to say happened.

Before this module, every branch of :func:`app.people.service.discover` wrote
its own final status. That is how a live run reached this state:

* PDL stopped on ``PROVIDER_BUDGET_EXHAUSTED``;
* Apollo was tried, searched successfully, and had its bulk enrichment rejected
  with HTTP 422 — a request-shape defect that has nothing to do with any budget;
* the Apollo failure was logged and then *dropped* rather than carried into the
  failure set;
* so the only reason left to report was PDL's budget, and the user was told
  "the provider budget has been reached" about a search the budget never
  stopped.

Two rules follow from that, and this module exists to make them structural
rather than a convention every future branch has to remember:

**One finalizer.** :class:`DiscoveryFinalization` computes the final status, the
final reason, the provider attribution, the quota decision, and the single
``people_waterfall_finalized`` event. No provider-specific branch writes a run
status of its own.

**Whole-chain precedence.** :func:`dominant_failure` ranks the *entire* chain's
failures. A budget exhaustion only speaks when every attempted provider was
blocked by a budget; any other kind of failure outranks it, because a budget
that merely caused the chain to move on is not the reason the user has nobody.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from app.people.errors import PeopleErrorCode, code_for_reason

logger = logging.getLogger("jobpilot.people.finalization")

# How a run's final status is decided. Bumping this retires every stored run
# whose status was written under the old rule.
#
# v2 was the first waterfall-era rule, and it was still wrong in production: it
# ranked failures correctly but never *saw* a follower's failure, because an
# enrichment rejection was swallowed inside the provider step. Runs recorded
# under v2 that say "provider_budget_exhausted" may therefore be describing a
# search some later provider actually answered.
#
# v4 changes what "accepted" means. A run is now finalized against the
# actionable-contact policy, so a v3 run that finished "complete" with two
# masked, linkless contacts is describing a result this product would no longer
# show at all. Neither may be replayed.
PEOPLE_FINALIZATION_VERSION = "people-finalization-v4"

# Which provider records this product is willing to show a user. Part of the
# contract because changing it changes whether a stored run's "nobody matched"
# is still true.
#
# v1: a person needed two usable name tokens.
# v2: also rejects repeated-letter stand-ins, placeholder identities such as
#     "LinkedIn Member", and — via the actionable-contact policy — any contact
#     without a validated LinkedIn profile or credible current employment.
PEOPLE_DISPLAY_POLICY_VERSION = "people-display-policy-v2"


class ProviderOutcome(StrEnum):
    """What one provider actually did, at the granularity operators ask about.

    "Failed" is far too coarse for the live defect: Apollo *searched
    successfully* and then failed to enrich, which is a completely different
    operational story from Apollo being unreachable — and a completely
    different user-facing result, because the people it found are still real.
    """

    SEARCH_SUCCESS_ENRICHMENT_SUCCESS = "search_success_enrichment_success"
    SEARCH_SUCCESS_ENRICHMENT_FAILED = "search_success_enrichment_failed"
    SEARCH_NO_MATCH = "search_no_match"
    SEARCH_FAILED = "search_failed"
    PROVIDER_SKIPPED = "provider_skipped"


# Whole-chain failure precedence, most decisive first.
#
# The tiers, and why they are in this order:
#
# 1. Authentication/authorization. JobPilot's own credential or account grant.
#    Nothing else can be fixed until this is.
# 2. Request/schema/integration. Our request was wrong. Reporting anything else
#    — especially a budget — blames the provider for our defect.
# 3. Transient outage. The provider was reachable but unhealthy right now.
# 4. Deliberate stops and unclassified failures.
# 5. Budget exhaustion, LAST. A spent budget stops one provider; it is only the
#    whole story when every provider that ran was stopped the same way, which
#    is exactly what "last" means here.
FINAL_FAILURE_PRECEDENCE: tuple[PeopleErrorCode, ...] = (
    PeopleErrorCode.AUTHENTICATION_FAILED,
    PeopleErrorCode.AUTHORIZATION_FAILED,
    PeopleErrorCode.INVALID_INPUT,
    PeopleErrorCode.COMPANY_DOMAIN_UNRESOLVED,
    PeopleErrorCode.RATE_LIMITED,
    PeopleErrorCode.PROVIDER_SERVER_ERROR,
    PeopleErrorCode.PROVIDER_TIMEOUT,
    PeopleErrorCode.NETWORK_ERROR,
    PeopleErrorCode.REQUEST_CANCELLED,
    PeopleErrorCode.UNKNOWN_PROVIDER_ERROR,
    PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED,
    PeopleErrorCode.USER_BUDGET_EXHAUSTED,
    PeopleErrorCode.NO_RESULTS,
)

_BUDGET_CODES: frozenset[PeopleErrorCode] = frozenset(
    {
        PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED,
        PeopleErrorCode.USER_BUDGET_EXHAUSTED,
    }
)

# Which run status a typed failure produces. Keeping these distinct is what
# lets the UI say "we could not identify the domain" instead of implying the
# provider is down.
STATUS_FOR_CODE: dict[PeopleErrorCode, str] = {
    PeopleErrorCode.COMPANY_DOMAIN_UNRESOLVED: "domain_unresolved",
    # A genuinely malformed request. Reachable now only by a real request
    # defect: a provider that answered a valid query with zero records is
    # handled as an empty result, not as a rejection.
    PeopleErrorCode.INVALID_INPUT: "invalid_request",
    PeopleErrorCode.USER_BUDGET_EXHAUSTED: "user_budget_exhausted",
    PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED: "provider_budget_exhausted",
    PeopleErrorCode.AUTHENTICATION_FAILED: "provider_configuration_error",
    PeopleErrorCode.AUTHORIZATION_FAILED: "provider_configuration_error",
}

# Every terminal state that is a failure rather than a result.
PROVIDER_ERROR_STATUSES = frozenset(
    {
        "provider_unavailable",
        "persistence_error",
        "domain_unresolved",
        "invalid_request",
        "user_budget_exhausted",
        "provider_budget_exhausted",
        "provider_configuration_error",
    }
)


# Characters providers use to mask the part of a name they will not disclose.
_MASK_CHARACTERS = re.compile(r"[*#•·…]|[▀-▟]|[░-▓]")
# A run of repeated letters standing in for a hidden word: "John XXXXX".
_REPEATED_MASK = re.compile(r"\b([a-z])\1{2,}\b", re.IGNORECASE)
# Names that are not names. LinkedIn itself serves "LinkedIn Member" for
# profiles it will not disclose, and it has two perfectly ordinary-looking
# tokens — which is exactly why a token count alone was never enough.
_PLACEHOLDER_NAMES = frozenset(
    {
        "linkedin member",
        "private person",
        "anonymous user",
        "unknown user",
        "confidential candidate",
        "no name",
        "not available",
    }
)
# Tokens that cannot be part of any real person's name. Deliberately short:
# "Na" is a common surname and "User" is an ordinary word, so neither belongs
# here — matching them would withhold real people.
_PLACEHOLDER_TOKENS = frozenset(
    {"redacted", "confidential", "placeholder", "withheld", "anonymous"}
)


def display_policy_rejection(full_name: str) -> str | None:
    """Why this record must not be shown as a contact, or ``None`` if it may be.

    Display policy v2. A contact needs two usable name tokens **and** none of
    the things a provider does when it will not tell you the name:

    * block-character or asterisk masking — ``"Priya R███████"``;
    * a repeated-letter stand-in — ``"John XXXXX"``, which has two perfectly
      well-formed tokens and passed v1;
    * a placeholder identity — ``"LinkedIn Member"``, likewise;
    * an initial presented as a surname — ``"Priya R."``.

    The record is still counted, still logged, and still usable as an internal
    search hint; it is simply never displayed, and the run says so truthfully
    rather than inheriting some earlier provider's budget stop.
    """

    text = " ".join((full_name or "").split())
    if not text:
        return "missing_name"
    normalized = " ".join(token.strip(".,").lower() for token in text.split())
    if normalized in _PLACEHOLDER_NAMES:
        return "obfuscated_surname"
    if set(normalized.split()) & _PLACEHOLDER_TOKENS:
        return "obfuscated_surname"
    if _MASK_CHARACTERS.search(text) or _REPEATED_MASK.search(text):
        return "obfuscated_surname"
    usable = [token for token in re.findall(r"[A-Za-z]+", text) if len(token) > 1]
    if len(usable) >= 2:
        return None
    if len(text.split()) > 1:
        return "obfuscated_surname"
    return "incomplete_name"


def dominant_failure(reasons: Sequence[str]) -> str | None:
    """The one failure the whole chain should be reported as.

    Ranked by :data:`FINAL_FAILURE_PRECEDENCE`, in which budget exhaustion sits
    last. That single property is what makes rule 3 of the failure-precedence
    contract hold — "PDL budget exhausted + Apollo schema error" can only ever
    resolve to the schema error — while rule 4 still holds automatically,
    because when every reason is a budget one there is nothing above it to win.
    """

    if not reasons:
        return None
    by_code: dict[PeopleErrorCode, str] = {}
    for reason in reasons:
        by_code.setdefault(code_for_reason(reason), reason)
    for code in FINAL_FAILURE_PRECEDENCE:
        if code in by_code:
            return by_code[code]
    return reasons[0]


def every_failure_was_a_budget_stop(reasons: Sequence[str]) -> bool:
    """True only when a budget is honestly the whole story.

    The user-facing "provider capacity has been reached" copy is gated on this,
    never on the mere presence of a budget failure somewhere in the chain.
    """

    codes = {code_for_reason(reason) for reason in reasons}
    return bool(codes) and codes <= _BUDGET_CODES


@dataclass(frozen=True)
class FinalOutcome:
    """The decision, before anything is written or logged."""

    status: str
    reason: str | None = None
    code: PeopleErrorCode | None = None

    @property
    def is_failure(self) -> bool:
        return self.status in PROVIDER_ERROR_STATUSES


def decide_outcome(
    *,
    accepted_count: int,
    failures: Sequence[str],
    warnings: Sequence[str] = (),
    no_match_categories: Sequence[str] | set[str] = (),
    coverage_incomplete: bool = False,
) -> FinalOutcome:
    """Resolve one discovery to one status and one reason.

    ``warnings`` are non-fatal provider problems — an Apollo enrichment that was
    rejected while its search results survived. They are deliberately invisible
    while anything was accepted: a person the user can actually contact is worth
    more than the field we failed to fetch for them. With nothing accepted, they
    become evidence like any other failure, which is what stops a swallowed
    enrichment rejection from letting an earlier budget stop take the blame.
    """

    if accepted_count > 0:
        degraded = bool(failures or warnings or no_match_categories or coverage_incomplete)
        return FinalOutcome(status="partial" if degraded else "complete")

    considered = [*failures, *warnings]
    if considered:
        reason = dominant_failure(considered) or "provider_unavailable"
        code = code_for_reason(reason)
        if code in _BUDGET_CODES and no_match_categories:
            # A budget stopped one provider, and another provider went on to
            # answer the question with nobody. The honest result is "we looked
            # and found no one", not "we could not look": the provider that
            # actually ran was never blocked by any budget.
            return FinalOutcome(status="complete")
        return FinalOutcome(
            status=STATUS_FOR_CODE.get(code, "provider_unavailable"),
            reason=reason,
            code=code,
        )
    # Every provider that ran answered, and answered with nobody. That is a
    # completed search with a truthful empty result, never a failure.
    return FinalOutcome(status="complete")


@dataclass
class FinalizationEvent:
    """The one structured line every discovery emits, whatever happened to it.

    Contains no person, no company, no credential, no provider response: run and
    job identifiers, provider names, typed outcomes, counts, and decisions.
    """

    job_id: int
    discovery_run_id: int | None
    provider_order: list[str] = field(default_factory=list)
    providers_attempted: list[str] = field(default_factory=list)
    provider_outcomes: dict[str, str] = field(default_factory=dict)
    accepted_count: int = 0
    accepted_sources: dict[str, int] = field(default_factory=dict)
    final_status: str = "unknown"
    final_reason: str | None = None
    quota_decision: str = "unknown"
    cache_decision: str = "miss"
    provider_calls: int = 0
    duration_ms: float = 0.0

    def emit(self) -> None:
        logger.info(
            "people_waterfall_finalized discovery_run_id=%s job_id=%s "
            "provider_order=%s providers_attempted=%s provider_outcomes=%s "
            "accepted_count=%s accepted_sources=%s final_status=%s "
            "final_reason=%s quota_decision=%s cache_decision=%s "
            "provider_calls=%s duration_ms=%s finalization_version=%s",
            self.discovery_run_id if self.discovery_run_id is not None else "none",
            self.job_id,
            ",".join(self.provider_order) or "none",
            ",".join(self.providers_attempted) or "none",
            dict(sorted(self.provider_outcomes.items())) or {},
            self.accepted_count,
            dict(sorted(self.accepted_sources.items())) or {},
            self.final_status,
            self.final_reason or "none",
            self.quota_decision,
            self.cache_decision,
            self.provider_calls,
            round(self.duration_ms, 1),
            PEOPLE_FINALIZATION_VERSION,
        )
