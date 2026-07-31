from __future__ import annotations

# ruff: noqa: E501
import hashlib
import json
import logging
import re
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.audit import record_audit
from app.core.config import settings
from app.models.entities import (
    Education,
    Experience,
    JobPeopleCandidate,
    JobPosting,
    PeopleDiscoveryRun,
    PeopleEmploymentVerificationRun,
    PeopleProviderOperationUsage,
    PeopleRecommendationFeedback,
    ProfessionalPerson,
    ProfessionalPersonSource,
    User,
    UserJobPeopleRecommendation,
    UserProfile,
)
from app.people.actionable import (
    ACTIONABLE_CONTACT_POLICY_VERSION,
    evaluate_actionable_contact,
    is_displayable_record,
)
from app.people.brightdata import BRIGHTDATA_PROFILE_STRATEGY_VERSION
from app.people.circuit import CircuitSnapshot, circuit_state
from app.people.coalescing import (
    provider_search_coalescer,
    search_identity,
)
from app.people.employment_validation import (
    EMPLOYMENT_EVIDENCE_VERSION,
    EMPLOYMENT_VALIDATION_VERSION,
    EmploymentValidationResult,
    validate_current_employment,
)
from app.people.errors import PeopleErrorCode, code_for_reason
from app.people.feature_flags import is_beta
from app.people.finalization import (
    PEOPLE_DISPLAY_POLICY_VERSION,
    PEOPLE_FINALIZATION_VERSION,
    PROVIDER_ERROR_STATUSES,
    FinalizationEvent,
    ProviderOutcome,
    decide_outcome,
    display_policy_rejection,
    every_failure_was_a_budget_stop,
)
from app.people.finalization import dominant_failure as _dominant_failure
from app.people.intelligence import extract_job_people_profile
from app.people.observability import metric
from app.people.openai_web import OPENAI_IDENTITY_VERSION, OpenAIWebPeopleProvider
from app.people.pdl_company import PDL_COMPANY_RESOLUTION_VERSION
from app.people.pdl_query import PDL_QUERY_LADDER_VERSION
from app.people.provider_usage import (
    ProviderUsageContext,
    ProviderUsagePersistenceError,
)
from app.people.providers import (
    APOLLO_ENRICHMENT_ADAPTER_VERSION,
    APOLLO_ENRICHMENT_STRATEGY_VERSION,
    PDL_DISCOVERY_STRATEGY_VERSION,
    ApolloPeopleProvider,
    PDLPeopleProvider,
    ProviderUnavailable,
    get_email_provider,
    get_people_provider,
)
from app.people.providers import (
    account_fingerprint as provider_account_fingerprint,
)
from app.people.quota import (
    quota_snapshot,
    reserve_user_discovery,
)
from app.people.schemas import (
    FeedbackRequest,
    JobPeopleSearchProfile,
    OutreachDraftRequest,
    PeopleCategory,
    PeopleSearchQuery,
    PersonEnrichmentRequest,
    ProviderPerson,
    WorkEmailRequest,
)
from app.people.scoring import (
    SCORING_VERSION,
    candidate_rejection_reasons,
    confidence,
    confidence_label,
    explanations,
    normalize_text,
    score_candidate,
)
from app.people.security import (
    decrypt_email,
    email_hash,
    encrypt_email,
    is_professional_email,
    safe_profile_url,
)
from app.people.title_ontology import (
    TitleGroup,
    is_early_career_job,
    manager_title_groups,
    recruiter_title_groups,
)
from app.people.waterfall import (
    ACTIONABLE_SKIPS,
    CoverageTarget,
    ProviderAvailability,
    ProviderStep,
    ProviderStepResult,
    SkipReason,
    WaterfallResult,
    categories_below_target,
    configured_provider_order,
    run_waterfall,
)

logger = logging.getLogger("jobpilot.people")

DiscoveryStrategy = Literal["exact", "broadened"]
DISCOVERY_STRATEGY_VERSION = "people-discovery-v3"

# One identifier for "results produced under these semantics are comparable".
#
# Two Toshiba jobs displayed contradictory states because a run recorded before
# PDL's 404 was understood as "no profiles matched" kept being treated as
# current: the fingerprint did not change when the *meaning* of a stored result
# did. Composing the version from every input that can reinterpret a stored
# result makes that impossible — changing any component below retires every run
# recorded under the old one.
#
# Components: provider response contract, query strategy, company resolution,
# ranking/scoring, and the stored result schema.
PEOPLE_RESULT_SCHEMA_VERSION = "people-result-v2"
# Bump when the deterministic outreach templates change, so a client caching a
# draft knows to regenerate.
OUTREACH_TEMPLATE_VERSION = "people-outreach-template-v2"
PEOPLE_SEARCH_CONTRACT_VERSION = ":".join(
    (
        # PDL 404 now means "no profiles matched" rather than a rejected
        # request; every run recorded before that reads its own failure_code
        # with the opposite meaning.
        "pdl-person-search-v3",
        PDL_DISCOVERY_STRATEGY_VERSION,
        PDL_QUERY_LADDER_VERSION,
        PDL_COMPANY_RESOLUTION_VERSION,
        SCORING_VERSION,
        PEOPLE_RESULT_SCHEMA_VERSION,
        PEOPLE_FINALIZATION_VERSION,
        # Whether a stored "nobody matched" is still true depends on which
        # records this product is willing to show, and on how far Apollo is
        # allowed to go to complete one.
        PEOPLE_DISPLAY_POLICY_VERSION,
        # Whether a stored contact is still showable depends on the acceptance
        # gate that produced it. A run finalized when masked, linkless records
        # counted as contacts is not comparable to one finalized under this
        # policy, and must not be replayed as though it were.
        ACTIONABLE_CONTACT_POLICY_VERSION,
        BRIGHTDATA_PROFILE_STRATEGY_VERSION,
        OPENAI_IDENTITY_VERSION,
        APOLLO_ENRICHMENT_STRATEGY_VERSION,
        # The chain itself is part of the contract: a result produced when only
        # PDL could answer is not comparable to one produced with Apollo behind
        # it, and must not be replayed as though it were.
        f"order:{'>'.join(configured_provider_order())}",
    )
)
# Key under which each run records the contract it was produced under. Runs
# without it predate versioning and are legacy by definition.
CONTRACT_VERSION_KEY = "search_contract_version"


def run_contract_version(run: PeopleDiscoveryRun | None) -> str | None:
    """The contract a stored run was produced under, or ``None`` when legacy."""

    if run is None:
        return None
    value = (run.company_context or {}).get(CONTRACT_VERSION_KEY)
    return value if isinstance(value, str) and value else None


def run_is_compatible(run: PeopleDiscoveryRun | None) -> bool:
    """May this stored run be reused as a current result?

    A legacy run — one with no recorded contract, or one recorded under a
    different contract — must not be served: its status and failure_code were
    written under semantics that no longer hold.
    """

    return run_contract_version(run) == PEOPLE_SEARCH_CONTRACT_VERSION


DISPLAYABLE_EMPLOYMENT_STATUSES = frozenset(
    {
        "confirmed_exact_company_verified",
        "exact_company_current_but_unverified_freshness",
    }
)

# Every message here is user-facing. Each one must name the *actual* problem:
# the generic "paused after repeated provider failures" line is reserved for a
# genuinely open provider circuit and must never appear for an empty result, an
# unresolved domain, a per-user budget, or a request-specific rejection.
# Four user-facing outcomes and no fifth. Naming which vendor failed, or
# explaining an integration defect as a spent budget, tells a user something
# they cannot act on and — in the live case — something untrue. Capacity copy is
# reserved for the codes that mean a budget really did stop the search.
_TEMPORARILY_UNAVAILABLE = (
    "People search is temporarily unavailable. Please try again later."
)
_CAPACITY_REACHED = (
    "People search is temporarily unavailable because provider capacity has "
    "been reached."
)
_SAFE_PROVIDER_MESSAGES = {
    "provider_unauthorized": _TEMPORARILY_UNAVAILABLE,
    "provider_forbidden": _TEMPORARILY_UNAVAILABLE,
    "provider_not_configured": _TEMPORARILY_UNAVAILABLE,
    "provider_configuration_circuit_open": _TEMPORARILY_UNAVAILABLE,
    "provider_master_key_required_or_forbidden": _TEMPORARILY_UNAVAILABLE,
    "provider_rate_limited": (
        "People search is temporarily unavailable. Try again after the "
        "displayed retry time."
    ),
    "provider_timeout": _TEMPORARILY_UNAVAILABLE,
    "provider_network_error": _TEMPORARILY_UNAVAILABLE,
    "provider_unavailable": _TEMPORARILY_UNAVAILABLE,
    "provider_circuit_open": _TEMPORARILY_UNAVAILABLE,
    "provider_budget_exceeded": _CAPACITY_REACHED,
    "provider_user_limit_exceeded": "You have reached today's people-search limit.",
    "company_domain_unresolved": (
        "We could not confidently identify this company yet."
    ),
    "provider_route_invalid": _TEMPORARILY_UNAVAILABLE,
    "no_results": "No strong contacts were found for this company yet.",
    "provider_schema_error": _TEMPORARILY_UNAVAILABLE,
    "provider_request_invalid": _TEMPORARILY_UNAVAILABLE,
    "provider_response_invalid": _TEMPORARILY_UNAVAILABLE,
    "provider_request_cancelled": "The people search was cancelled before it completed.",
}


def _safe_provider_message(reason: str) -> str:
    return _SAFE_PROVIDER_MESSAGES.get(reason, _TEMPORARILY_UNAVAILABLE)


# Failures that mean the user's unit bought nothing. Configuration and
# authentication problems are JobPilot's to fix; an unresolved company is our
# own missing data; a cancelled request never ran. A provider that answered
# — including a truthful no-match — is a completed search and stays charged.
_REFUNDABLE_CODES: frozenset[PeopleErrorCode] = frozenset(
    {
        PeopleErrorCode.COMPANY_DOMAIN_UNRESOLVED,
        PeopleErrorCode.AUTHENTICATION_FAILED,
        PeopleErrorCode.AUTHORIZATION_FAILED,
        PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED,
        PeopleErrorCode.REQUEST_CANCELLED,
        PeopleErrorCode.INVALID_INPUT,
    }
)


def _provider_work_started(provider: object) -> bool:
    """Did any external search actually leave the building?

    Company resolution alone does not count: it is JobPilot deciding whether it
    can search at all, not the search the user asked for.
    """

    return bool(
        [
            call
            for call in getattr(provider, "strategy_calls", [])
            if isinstance(call, dict)
        ]
    )


def _refundable_failure(code: PeopleErrorCode, provider: object) -> bool:
    if code in _REFUNDABLE_CODES:
        return True
    # An open circuit that blocked the request before any search ran means no
    # provider work happened, so the unit is returned.
    return not _provider_work_started(provider)


_ACTIONABLE_REJECTION_METRICS = {
    "masked_name": "people_masked_name_rejected_total",
    "incomplete_name": "people_masked_name_rejected_total",
    "missing_name": "people_masked_name_rejected_total",
    "missing_linkedin_url": "people_missing_linkedin_rejected_total",
    "invalid_linkedin_url": "people_missing_linkedin_rejected_total",
    "ambiguous_identity": "people_ambiguous_identity_rejected_total",
}


def _record_actionable_rejection(reasons: list[str], *, provider: str) -> None:
    """Count why a contact was withheld. Reasons only — never who was withheld."""

    metric("people_contacts_rejected_total", provider=provider)
    for reason in reasons:
        name = _ACTIONABLE_REJECTION_METRICS.get(reason)
        if name:
            metric(name, provider=provider, reason=reason)


def _log_provider_failure(exc: ProviderUnavailable, discovery_run_id: int) -> None:
    logger.warning(
        "people_provider_failure reason=%s error_code=%s provider=%s "
        "request_scoped=%s http_status=%s retry_after=%s duration_ms=%s "
        "discovery_run_id=%s",
        exc.reason,
        exc.code,
        exc.provider,
        exc.request_scoped,
        exc.http_status if exc.http_status is not None else "none",
        exc.retry_after_seconds if exc.retry_after_seconds is not None else "none",
        round(exc.duration_ms, 2) if exc.duration_ms is not None else "none",
        discovery_run_id,
    )
    metric(
        "people_provider_requests_total",
        provider=exc.provider,
        status="error",
        error_code=str(exc.code),
    )
_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)
_RATE_LOCK = Lock()


def rate_limit(key: str, limit: int, window_seconds: int = 3600) -> None:
    if limit <= 0:
        return
    now = datetime.now(UTC).timestamp()
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS[key]
        while bucket and bucket[0] <= now - window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={"code": "PEOPLE_RATE_LIMITED", "message": "Please try again later."},
            )
        bucket.append(now)


def query_fingerprint(
    job: JobPosting, strategy: DiscoveryStrategy = "exact"
) -> str:
    profile = extract_job_people_profile(job)
    payload = profile.model_dump(mode="json")
    payload["scoring_version"] = SCORING_VERSION
    payload["discovery_strategy_version"] = DISCOVERY_STRATEGY_VERSION
    payload["discovery_strategy"] = strategy
    payload["employment_validation_version"] = EMPLOYMENT_VALIDATION_VERSION
    payload["employment_evidence_version"] = EMPLOYMENT_EVIDENCE_VERSION
    payload["search_contract_version"] = PEOPLE_SEARCH_CONTRACT_VERSION
    if settings.people_primary_provider == "apollo":
        payload["provider_adapter_version"] = APOLLO_ENRICHMENT_ADAPTER_VERSION
    elif settings.people_primary_provider == "pdl":
        payload["provider_adapter_version"] = PDL_DISCOVERY_STRATEGY_VERSION
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _job_or_404(db: Session, job_id: int) -> JobPosting:
    job = db.get(JobPosting, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _fresh_candidates(
    db: Session,
    job_id: int,
    user_id: int,
) -> list[JobPeopleCandidate]:
    return list(
        db.scalars(
            select(JobPeopleCandidate)
            .join(
                UserJobPeopleRecommendation,
                UserJobPeopleRecommendation.job_people_candidate_id
                == JobPeopleCandidate.id,
            )
            .where(
                JobPeopleCandidate.job_id == job_id,
                UserJobPeopleRecommendation.user_id == user_id,
                UserJobPeopleRecommendation.job_id == job_id,
                UserJobPeopleRecommendation.suppressed_at.is_(None),
                JobPeopleCandidate.expires_at > _now(),
                JobPeopleCandidate.scoring_version == SCORING_VERSION,
                JobPeopleCandidate.employment_validation_version
                == EMPLOYMENT_VALIDATION_VERSION,
                JobPeopleCandidate.employment_validation_status.in_(
                    DISPLAYABLE_EMPLOYMENT_STATUSES
                ),
            )
        )
    )


def _fresh_no_match_run(
    db: Session,
    *,
    job_id: int,
    user_id: int,
    fingerprint: str,
) -> PeopleDiscoveryRun | None:
    cutoff = _now() - timedelta(days=_people_result_ttl_days())
    runs = db.scalars(
        select(PeopleDiscoveryRun)
        .where(
            PeopleDiscoveryRun.job_id == job_id,
            PeopleDiscoveryRun.user_id == user_id,
            PeopleDiscoveryRun.query_fingerprint == fingerprint,
            PeopleDiscoveryRun.status == "complete",
            PeopleDiscoveryRun.completed_at.is_not(None),
            PeopleDiscoveryRun.completed_at > cutoff,
        )
        .order_by(PeopleDiscoveryRun.completed_at.desc())
    )
    for run in runs:
        if not run_is_compatible(run):
            # Recorded under semantics that no longer hold: its "no match" may
            # have meant something else entirely.
            continue
        if (
            settings.people_employment_secondary_verification_enabled
            and not bool(
                (run.company_context or {}).get(
                    "secondary_employment_verification_enabled"
                )
            )
        ):
            # Enabling secondary verification re-evaluates unresolved/no-match
            # runs, while successful current candidates remain reusable.
            continue
        return run
    return None


def _latest_run(
    db: Session,
    *,
    job_id: int,
    user_id: int,
    fingerprints: list[str] | None = None,
) -> PeopleDiscoveryRun | None:
    statement = select(PeopleDiscoveryRun).where(
        PeopleDiscoveryRun.job_id == job_id,
        PeopleDiscoveryRun.user_id == user_id,
    )
    if fingerprints is not None:
        statement = statement.where(
            PeopleDiscoveryRun.query_fingerprint.in_(fingerprints)
        )
    return db.scalar(
        statement.order_by(
            PeopleDiscoveryRun.started_at.desc(),
            PeopleDiscoveryRun.id.desc(),
        )
    )


_RETRYABLE_PROVIDER_ERRORS = frozenset(
    {
        "provider_circuit_open",
        "provider_rate_limited",
        "provider_timeout",
        "provider_network_error",
        "provider_unavailable",
        "discovery_failed",
        "recommendation_commit_failed",
        # An unresolved domain is worth retrying once the company record is
        # enriched, and retrying costs no provider credit.
        "company_domain_unresolved",
    }
)
_NON_RETRYABLE_PROVIDER_ERRORS = frozenset(
    {
        "provider_not_configured",
        "provider_unauthorized",
        "provider_forbidden",
        "provider_configuration_circuit_open",
        "provider_master_key_required_or_forbidden",
        "provider_request_invalid",
        "provider_response_invalid",
        "provider_budget_exceeded",
        "provider_user_limit_exceeded",
        "provider_request_cancelled",
    }
)


def _current_provider_error_run(
    db: Session,
    *,
    job_id: int,
    user_id: int,
    fingerprint: str,
) -> PeopleDiscoveryRun | None:
    latest = _latest_run(
        db,
        job_id=job_id,
        user_id=user_id,
        fingerprints=[fingerprint],
    )
    if latest is None or not run_is_compatible(latest):
        # A legacy failure must never pin a job to a status produced under
        # different provider semantics — that is what left one Toshiba job
        # permanently showing "the provider request was invalid".
        return None
    return latest if latest.status in PROVIDER_ERROR_STATUSES else None


def _provider_error_retry_state(
    run: PeopleDiscoveryRun,
    *,
    now: datetime | None = None,
) -> tuple[bool, int | None, datetime | None]:
    reason = run.failure_code or "provider_unavailable"
    if reason == "provider_schema_error" or reason in _NON_RETRYABLE_PROVIDER_ERRORS:
        return False, None, None
    if reason not in _RETRYABLE_PROVIDER_ERRORS:
        return False, None, None
    value = (run.company_context or {}).get("retry_eligible_at")
    try:
        retry_at = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        retry_at = None
    if retry_at is None:
        completed = run.completed_at or run.started_at
        if completed.tzinfo is None:
            completed = completed.replace(tzinfo=UTC)
        retry_at = completed + timedelta(seconds=_provider_retry_seconds(reason))
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=UTC)
    current = now or _now()
    remaining = max(0, int((retry_at - current).total_seconds() + 0.999))
    return remaining == 0, remaining or None, retry_at


def _provider_error_blocks_discovery(
    run: PeopleDiscoveryRun, *, fallback_available: bool = False
) -> bool:
    """Whether a stored failure should short-circuit a new discovery.

    A budget stop recorded against one provider says nothing about the others.
    Replaying it while a funded fallback is standing by is exactly what kept a
    job pinned to "the provider budget has been reached" after Apollo had been
    added to the chain: the cached PDL failure was returned before the waterfall
    ever ran.
    """

    if fallback_available and code_for_reason(run.failure_code or "") is (
        PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED
    ):
        return False
    retry_eligible, _, _ = _provider_error_retry_state(run)
    return not retry_eligible


def _provider_error_context(reason: str, *, now: datetime) -> dict[str, object]:
    if reason in _RETRYABLE_PROVIDER_ERRORS:
        retry_at = now + timedelta(seconds=_provider_retry_seconds(reason))
        return {
            "provider_error_retry_policy": "bounded_explicit_retry",
            "retry_eligible_at": retry_at.isoformat(),
        }
    if reason in {
        "provider_schema_error",
        "provider_request_invalid",
        "provider_response_invalid",
    }:
        return {
            "provider_error_retry_policy": "adapter_version_change_required",
            "retry_eligible_at": None,
        }
    return {
        "provider_error_retry_policy": "non_retryable",
        "retry_eligible_at": None,
    }


def _configure_provider_usage(
    provider: object,
    *,
    db: Session,
    user_id: int,
    job_id: int,
    discovery_run_id: int,
    adapter_version: str,
) -> None:
    configure = getattr(provider, "configure_usage", None)
    if not callable(configure):
        return
    configure(
        ProviderUsageContext(
            user_id=user_id,
            job_id=job_id,
            discovery_run_id=discovery_run_id,
            adapter_version=adapter_version,
        ),
        session_factory=sessionmaker(
            bind=db.get_bind(),
            autoflush=False,
            expire_on_commit=False,
        ),
    )


def _durable_usage_summary(
    db: Session,
    discovery_run_id: int,
) -> dict[str, object]:
    rows = db.execute(
        select(
            PeopleProviderOperationUsage.request_count,
            PeopleProviderOperationUsage.credits_reported,
            PeopleProviderOperationUsage.credits_estimated,
            PeopleProviderOperationUsage.budget_units,
            PeopleProviderOperationUsage.credit_status,
        ).where(
            PeopleProviderOperationUsage.discovery_run_id
            == discovery_run_id
        )
    ).all()
    operation_counts: dict[str, int] = defaultdict(int)
    operation_rows = db.execute(
        select(
            PeopleProviderOperationUsage.operation_type,
            PeopleProviderOperationUsage.request_count,
        ).where(
            PeopleProviderOperationUsage.discovery_run_id
            == discovery_run_id
        )
    ).all()
    for operation_type, request_count in operation_rows:
        operation_counts[str(operation_type)] += int(request_count)
    return {
        "request_count": sum(int(row.request_count) for row in rows),
        "reported_credits": sum(
            int(row.credits_reported or 0) for row in rows
        ),
        "estimated_credits": sum(
            int(row.credits_estimated or 0) for row in rows
        ),
        "unknown_credit_operations": sum(
            int(row.request_count)
            for row in rows
            if row.credit_status == "unknown"
        ),
        "budget_units": sum(int(row.budget_units) for row in rows),
        "operation_counts": dict(sorted(operation_counts.items())),
    }


def _provider_pipeline_outcomes(
    provider: object,
    usage_summary: dict[str, object],
) -> dict[str, str]:
    operation_counts = usage_summary.get("operation_counts", {})
    if not isinstance(operation_counts, dict):
        operation_counts = {}
    metrics = getattr(provider, "enrichment_safe_metrics", {})
    bulk_calls = int(operation_counts.get("bulk_enrichment", 0))
    single_calls = int(operation_counts.get("complete_person_by_id", 0))
    if metrics.get("bulk_payload_validation_failed"):
        bulk_outcome = "request_rejected_fallback_continued"
    elif metrics.get("bulk_capability_skipped"):
        bulk_outcome = "skipped_by_capability_cache"
    elif bulk_calls:
        bulk_outcome = "completed"
    else:
        bulk_outcome = "not_used"
    return {
        "bulk_enrichment": bulk_outcome,
        "bounded_single_fallback": (
            "completed" if single_calls else "not_used"
        ),
    }


def _normalized_linkedin(value: str | None) -> str | None:
    return safe_profile_url(value)


def _display_name(value: str) -> str:
    stripped = value.strip()
    if re.fullmatch(r"[a-z]+(?: [a-z]+)+", stripped):
        return " ".join(part.capitalize() for part in stripped.split())
    return stripped


def _same_identity(left: ProviderPerson, right: ProviderPerson) -> bool:
    left_url, right_url = _normalized_linkedin(left.linkedin_url), _normalized_linkedin(right.linkedin_url)
    if left_url and right_url:
        return left_url == right_url
    if left.provider == right.provider and left.provider_person_id == right.provider_person_id:
        return True
    # Names, employers, and titles are not stable identity keys. Without a
    # provider identifier or an allowlisted professional profile URL, keep the
    # records separate.
    return False


def deduplicate(people: list[ProviderPerson]) -> list[ProviderPerson]:
    result: list[ProviderPerson] = []
    for person in people:
        if not any(_same_identity(person, existing) for existing in result):
            result.append(person)
    return result


def _shared_evidence(
    db: Session, user_id: int, person: ProviderPerson
) -> tuple[str | None, str | None]:
    if not settings.people_network_matching_enabled:
        return None, None
    user_schools = {
        normalize_text(row.school): row.school
        for row in db.scalars(select(Education).where(Education.user_id == user_id))
    }
    user_employers = {
        normalize_text(row.company): row.company
        for row in db.scalars(select(Experience).where(Experience.user_id == user_id))
    }
    school = next((user_schools[n] for item in person.education if (n := normalize_text(item)) in user_schools), None)
    employer = next(
        (user_employers[n] for item in person.previous_employers if (n := normalize_text(item)) in user_employers),
        None,
    )
    return school, employer


def _person_for_provider(db: Session, value: ProviderPerson) -> ProfessionalPerson:
    linkedin = _normalized_linkedin(value.linkedin_url)
    person = db.scalar(
        select(ProfessionalPersonSource)
        .where(
            ProfessionalPersonSource.provider == value.provider,
            ProfessionalPersonSource.provider_person_id == value.provider_person_id,
        )
    )
    canonical = db.get(ProfessionalPerson, person.person_id) if person else None
    if canonical is None and linkedin:
        canonical = db.scalar(
            select(ProfessionalPerson).where(ProfessionalPerson.linkedin_url_normalized == linkedin)
        )
    if canonical is None:
        canonical = ProfessionalPerson(
            canonical_full_name=value.full_name[:255],
            normalized_full_name=normalize_text(value.full_name)[:255],
            current_company_name=value.current_company_name[:255],
            current_company_domain=value.current_company_domain,
            current_title=value.current_title[:255],
            normalized_title=normalize_text(value.current_title)[:255],
            department=(value.department or "")[:120] or None,
            seniority=(value.seniority or "")[:80] or None,
            professional_location=(value.location or "")[:255] or None,
            linkedin_url=linkedin,
            linkedin_url_normalized=linkedin,
            employment_last_verified_at=value.employment_verified_at,
        )
        db.add(canonical)
        db.flush()
    else:
        # Prefer fresher provider evidence; never overwrite with missing values.
        incoming = (
            value.employment_verified_at
            or value.provider_employment_updated_at
            or value.provider_record_observed_at
            or value.source_last_updated_at
        )
        current = canonical.updated_at
        if incoming and (
            not current or incoming.replace(tzinfo=UTC) >= current.replace(tzinfo=UTC)
        ):
            prior_company_domain = canonical.current_company_domain
            canonical.current_company_name = value.current_company_name[:255]
            canonical.current_company_domain = value.current_company_domain or canonical.current_company_domain
            canonical.current_title = value.current_title[:255]
            canonical.normalized_title = normalize_text(value.current_title)[:255]
            canonical.department = value.department or canonical.department
            canonical.seniority = value.seniority or canonical.seniority
            canonical.professional_location = value.location or canonical.professional_location
            if value.employment_verified_at:
                canonical.employment_last_verified_at = (
                    value.employment_verified_at
                )
            elif (
                prior_company_domain
                and value.current_company_domain
                and prior_company_domain != value.current_company_domain
            ):
                canonical.employment_last_verified_at = None
    source = db.scalar(
        select(ProfessionalPersonSource).where(
            ProfessionalPersonSource.provider == value.provider,
            ProfessionalPersonSource.provider_person_id == value.provider_person_id,
        )
    )
    if source is None:
        source = ProfessionalPersonSource(
            person_id=canonical.id,
            provider=value.provider,
            provider_person_id=value.provider_person_id[:255],
            source_profile_url=safe_profile_url(value.source_profile_url),
            source_last_updated_at=value.source_last_updated_at,
            provider_record_observed_at=value.provider_record_observed_at,
            provider_employment_updated_at=value.provider_employment_updated_at,
            employment_verified_at=value.employment_verified_at,
            employment_source=value.employment_source,
            exact_company_match=value.exact_company_match,
            current_role_indicator=value.current_role_indicator,
            conflicting_employer_observed_at=(
                value.conflicting_employer_observed_at
            ),
            normalized_evidence=value.evidence,
            field_provenance=value.field_provenance,
            redacted_payload={},
        )
        db.add(source)
    else:
        prior = source.normalized_evidence if isinstance(source.normalized_evidence, dict) else {}
        observations = list(prior.get("employment_observations") or [])[-9:]
        previous_snapshot = {
            "company_name": prior.get("current_company_name"),
            "company_domain": prior.get("current_company_domain"),
            "title": prior.get("current_title"),
            "verified_at": prior.get("employment_verified_at"),
            "provider_record_observed_at": prior.get(
                "provider_record_observed_at"
            ),
            "provider_employment_updated_at": prior.get(
                "provider_employment_updated_at"
            ),
        }
        incoming_snapshot = {
            "company_name": value.evidence.get("current_company_name"),
            "company_domain": value.evidence.get("current_company_domain"),
            "title": value.evidence.get("current_title"),
            "verified_at": value.evidence.get("employment_verified_at"),
            "provider_record_observed_at": value.evidence.get(
                "provider_record_observed_at"
            ),
            "provider_employment_updated_at": value.evidence.get(
                "provider_employment_updated_at"
            ),
        }
        if any(previous_snapshot.values()) and previous_snapshot != incoming_snapshot:
            observations.append(previous_snapshot)
        source.normalized_evidence = {
            **value.evidence,
            "employment_observations": observations,
        }
        source.field_provenance = value.field_provenance
        source.source_last_updated_at = value.source_last_updated_at
        source.provider_record_observed_at = value.provider_record_observed_at
        source.provider_employment_updated_at = (
            value.provider_employment_updated_at
        )
        source.employment_verified_at = value.employment_verified_at
        source.employment_source = value.employment_source
        source.exact_company_match = value.exact_company_match
        source.current_role_indicator = value.current_role_indicator
        source.conflicting_employer_observed_at = (
            value.conflicting_employer_observed_at
        )
    return canonical


def _employment_observations(
    db: Session, value: ProviderPerson
) -> tuple[list[dict], bool, datetime | None]:
    source = db.scalar(
        select(ProfessionalPersonSource).where(
            ProfessionalPersonSource.provider == value.provider,
            ProfessionalPersonSource.provider_person_id == value.provider_person_id,
        )
    )
    canonical = db.get(ProfessionalPerson, source.person_id) if source else None
    linkedin = _normalized_linkedin(value.linkedin_url)
    if canonical is None and linkedin:
        canonical = db.scalar(
            select(ProfessionalPerson).where(
                ProfessionalPerson.linkedin_url_normalized == linkedin
            )
        )
    if canonical is None:
        return [], False, None
    observations: list[dict] = []
    for existing_source in db.scalars(
        select(ProfessionalPersonSource).where(
            ProfessionalPersonSource.person_id == canonical.id
        )
    ):
        evidence = (
            existing_source.normalized_evidence
            if isinstance(existing_source.normalized_evidence, dict)
            else {}
        )
        snapshot = {
            "company_name": evidence.get("current_company_name"),
            "company_domain": evidence.get("current_company_domain"),
            "title": evidence.get("current_title"),
            "employment_verified_at": (
                existing_source.employment_verified_at.isoformat()
                if existing_source.employment_verified_at
                else evidence.get("employment_verified_at")
            ),
            "provider_record_observed_at": (
                existing_source.provider_record_observed_at.isoformat()
                if existing_source.provider_record_observed_at
                else evidence.get("provider_record_observed_at")
            ),
            "provider_employment_updated_at": (
                existing_source.provider_employment_updated_at.isoformat()
                if existing_source.provider_employment_updated_at
                else evidence.get("provider_employment_updated_at")
            ),
            "provider": existing_source.provider,
        }
        if any(snapshot.values()):
            observations.append(snapshot)
        observations.extend(
            item
            for item in (evidence.get("employment_observations") or [])
            if isinstance(item, dict)
        )
    return (
        observations,
        canonical.employment_revalidation_required,
        canonical.employment_conflict_detected_at,
    )


def _validate_employment(
    db: Session, person: ProviderPerson, profile
) -> EmploymentValidationResult:
    observations, revalidation_required, revalidation_required_since = (
        _employment_observations(db, person)
    )
    return validate_current_employment(
        person,
        profile,
        prior_observations=observations,
        revalidation_required=revalidation_required,
        revalidation_required_since=revalidation_required_since,
    )


async def _secondary_employment_validation(
    db: Session,
    user_id: int,
    job_id: int,
    discovery_run_id: int,
    person: ProviderPerson,
    profile,
    category: PeopleCategory,
) -> tuple[EmploymentValidationResult, ProviderPerson | None] | None:
    cache_key = hashlib.sha256(
        (
            f"{person.provider}:{person.provider_person_id}:"
            f"{profile.company_domain}:{EMPLOYMENT_EVIDENCE_VERSION}"
        ).encode()
    ).hexdigest()
    cached = db.scalar(
        select(PeopleEmploymentVerificationRun)
        .where(
            PeopleEmploymentVerificationRun.cache_key_hash == cache_key,
            PeopleEmploymentVerificationRun.verification_version
            == EMPLOYMENT_EVIDENCE_VERSION,
            PeopleEmploymentVerificationRun.expires_at > _now(),
        )
        .order_by(PeopleEmploymentVerificationRun.completed_at.desc())
    )
    if cached is not None:
        return _cached_verification_result(cached), None

    budget_reason = _employment_verification_budget_reason(db, user_id)
    if budget_reason is not None:
        return None
    with _redis_lock(job_id, cache_key, namespace="employment-verify") as acquired:
        if not acquired:
            return None
        provider = PDLPeopleProvider()
        _configure_provider_usage(
            provider,
            db=db,
            user_id=user_id,
            job_id=job_id,
            discovery_run_id=discovery_run_id,
            adapter_version=EMPLOYMENT_EVIDENCE_VERSION,
        )
        result_status = "insufficient_evidence"
        credits = 0
        match: ProviderPerson | None = None
        try:
            rows = await provider.search_people(
                PeopleSearchQuery(
                    category=category,
                    company_name=profile.company_name,
                    company_domain=profile.company_domain,
                    company_aliases=profile.company_aliases,
                    titles=[person.current_title],
                    title_group="employment_verification",
                    seniorities=[],
                    role_family=profile.role_family,
                    department=profile.department,
                    location=profile.location,
                    location_filter_mode="none",
                    company_match_kind="canonical",
                    limit=5,
                )
            )
            match = next(
                (
                    row
                    for row in rows
                    if (
                        safe_profile_url(row.linkedin_url)
                        and safe_profile_url(row.linkedin_url)
                        == safe_profile_url(person.linkedin_url)
                    )
                    or (
                        normalize_text(row.full_name)
                        == normalize_text(person.full_name)
                        and normalize_text(row.current_title)
                        == normalize_text(person.current_title)
                    )
                ),
                None,
            )
            usage = await provider.get_usage()
            credits = usage.credits_used
            if match is None:
                result = EmploymentValidationResult(
                    status="insufficient_evidence",
                    confidence=0.3,
                    identity_strong=True,
                    rejection_codes=["insufficient_employment_evidence"],
                )
            elif match.current_company_domain != profile.company_domain:
                match.conflicting_employer_observed_at = (
                    match.provider_record_observed_at or _now()
                )
                result = EmploymentValidationResult(
                    status="conflicting_current_employment",
                    confidence=0.1,
                    verified_at=match.conflicting_employer_observed_at,
                    conflicting_employer=True,
                    identity_strong=True,
                    rejection_codes=["current_employment_conflict"],
                )
            else:
                match.exact_company_match = True
                base = validate_current_employment(match, profile)
                if base.status in DISPLAYABLE_EMPLOYMENT_STATUSES:
                    result = base.model_copy(
                        update={
                            "status": "confirmed_exact_company_verified",
                            "confidence": 0.98,
                            "verified_at": _now(),
                            "rejection_codes": [],
                        }
                    )
                else:
                    result = base
            result_status = result.status
        except ProviderUnavailable as exc:
            result = EmploymentValidationResult(
                status="stale_or_uncertain",
                confidence=0.3,
                identity_strong=True,
                rejection_codes=["insufficient_employment_evidence"],
            )
            result_status = exc.reason
            _log_provider_failure(exc, discovery_run_id)
        expires = _now() + timedelta(
            seconds=(
                _provider_retry_seconds(result_status)
                if result_status.startswith("provider_")
                else settings.people_employment_verification_ttl_days * 86400
            )
        )
        db.add(
            PeopleEmploymentVerificationRun(
                job_id=job_id,
                user_id=user_id,
                discovery_run_id=discovery_run_id,
                category=category,
                cache_key_hash=cache_key,
                verification_version=EMPLOYMENT_EVIDENCE_VERSION,
                status=result_status,
                credits_used=credits,
                completed_at=_now(),
                expires_at=expires,
            )
        )
        return (
            result.model_copy(
                update={
                    "verification_provider": "secondary_licensed_provider",
                    "credits_consumed": credits,
                }
            ),
            match,
        )


def _cached_verification_result(
    cached: PeopleEmploymentVerificationRun,
) -> EmploymentValidationResult:
    if cached.status == "confirmed_exact_company_verified":
        return EmploymentValidationResult(
            status="confirmed_exact_company_verified",
            confidence=0.98,
            verified_at=cached.completed_at,
            exact_company=True,
            identity_strong=True,
        )
    if cached.status == "conflicting_current_employment":
        return EmploymentValidationResult(
            status="conflicting_current_employment",
            confidence=0.1,
            verified_at=cached.completed_at,
            conflicting_employer=True,
            identity_strong=True,
            rejection_codes=["current_employment_conflict"],
        )
    return EmploymentValidationResult(
        status="stale_or_uncertain",
        confidence=0.3,
        verified_at=cached.completed_at,
        identity_strong=True,
        rejection_codes=["insufficient_employment_evidence"],
    )


def _employment_verification_budget_reason(
    db: Session, user_id: int
) -> str | None:
    start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    global_used = db.scalar(
        select(
            func.coalesce(
                func.sum(PeopleEmploymentVerificationRun.credits_used), 0
            )
        ).where(PeopleEmploymentVerificationRun.started_at >= start)
    ) or 0
    user_used = db.scalar(
        select(
            func.coalesce(
                func.sum(PeopleEmploymentVerificationRun.credits_used), 0
            )
        ).where(
            PeopleEmploymentVerificationRun.user_id == user_id,
            PeopleEmploymentVerificationRun.started_at >= start,
        )
    ) or 0
    if (
        settings.people_employment_verification_daily_credit_budget > 0
        and global_used
        >= settings.people_employment_verification_daily_credit_budget
    ):
        return "provider_budget_exceeded"
    if (
        settings.people_employment_verification_per_user_daily_limit > 0
        and user_used
        >= settings.people_employment_verification_per_user_daily_limit
    ):
        return "provider_user_limit_exceeded"
    return None


def _provider_retry_seconds(reason: str) -> int:
    return {
        "provider_circuit_open": 60,
        "provider_rate_limited": 60,
        "provider_timeout": 30,
        "provider_network_error": 30,
    }.get(reason, 300)


def _ensure_recommendation(
    db: Session,
    user_id: int,
    candidate: JobPeopleCandidate,
    school: str | None,
    employer: str | None,
) -> UserJobPeopleRecommendation:
    recommendation = db.scalar(
        select(UserJobPeopleRecommendation).where(
            UserJobPeopleRecommendation.user_id == user_id,
            UserJobPeopleRecommendation.job_id == candidate.job_id,
            UserJobPeopleRecommendation.job_people_candidate_id == candidate.id,
        )
    )
    if recommendation is None:
        reasons = []
        if school:
            reasons.append(f"Shared school: {school}")
        if employer:
            reasons.append(f"Shared previous employer: {employer}")
        recommendation = UserJobPeopleRecommendation(
            user_id=user_id,
            job_id=candidate.job_id,
            job_people_candidate_id=candidate.id,
            relationship_type="relevant" if reasons else None,
            shared_school=school,
            shared_employer=employer,
            connection_strength=min(1.0, 0.55 * bool(school) + 0.45 * bool(employer)),
            personalized_reasons=reasons,
            personalized_score=candidate.category_score,
        )
        db.add(recommendation)
        db.flush()
    return recommendation


def _fallback_provider_available(db: Session, user_id: int) -> bool:
    """Whether any non-primary provider in the chain could still run.

    Deliberately conservative: it checks configuration, credentials and budget,
    the same gates the waterfall applies, so the pre-flight check and the
    waterfall can never disagree about whether a fallback exists.
    """

    primary = str(settings.people_primary_provider).strip().lower()
    for name in configured_provider_order():
        if name == primary:
            continue
        if name == "apollo":
            if not (
                settings.people_apollo_discovery_enabled
                and (settings.apollo_api_key or "").strip()
            ):
                continue
            if _provider_budget_state(
                db,
                provider="apollo",
                user_id=user_id,
                global_budget=settings.people_apollo_daily_credit_budget,
                per_user_budget=settings.people_apollo_per_user_daily_limit,
            ):
                continue
            return True
        if name == "openai_web":
            if not OpenAIWebPeopleProvider.configured():
                continue
            if _provider_budget_state(
                db,
                provider="openai_web",
                user_id=user_id,
                global_budget=settings.people_openai_web_daily_call_budget,
                per_user_budget=settings.people_openai_web_per_user_daily_limit,
            ):
                continue
            return True
    return False


def _log_unavailable_providers(steps: list[ProviderStep], discovery_run_id: int) -> None:
    """Say, once per discovery, why a configured provider cannot run.

    A provider that is enabled but unusable is an operator problem, and it must
    not be inferable only from the absence of a log line.
    """

    for step in steps:
        availability = getattr(step, "availability", None)
        if availability is None:
            continue
        state = availability()
        if state.available or state.reason is None:
            continue
        level = (
            logging.WARNING if state.reason in ACTIONABLE_SKIPS else logging.INFO
        )
        logger.log(
            level,
            "people_provider_unavailable provider=%s reason=%s discovery_run_id=%s%s",
            state.provider,
            state.reason.value,
            discovery_run_id,
            f" detail={state.detail}" if state.detail else "",
        )


def _budget_check(db: Session, user_id: int) -> None:
    start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    provider = settings.people_primary_provider.lower()
    global_budget = (
        settings.people_pdl_daily_credit_budget
        if provider == "pdl"
        else settings.people_daily_credit_budget
    )
    per_user_budget = (
        settings.people_pdl_per_user_daily_limit
        if provider == "pdl"
        else settings.people_per_user_daily_limit
    )
    has_durable_usage = (
        select(PeopleProviderOperationUsage.id)
        .where(
            PeopleProviderOperationUsage.discovery_run_id
            == PeopleDiscoveryRun.id
        )
        .exists()
    )
    legacy_global_used = db.scalar(
        select(func.coalesce(func.sum(PeopleDiscoveryRun.provider_credits_used), 0)).where(
            PeopleDiscoveryRun.started_at >= start,
            PeopleDiscoveryRun.provider == provider,
            ~has_durable_usage,
        )
    ) or 0
    legacy_user_used = db.scalar(
        select(func.coalesce(func.sum(PeopleDiscoveryRun.provider_credits_used), 0)).where(
            PeopleDiscoveryRun.user_id == user_id,
            PeopleDiscoveryRun.started_at >= start,
            PeopleDiscoveryRun.provider == provider,
            ~has_durable_usage,
        )
    ) or 0
    durable_global_used = db.scalar(
        select(
            func.coalesce(
                func.sum(PeopleProviderOperationUsage.budget_units),
                0,
            )
        ).where(
            PeopleProviderOperationUsage.occurred_at >= start,
            PeopleProviderOperationUsage.provider == provider,
        )
    ) or 0
    durable_user_used = db.scalar(
        select(
            func.coalesce(
                func.sum(PeopleProviderOperationUsage.budget_units),
                0,
            )
        ).where(
            PeopleProviderOperationUsage.user_id == user_id,
            PeopleProviderOperationUsage.occurred_at >= start,
            PeopleProviderOperationUsage.provider == provider,
        )
    ) or 0
    global_used = int(legacy_global_used) + int(durable_global_used)
    user_used = int(legacy_user_used) + int(durable_user_used)
    # Both limits below are measured in provider *credit units*, not user
    # actions, so neither may be presented as the user's search limit. The
    # user's allowance lives in app.people.quota and is counted in actions.
    # A spent primary budget is only a hard stop when no other provider in the
    # chain could answer. Previously this raised before any provider ran, so an
    # exhausted PDL allowance disabled People search even with a funded Apollo
    # account behind it.
    fallback_available = _fallback_provider_available(db, user_id)
    if global_budget and global_used >= global_budget and not fallback_available:
        metric(
            "people_budget_rejections_total",
            provider=provider,
            status="provider_account_budget",
        )
        raise HTTPException(
            status_code=429,
            detail={
                "code": "PEOPLE_PROVIDER_BUDGET_EXCEEDED",
                "message": _CAPACITY_REACHED,
                "availability_reason": "provider_budget_exceeded",
                "retryable": False,
            },
        )
    if per_user_budget and user_used >= per_user_budget and not fallback_available:
        metric(
            "people_budget_rejections_total",
            provider=provider,
            status="provider_per_user_budget",
        )
        raise HTTPException(
            status_code=429,
            detail={
                "code": "PEOPLE_PROVIDER_BUDGET_EXCEEDED",
                "message": _CAPACITY_REACHED,
                "availability_reason": "provider_budget_exceeded",
                "retryable": False,
            },
        )


def _pdl_budget_allows_call(
    db: Session,
    user_id: int,
    requested_maximum: int,
) -> bool:
    start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    global_used = int(
        db.scalar(
            select(
                func.coalesce(
                    func.sum(PeopleProviderOperationUsage.budget_units),
                    0,
                )
            ).where(
                PeopleProviderOperationUsage.provider == "pdl",
                PeopleProviderOperationUsage.occurred_at >= start,
            )
        )
        or 0
    )
    user_used = int(
        db.scalar(
            select(
                func.coalesce(
                    func.sum(PeopleProviderOperationUsage.budget_units),
                    0,
                )
            ).where(
                PeopleProviderOperationUsage.provider == "pdl",
                PeopleProviderOperationUsage.user_id == user_id,
                PeopleProviderOperationUsage.occurred_at >= start,
            )
        )
        or 0
    )
    return bool(
        settings.people_pdl_daily_credit_budget > 0
        and settings.people_pdl_per_user_daily_limit > 0
        and global_used + requested_maximum
        <= settings.people_pdl_daily_credit_budget
        and user_used + requested_maximum
        <= settings.people_pdl_per_user_daily_limit
    )


def _email_budget_exceeded(db: Session, user_id: int) -> bool:
    start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    global_used = db.scalar(
        select(func.coalesce(func.sum(PeopleDiscoveryRun.provider_credits_used), 0))
        .where(
            PeopleDiscoveryRun.provider == "hunter",
            PeopleDiscoveryRun.started_at >= start,
        )
    ) or 0
    user_used = db.scalar(
        select(func.coalesce(func.sum(PeopleDiscoveryRun.provider_credits_used), 0))
        .where(
            PeopleDiscoveryRun.provider == "hunter",
            PeopleDiscoveryRun.user_id == user_id,
            PeopleDiscoveryRun.started_at >= start,
        )
    ) or 0
    return bool(
        (
            settings.people_email_daily_credit_budget > 0
            and settings.people_email_daily_credit_budget <= global_used
        )
        or (
            settings.people_email_per_user_daily_limit > 0
            and settings.people_email_per_user_daily_limit <= user_used
        )
    )


_PEOPLE_CATEGORIES: tuple[PeopleCategory, ...] = (
    "likely_recruiter",
    "potential_hiring_manager",
    "potential_referrer",
)


def _primary_provider_fingerprint() -> str:
    """Account fingerprint for whichever provider is configured as primary."""

    key = (
        settings.pdl_api_key
        if settings.people_primary_provider.lower() == "pdl"
        else settings.apollo_api_key
    )
    return provider_account_fingerprint(key)


def people_circuit_snapshot(operation: str = "people_search") -> CircuitSnapshot:
    """Current circuit health for the configured primary people provider."""

    return circuit_state(
        provider=settings.people_primary_provider.lower(),
        account_fingerprint=_primary_provider_fingerprint(),
        operation=operation,
    )


def _people_result_ttl_days() -> int:
    if settings.people_primary_provider.lower() == "pdl":
        return settings.people_pdl_result_ttl_days
    return settings.people_result_ttl_days


def _strongest_category_candidates(
    candidates: dict[PeopleCategory, list[PreliminaryCandidate]],
) -> dict[PeopleCategory, list[PreliminaryCandidate]]:
    """Assign each provider identity to its strongest-scoring category.

    Category scoring still evaluates every plausible role. The UI-facing
    candidate set is exclusive, preventing one paid PDL record from appearing
    as a recruiter, manager, and referrer simultaneously.
    """
    category_order = {
        category: index
        for index, category in enumerate(_PEOPLE_CATEGORIES)
    }
    winners: dict[tuple[str, str], PreliminaryCandidate] = {}
    for category in _PEOPLE_CATEGORIES:
        for item in candidates.get(category, []):
            key = (item[2].provider, item[2].provider_person_id)
            incumbent = winners.get(key)
            affinity = _title_category_affinity(item[2].current_title)
            item_affinity = item[1] == affinity
            incumbent_affinity = bool(
                incumbent and incumbent[1] == affinity
            )
            if incumbent is None or (
                item_affinity,
                item[0],
                -category_order[item[1]],
            ) > (
                incumbent_affinity,
                incumbent[0],
                -category_order[incumbent[1]],
            ):
                winners[key] = item
    selected = {
        category: [] for category in _PEOPLE_CATEGORIES
    }
    for item in winners.values():
        selected[item[1]].append(item)
    return selected


def _title_category_affinity(title: str) -> PeopleCategory:
    normalized = normalize_text(title)
    if any(
        marker in normalized
        for marker in (
            "recruiter",
            "recruiting",
            "talent acquisition",
            "talent partner",
        )
    ):
        return "likely_recruiter"
    leadership_markers = {
        "manager",
        "director",
        "head",
        "vp",
        "president",
        "chief",
        "executive",
    }
    if leadership_markers & set(normalized.split()):
        return "potential_hiring_manager"
    return "potential_referrer"


def _category_threshold(category: PeopleCategory) -> float:
    return {
        "likely_recruiter": settings.people_min_recruiter_relevance,
        "potential_hiring_manager": settings.people_min_manager_relevance,
        "potential_referrer": settings.people_min_referrer_relevance,
    }[category]


def _employment_verification_cap(category: PeopleCategory) -> int:
    return {
        "likely_recruiter": (
            settings.people_employment_verification_max_recruiters
        ),
        "potential_hiring_manager": (
            settings.people_employment_verification_max_managers
        ),
        "potential_referrer": (
            settings.people_employment_verification_max_referrers
        ),
    }[category]


def _score_distribution(scores: list[float]) -> dict[str, int | float | None]:
    buckets = {"0_39": 0, "40_59": 0, "60_79": 0, "80_100": 0}
    for score in scores:
        if score < 40:
            buckets["0_39"] += 1
        elif score < 60:
            buckets["40_59"] += 1
        elif score < 80:
            buckets["60_79"] += 1
        else:
            buckets["80_100"] += 1
    return {
        "minimum": min(scores) if scores else None,
        "maximum": max(scores) if scores else None,
        "buckets": buckets,
    }


def build_category_search_queries(
    profile, category: PeopleCategory, *, related_company: bool = False
) -> list[PeopleSearchQuery]:
    domain = profile.parent_company_domain if related_company else profile.company_domain
    company_kind = "related" if related_company else "canonical"
    if category == "likely_recruiter":
        groups = recruiter_title_groups(
            early_career=is_early_career_job(profile.job_title)
        )
        location_mode = "soft"
    elif category == "potential_hiring_manager":
        groups = manager_title_groups(profile.role_family, profile.job_title)
        location_mode = "soft"
    else:
        midpoint = max(1, len(profile.team_member_titles) // 2)
        groups = [
            TitleGroup("exact_role_family", profile.team_member_titles[:midpoint], []),
            TitleGroup("adjacent_role_family", profile.team_member_titles[midpoint:], []),
        ]
        location_mode = "soft"
    return [
        PeopleSearchQuery(
            category=category,
            company_name=profile.company_name,
            company_domain=domain,
            company_aliases=profile.company_aliases,
            titles=group.titles,
            title_group=group.name,
            seniorities=group.seniorities,
            role_family=profile.role_family,
            department=profile.department,
            location=profile.location,
            location_filter_mode=location_mode,
            company_match_kind=company_kind,
            limit=settings.people_max_discovery_results_per_category,
        )
        for group in groups
        if group.titles and domain
    ]


def build_broadened_search_queries(
    profile, category: PeopleCategory
) -> list[PeopleSearchQuery]:
    """Return only bounded secondary queries.

    The exact strategy already ran the primary title groups. A user-triggered
    broaden therefore adds new canonical-title groups plus the normal groups
    against an evidence-backed related domain, without automatically repeating
    the paid exact-company search.
    """
    if category == "likely_recruiter":
        broader_groups = [
            TitleGroup(
                "broader_recruiting",
                [
                    "Recruiter",
                    "Talent Acquisition Specialist",
                    "Recruiting Lead",
                    "Early Talent Partner",
                ],
                [],
            )
        ]
    elif category == "potential_hiring_manager":
        broader_groups = [
            TitleGroup(
                "broader_engineering_leadership",
                [
                    "Engineering Director",
                    "Technical Director",
                    "VP Engineering",
                ],
                ["director", "head", "vp"],
            ),
            TitleGroup(
                "broader_technical_leadership",
                ["Technical Lead", "Engineering Lead"],
                ["manager"],
            ),
        ]
    else:
        broader_groups = [
            TitleGroup(
                "broader_role_family",
                [
                    "Software Engineer",
                    "Software Developer",
                    "Data Scientist",
                    "Platform Engineer",
                ],
                [],
            )
        ]

    queries = [
        PeopleSearchQuery(
            category=category,
            company_name=profile.company_name,
            company_domain=profile.company_domain,
            company_aliases=profile.company_aliases,
            titles=group.titles,
            title_group=group.name,
            seniorities=group.seniorities,
            role_family=profile.role_family,
            department=profile.department,
            location=profile.location,
            location_filter_mode="soft",
            company_match_kind="canonical",
            limit=settings.people_max_discovery_results_per_category,
        )
        for group in broader_groups
        if profile.company_domain
    ]
    if profile.parent_company_domain and profile.domain_confidence >= 0.8:
        queries.extend(
            build_category_search_queries(
                profile, category, related_company=True
            )
        )
    return queries


PreliminaryCandidate = tuple[
    float, PeopleCategory, ProviderPerson, str | None, str | None
]


def allocate_enrichment_targets(
    candidates: dict[PeopleCategory, list[PreliminaryCandidate]],
    *,
    total: int,
    reservations: dict[PeopleCategory, int],
) -> list[PreliminaryCandidate]:
    selected: list[PreliminaryCandidate] = []
    selected_keys: set[tuple[PeopleCategory, str, str]] = set()
    for category in _PEOPLE_CATEGORIES:
        rows = sorted(candidates.get(category, []), key=lambda item: item[0], reverse=True)
        for item in rows[: max(0, reservations.get(category, 0))]:
            key = (category, item[2].provider, item[2].provider_person_id)
            if key not in selected_keys and len(selected) < total:
                selected.append(item)
                selected_keys.add(key)
    remaining = sorted(
        (
            item
            for category in _PEOPLE_CATEGORIES
            for item in candidates.get(category, [])
            if (category, item[2].provider, item[2].provider_person_id) not in selected_keys
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    for item in remaining:
        if len(selected) >= total:
            break
        key = (item[1], item[2].provider, item[2].provider_person_id)
        if key not in selected_keys:
            selected.append(item)
            selected_keys.add(key)
    return selected


def _safe_user_reference(user_id: int) -> str:
    """Stable, non-reversible user reference for logs."""

    return hashlib.sha256(f"people-log-user:{user_id}".encode()).hexdigest()[:12]


def _log_search_orchestration(
    *,
    run: PeopleDiscoveryRun,
    job_id: int,
    user_id: int,
    profile: JobPeopleSearchProfile,
    strategy: DiscoveryStrategy,
    failures: list[str],
    displayed: int,
    started: float,
    cache: str,
) -> None:
    """One structured line per orchestration request.

    Deliberately excludes API keys, authorization headers, raw provider
    payloads, and any personal contact record. The company name is business
    data the job already carries; the user is referenced by a hashed id.
    """

    dominant = _dominant_failure(failures)
    snapshot = people_circuit_snapshot()
    logger.info(
        "people_search_orchestration run_id=%s job_id=%s user_ref=%s "
        "raw_company=%r normalized_company=%r canonical_domain=%s "
        "domain_source=%s domain_confidence=%.2f role_family=%s provider=%s "
        "strategy=%s cache=%s coalesced=%s circuit=%s error_code=%s "
        "retry_after=%s latency_ms=%.1f results=%s status=%s",
        run.id,
        job_id,
        _safe_user_reference(user_id),
        profile.company_raw_name or profile.company_name,
        profile.company_normalized_name,
        profile.company_domain or "unresolved",
        profile.company_evidence_source,
        profile.domain_confidence,
        profile.role_family or "none",
        run.provider,
        strategy,
        cache,
        provider_search_coalescer.inflight_count > 0,
        snapshot.as_label(),
        str(code_for_reason(dominant)) if dominant else "none",
        snapshot.retry_after_seconds if snapshot.retry_after_seconds else "none",
        (time.monotonic() - started) * 1000,
        displayed,
        run.status,
    )
    metric(
        "people_search_requests_total",
        provider=run.provider,
        status=run.status,
        error_code=str(code_for_reason(dominant)) if dominant else "none",
    )
    metric(
        "people_domain_resolution_total",
        result="resolved" if profile.company_domain else "unresolved",
        source=profile.company_evidence_source,
    )


def _searched_the_provider(provider: object, queries: list[PeopleSearchQuery]) -> bool:
    """Did a provider call actually happen for this category?

    An empty result only means "nobody matched" when the provider was asked.
    A category that produced no query at all was never asked.
    """

    if getattr(provider, "search_calls", 0):
        return True
    return bool(queries)


async def _coalesced_search(
    provider: object,
    *,
    profile: JobPeopleSearchProfile,
    category: PeopleCategory,
    queries: list[PeopleSearchQuery],
    limit: int,
    adapter_version: str,
    company: object = None,
) -> list[ProviderPerson]:
    """One provider call per canonical search, under a bounded concurrency cap.

    Ten job cards for the same company and role family expanded at once now
    share a single provider request instead of producing ten. The provider is
    only ever reached through this path so the concurrency limit cannot be
    bypassed.

    When the employer resolved to a PDL company identity, the progressive
    ladder is used; otherwise the caller's prepared queries are.
    """

    provider_name = getattr(provider, "provider_name", "unknown")
    use_ladder = bool(
        company is not None
        and getattr(company, "searchable", False)
        and hasattr(provider, "search_current_company_people")
    )
    key = search_identity(
        provider=provider_name,
        adapter_version=(
            f"{adapter_version}:{PDL_QUERY_LADDER_VERSION}"
            if use_ladder
            else adapter_version
        ),
        company_domain=(
            getattr(company, "pdl_company_id", None) or profile.company_domain
            if use_ladder
            else profile.company_domain
        ),
        company_name=profile.company_normalized_name or profile.company_name,
        role_family=profile.role_family,
        category=category,
        location=profile.location,
        # Location is a soft signal in every current query builder, so it must
        # not fragment the coalescing key.
        location_material=False,
    )

    def _call():
        if use_ladder:
            return provider.search_current_company_people(
                company=company,
                category=category,
                role_family=profile.role_family,
                job_location=profile.location,
                limit=limit,
            )
        return provider.search_people_category(queries, limit=limit)

    started = time.monotonic()
    try:
        rows = await provider_search_coalescer.run(key, provider_name, _call)
    finally:
        metric(
            "people_provider_latency",
            round((time.monotonic() - started) * 1000, 2),
            provider=provider_name,
            category=category,
        )
    metric(
        "people_provider_requests_total",
        provider=provider_name,
        status="ok",
        category=category,
    )
    return rows


@contextmanager
def _redis_lock(
    job_id: int, fingerprint: str, *, namespace: str = "discover"
) -> Iterator[bool]:
    client = None
    key = f"people:{namespace}:{job_id}:{fingerprint}"
    token = hashlib.sha256(f"{key}:{_now().isoformat()}".encode()).hexdigest()
    acquired = True
    try:
        import redis

        client = redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=0.5, socket_timeout=0.5
        )
        acquired = bool(client.set(key, token, nx=True, ex=120))
    except Exception:
        client = None
    try:
        yield acquired
    finally:
        if client is not None and acquired:
            try:
                if client.get(key) == token.encode():
                    client.delete(key)
            except Exception:
                pass


def _provider_budget_state(
    db: Session,
    *,
    provider: str,
    user_id: int,
    global_budget: int,
    per_user_budget: int,
) -> SkipReason | None:
    """``None`` when this provider may spend, otherwise the typed blocking reason.

    Each provider is measured against its own configured allowance, so one
    exhausted account never speaks for another.

    A provider with *no* budget configured returns INVALID_CONFIGURATION rather
    than a budget-exhausted state: an unbounded paid provider is not a safe
    default, but neither is silently behaving as though someone had switched it
    off. That distinction is what makes the live failure visible — the operator
    enabled Apollo and left both budgets at zero, and every discovery skipped it
    without ever saying so.
    """

    if global_budget <= 0 and per_user_budget <= 0:
        return SkipReason.INVALID_CONFIGURATION
    start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    global_used = int(
        db.scalar(
            select(
                func.coalesce(func.sum(PeopleProviderOperationUsage.budget_units), 0)
            ).where(
                PeopleProviderOperationUsage.occurred_at >= start,
                PeopleProviderOperationUsage.provider == provider,
            )
        )
        or 0
    )
    user_used = int(
        db.scalar(
            select(
                func.coalesce(func.sum(PeopleProviderOperationUsage.budget_units), 0)
            ).where(
                PeopleProviderOperationUsage.user_id == user_id,
                PeopleProviderOperationUsage.occurred_at >= start,
                PeopleProviderOperationUsage.provider == provider,
            )
        )
        or 0
    )
    if global_budget and global_used >= global_budget:
        return SkipReason.DAILY_BUDGET_EXHAUSTED
    if per_user_budget and user_used >= per_user_budget:
        return SkipReason.USER_BUDGET_EXHAUSTED
    return None


class _ApolloFallbackStep:
    """Apollo People Search, then enrichment for the few survivors.

    Search returns identifiers; only enrichment reveals a LinkedIn URL, so the
    two are separate calls and enrichment is deliberately applied to a small
    ranked subset rather than to every row the search returned.

    The rule this class exists to enforce: **a failed enrichment loses fields,
    not people.** A live Apollo account answered People Search correctly and
    then rejected ``/people/bulk_match`` with HTTP 422. That rejection used to
    be logged and dropped, which cost the run twice over — the search results
    were still discarded downstream, and the only failure left to report was an
    earlier PDL budget stop that had not stopped anything.
    """

    name = "apollo"

    def __init__(
        self,
        db: Session,
        *,
        user: User,
        job_id: int,
        run: PeopleDiscoveryRun,
        profile: JobPeopleSearchProfile,
    ) -> None:
        self._db = db
        self._user = user
        self._job_id = job_id
        self._run = run
        self._profile = profile
        self._provider: ApolloPeopleProvider | None = None

    def availability(self) -> ProviderAvailability:
        """Every gate, as a typed answer rather than a generic unavailability."""

        if not settings.people_apollo_discovery_enabled:
            return ProviderAvailability.blocked("apollo", SkipReason.DISABLED)
        if not (settings.apollo_api_key or "").strip():
            return ProviderAvailability.blocked("apollo", SkipReason.MISSING_CREDENTIALS)
        if (
            settings.people_apollo_daily_credit_budget <= 0
            and settings.people_apollo_per_user_daily_limit <= 0
        ):
            return ProviderAvailability.blocked(
                "apollo",
                SkipReason.INVALID_CONFIGURATION,
                "Apollo is enabled but PEOPLE_APOLLO_DAILY_CREDIT_BUDGET and "
                "PEOPLE_APOLLO_PER_USER_DAILY_LIMIT are both 0; set a positive "
                "budget or remove apollo from PEOPLE_PROVIDER_ORDER",
            )
        if int(settings.people_apollo_max_enrichments_per_discovery) <= 0:
            return ProviderAvailability.blocked(
                "apollo",
                SkipReason.INVALID_CONFIGURATION,
                "PEOPLE_APOLLO_MAX_ENRICHMENTS_PER_DISCOVERY is 0, so Apollo "
                "could never resolve a LinkedIn URL",
            )
        # Apollo cannot search without a company identity any more than PDL can.
        if not (self._profile.company_domain or self._profile.company_name):
            return ProviderAvailability.blocked("apollo", SkipReason.COMPANY_UNRESOLVED)
        blocked = _provider_budget_state(
            self._db,
            provider="apollo",
            user_id=self._user.id,
            global_budget=settings.people_apollo_daily_credit_budget,
            per_user_budget=settings.people_apollo_per_user_daily_limit,
        )
        if blocked:
            return ProviderAvailability.blocked("apollo", blocked)
        snapshot = circuit_state(
            provider="apollo",
            account_fingerprint=provider_account_fingerprint(settings.apollo_api_key),
            operation="people_search",
        )
        if snapshot.open_kinds:
            return ProviderAvailability.blocked("apollo", SkipReason.CIRCUIT_OPEN)
        return ProviderAvailability.ok("apollo")

    def gate(self, categories: tuple[PeopleCategory, ...]) -> None:
        self.availability().raise_if_blocked()

    async def run(
        self, categories: tuple[PeopleCategory, ...], call_budget: int
    ) -> ProviderStepResult:
        provider = ApolloPeopleProvider()
        self._provider = provider
        _configure_provider_usage(
            provider,
            db=self._db,
            user_id=self._user.id,
            job_id=self._job_id,
            discovery_run_id=self._run.id,
            adapter_version=APOLLO_ENRICHMENT_ADAPTER_VERSION,
        )
        limits = {
            "likely_recruiter": settings.people_apollo_recruiter_results,
            "potential_hiring_manager": settings.people_apollo_manager_results,
            "potential_referrer": settings.people_apollo_referral_results,
        }
        found: dict[PeopleCategory, list[ProviderPerson]] = {
            category: [] for category in _PEOPLE_CATEGORIES
        }
        calls = 0
        raw_count = 0
        no_match: set[str] = set()
        failure: str | None = None
        warnings: list[str] = []
        searched_successfully = False
        # The acceptance funnel, in counts only. Every value below is an
        # integer: no name, no identifier, no title, no URL, no raw record.
        counts: dict[str, int] = defaultdict(int)
        display_rejections: dict[str, int] = defaultdict(int)

        for category in categories:
            if calls >= call_budget:
                break
            queries = build_category_search_queries(self._profile, category)
            if not queries:
                continue
            # One search per category: the strongest company identity plus the
            # category's own titles. Repeating the ladder here would multiply
            # cost for a fallback that exists to fill a gap.
            query = queries[0].model_copy(
                update={"limit": max(1, int(limits.get(category, 4)))}
            )
            try:
                rows = await provider.search_people(query)
                calls += 1
                searched_successfully = True
            except ProviderUnavailable as exc:
                failure = exc.reason
                _log_provider_failure(exc, self._run.id)
                break
            counts["search_results_received"] += int(
                getattr(provider, "last_search_raw_count", len(rows))
            )
            counts["search_candidates_normalized"] += len(rows)
            raw_count += len(rows)
            if not rows:
                no_match.add(category)
                continue
            displayable: list[ProviderPerson] = []
            for person in rows:
                if self._exact_company(person):
                    counts["exact_company_passed"] += 1
                if _title_category_affinity(person.current_title) == category:
                    counts["title_category_passed"] += 1
                rejection = display_policy_rejection(person.full_name)
                if rejection is not None:
                    display_rejections[rejection] += 1
                    continue
                counts["display_policy_passed"] += 1
                displayable.append(person)
            if not displayable:
                # The provider answered; nothing it returned can honestly be
                # shown. That is an empty result for this category, and it is
                # emphatically not a budget stop.
                no_match.add(category)
                continue
            found[category] = deduplicate(displayable)

        # Enrichment reveals LinkedIn URLs, and is capped hard: only the top
        # ranked survivors of each category are worth a paid enrichment.
        enrich_budget = min(
            max(0, call_budget - calls),
            int(settings.people_apollo_max_enrichments_per_discovery),
        )
        enrichment_failed = False
        if enrich_budget and any(found.values()):
            requests: list[PersonEnrichmentRequest] = []
            for category in categories:
                for person in found[category][:2]:
                    if len(requests) >= enrich_budget:
                        break
                    if person.linkedin_url:
                        # Already carries the field enrichment would buy.
                        continue
                    requests.append(
                        PersonEnrichmentRequest(
                            provider_person_id=person.provider_person_id,
                            category=category,
                        )
                    )
            if requests:
                counts["enrichment_attempted"] = len(requests)
                try:
                    enriched_rows = await provider.enrich_people(requests)
                    calls += 1
                except ProviderUnavailable as exc:
                    # A failed enrichment loses LinkedIn URLs, not the people.
                    # It is carried as a warning so the finalizer can still name
                    # it when nothing survived, and ignore it when people did.
                    _log_provider_failure(exc, self._run.id)
                    enriched_rows = []
                    enrichment_failed = True
                    warnings.append(exc.reason)
                by_id = {
                    row.provider_person_id: row
                    for row in enriched_rows
                    if row.provider_person_id
                }
                counts["enrichment_succeeded"] = len(by_id)
                counts["enrichment_failed"] = max(
                    0, len(requests) - len(by_id)
                )
                for category in _PEOPLE_CATEGORIES:
                    found[category] = [
                        by_id.get(person.provider_person_id, person)
                        for person in found[category]
                    ]

        accepted = sum(len(rows) for rows in found.values())
        counts["candidates_accepted"] = accepted
        for reason, count in display_rejections.items():
            counts[f"display_policy_rejected_{reason}"] = count
        if display_rejections:
            logger.info(
                "apollo_display_policy discovery_run_id=%s policy_version=%s "
                "display_policy_rejected=%s",
                self._run.id,
                PEOPLE_DISPLAY_POLICY_VERSION,
                dict(sorted(display_rejections.items())),
            )
        logger.info(
            "apollo_candidate_funnel discovery_run_id=%s %s",
            self._run.id,
            " ".join(f"{key}={counts[key]}" for key in sorted(counts)),
        )

        return ProviderStepResult(
            candidates=found,
            calls=calls,
            raw_count=raw_count,
            no_match_categories=no_match,
            failure_reason=failure,
            warnings=warnings,
            stage_counts=dict(counts),
            outcome=_provider_step_outcome(
                searched=searched_successfully,
                failure=failure,
                accepted=accepted,
                enrichment_failed=enrichment_failed,
            ),
        )

    def _exact_company(self, person: ProviderPerson) -> bool:
        expected = (self._profile.company_domain or "").strip().lower()
        if not expected:
            return False
        return (person.current_company_domain or "").strip().lower() == expected


def _provider_step_outcome(
    *,
    searched: bool,
    failure: str | None,
    accepted: int,
    enrichment_failed: bool,
) -> str:
    """Which of the five typed provider outcomes this attempt was.

    "Failed" alone hid the live case entirely: Apollo's search worked and its
    enrichment did not, which is neither a healthy provider nor a broken one.
    """

    if failure is not None:
        return ProviderOutcome.SEARCH_FAILED.value
    if not searched:
        return ProviderOutcome.PROVIDER_SKIPPED.value
    if not accepted:
        return ProviderOutcome.SEARCH_NO_MATCH.value
    return (
        ProviderOutcome.SEARCH_SUCCESS_ENRICHMENT_FAILED.value
        if enrichment_failed
        else ProviderOutcome.SEARCH_SUCCESS_ENRICHMENT_SUCCESS.value
    )


class _PublicWebFallbackStep:
    """Optional, bounded public-web discovery. Never authoritative."""

    name = "openai_web"

    def __init__(
        self,
        db: Session,
        *,
        user: User,
        profile: JobPeopleSearchProfile,
        run: PeopleDiscoveryRun,
    ) -> None:
        self._db = db
        self._user = user
        self._profile = profile
        self._run = run
        self.rejected: dict[str, int] = {}

    def availability(self) -> ProviderAvailability:
        if not settings.people_openai_web_discovery_enabled:
            return ProviderAvailability.blocked("openai_web", SkipReason.DISABLED)
        if not (settings.openai_api_key or "").strip():
            return ProviderAvailability.blocked(
                "openai_web", SkipReason.MISSING_CREDENTIALS
            )
        # A public-web search for an unidentified company returns strangers.
        if not (self._profile.company_domain or self._profile.company_normalized_name):
            return ProviderAvailability.blocked(
                "openai_web", SkipReason.COMPANY_UNRESOLVED
            )
        blocked = _provider_budget_state(
            self._db,
            provider="openai_web",
            user_id=self._user.id,
            global_budget=settings.people_openai_web_daily_call_budget,
            per_user_budget=settings.people_openai_web_per_user_daily_limit,
        )
        if blocked:
            return ProviderAvailability.blocked("openai_web", blocked)
        return ProviderAvailability.ok("openai_web")

    def gate(self, categories: tuple[PeopleCategory, ...]) -> None:
        self.availability().raise_if_blocked()

    async def run(
        self, categories: tuple[PeopleCategory, ...], call_budget: int
    ) -> ProviderStepResult:
        provider = OpenAIWebPeopleProvider()
        outcome = await provider.discover(
            company_name=self._profile.company_name,
            company_aliases=tuple(self._profile.company_aliases),
            company_domain=self._profile.company_domain,
            categories=categories,
        )
        self.rejected = dict(outcome.rejected)
        found: dict[PeopleCategory, list[ProviderPerson]] = {
            category: [] for category in _PEOPLE_CATEGORIES
        }
        for person in outcome.candidates:
            category = _title_category_affinity(person.current_title)
            if category in categories:
                found[category].append(person)
        no_match = {
            category
            for category in categories
            if not found[category] and not outcome.failure_reason
        }
        accepted = sum(len(rows) for rows in found.values())
        return ProviderStepResult(
            candidates=found,
            calls=min(outcome.searches_used, call_budget),
            raw_count=provider.last_search_raw_count,
            no_match_categories=no_match,
            failure_reason=outcome.failure_reason,
            stage_counts={
                "search_results_received": provider.last_search_raw_count,
                "search_candidates_normalized": len(outcome.candidates),
                "candidates_accepted": accepted,
            },
            # The public web adapter has no separate enrichment step, so its
            # outcomes collapse onto the same vocabulary every other provider
            # reports — which is what lets the finalizer treat it identically.
            outcome=_provider_step_outcome(
                searched=outcome.failure_reason is None,
                failure=outcome.failure_reason,
                accepted=accepted,
                enrichment_failed=False,
            ),
        )


def _final_provider_label(
    accepted_sources: dict[str, int],
    *,
    attempted: list[str],
    primary: str,
) -> str:
    """Who supplied the result this run is reporting.

    One provider that supplied every accepted contact is named outright. When
    several contributed, a neutral ``multi:`` label records the set rather than
    crediting one of them. With nothing accepted the column falls back to the
    chain that was attempted, so a failed run still says how far it got.
    """

    contributors = sorted(name for name, count in accepted_sources.items() if count)
    if len(contributors) == 1:
        return contributors[0][:40]
    if contributors:
        return f"multi:{'+'.join(contributors)}"[:40]
    if len(attempted) > 1:
        return f"multi:{'+'.join(attempted)}"[:40]
    return (attempted[0] if attempted else primary)[:40]


async def _run_provider_fallbacks(
    db: Session,
    *,
    user: User,
    job_id: int,
    run: PeopleDiscoveryRun,
    profile: JobPeopleSearchProfile,
    categories: dict[PeopleCategory, list[ProviderPerson]],
    primary_failures: list[str],
    primary_no_match: set[str],
    diagnostics: dict[str, dict],
    company_identity: object | None,
) -> WaterfallResult | None:
    """Offer the categories the primary left short to the rest of the chain.

    Returns ``None`` when no fallback provider is configured after the primary,
    so the caller keeps the primary's results untouched.
    """

    order = configured_provider_order()
    primary = str(settings.people_primary_provider).strip().lower()
    followers = [name for name in order if name != primary]
    if not followers:
        return None

    target = CoverageTarget.from_settings()
    gaps = categories_below_target(categories, target)
    if not gaps:
        return None

    # A request-scoped primary failure (unresolved company, invalid input) means
    # no other provider can help either.
    for reason in primary_failures:
        if code_for_reason(reason) in {
            PeopleErrorCode.COMPANY_DOMAIN_UNRESOLVED,
            PeopleErrorCode.INVALID_INPUT,
            PeopleErrorCode.USER_BUDGET_EXHAUSTED,
            PeopleErrorCode.REQUEST_CANCELLED,
        }:
            return None
    if not settings.people_provider_fallback_on_no_match and not primary_failures:
        return None

    steps: list[ProviderStep] = []
    web_step: _PublicWebFallbackStep | None = None
    for name in followers:
        if name == "apollo":
            steps.append(
                _ApolloFallbackStep(
                    db, user=user, job_id=job_id, run=run, profile=profile
                )
            )
        elif name == "openai_web":
            web_step = _PublicWebFallbackStep(
                db, user=user, profile=profile, run=run
            )
            steps.append(web_step)
    if not steps:
        return None

    _log_unavailable_providers(steps, run.id)
    result = await run_waterfall(
        steps,
        seed=categories,
        target=target,
        discovery_run_id=run.id,
    )
    # Diagnostics stay per-category and provider-labelled so an operator can see
    # which hop produced which people without any of it reaching the UI.
    for attempt in result.attempts:
        for category in attempt.categories:
            entry = diagnostics.setdefault(category, {})
            entry.setdefault("provider_fallbacks", []).append(attempt.safe_summary())
    if web_step is not None and web_step.rejected:
        for category in gaps:
            diagnostics.setdefault(category, {})[
                "public_web_rejections"
            ] = dict(web_step.rejected)
    logger.info(
        "people_waterfall job_id=%s discovery_run_id=%s providers=%s coverage=%s "
        "calls=%s duplicates=%s",
        job_id,
        run.id,
        ",".join(result.providers_attempted) or "none",
        result.coverage(),
        result.total_calls,
        result.duplicates_dropped,
    )
    return result


async def discover(
    db: Session,
    user: User,
    job_id: int,
    strategy: DiscoveryStrategy = "exact",
) -> dict:
    """One user action, one final outcome, one ``people_waterfall_finalized``.

    The event is emitted from a ``finally`` deliberately. Every previous
    attempt to log the chain's conclusion lived on the success path, so the
    branches that mattered most — a rejected fallback request, an internal
    error, a cancelled request, a cache hit — produced nothing at all, and a
    live investigation had to infer the outcome from the absence of a line.
    """

    started = time.monotonic()
    event = FinalizationEvent(
        job_id=job_id,
        discovery_run_id=None,
        provider_order=configured_provider_order(),
    )
    try:
        return await _discover_once(
            db, user, job_id, strategy, started=started, event=event
        )
    except HTTPException as exc:
        # A quota, burst, or eligibility rejection never reached a provider.
        # It is still a discovery request, and still gets its one event.
        event.final_status = "rejected"
        event.final_reason = _rejection_reason(exc)
        raise
    except BaseException as exc:
        event.final_status = "aborted"
        event.final_reason = type(exc).__name__
        raise
    finally:
        event.duration_ms = (time.monotonic() - started) * 1000
        event.emit()


def _rejection_reason(exc: HTTPException) -> str:
    """The typed code behind a pre-provider rejection, never its message."""

    detail = exc.detail
    if isinstance(detail, dict):
        code = detail.get("code")
        if isinstance(code, str) and code:
            return code[:60]
    return f"http_{exc.status_code}"


async def _discover_once(
    db: Session,
    user: User,
    job_id: int,
    strategy: DiscoveryStrategy,
    *,
    started: float,
    event: FinalizationEvent,
) -> dict:
    metric(
        "people_discovery_requests_total",
        provider=settings.people_primary_provider,
        scoring_version=SCORING_VERSION,
    )
    job = _job_or_404(db, job_id)
    fresh = _fresh_candidates(db, job_id, user.id)
    if fresh:
        run = PeopleDiscoveryRun(
            job_id=job_id, user_id=user.id, status="complete", provider="cache",
            query_fingerprint=query_fingerprint(job), cache_hit=True, completed_at=_now(),
        )
        db.add(run)
        for candidate in fresh:
            _ensure_recommendation(db, user.id, candidate, None, None)
        db.commit()
        metric(
            "people_discovery_cache_hits_total",
            provider="database",
            scoring_version=SCORING_VERSION,
        )
        metric("people_discovery_duration_ms", (time.monotonic() - started) * 1000)
        logger.info("people_discovery cache_hit=true job_id=%s scoring_version=%s", job_id, SCORING_VERSION)
        event.discovery_run_id = run.id
        event.final_status = "complete"
        event.accepted_count = len(fresh)
        event.quota_decision = "not_charged"
        event.cache_decision = "hit_candidates"
        return recommendations_payload(db, user, job_id)

    fingerprint = query_fingerprint(job, strategy)
    cached_no_match = _fresh_no_match_run(
        db,
        job_id=job_id,
        user_id=user.id,
        fingerprint=fingerprint,
    )
    if cached_no_match is not None:
        metric(
            "people_discovery_cache_hits_total",
            provider="database_no_match",
            scoring_version=SCORING_VERSION,
        )
        logger.info(
            "people_discovery cache_hit=true no_match=true job_id=%s strategy=%s scoring_version=%s",
            job_id,
            strategy,
            SCORING_VERSION,
        )
        event.discovery_run_id = cached_no_match.id
        event.final_status = cached_no_match.status
        event.quota_decision = "not_charged"
        event.cache_decision = "hit_no_match"
        return recommendations_payload(db, user, job_id)

    cached_provider_error = _current_provider_error_run(
        db,
        job_id=job_id,
        user_id=user.id,
        fingerprint=fingerprint,
    )
    if (
        cached_provider_error is not None
        and _provider_error_blocks_discovery(
            cached_provider_error,
            fallback_available=_fallback_provider_available(db, user.id),
        )
    ):
        metric(
            "people_discovery_cache_hits_total",
            provider="database_provider_error",
            scoring_version=SCORING_VERSION,
        )
        event.discovery_run_id = cached_provider_error.id
        event.final_status = cached_provider_error.status
        event.final_reason = cached_provider_error.failure_code
        event.quota_decision = "not_charged"
        event.cache_decision = "hit_provider_error"
        return recommendations_payload(db, user, job_id)

    if strategy == "broadened":
        exact_fingerprint = query_fingerprint(job, "exact")
        if _fresh_no_match_run(
            db,
            job_id=job_id,
            user_id=user.id,
            fingerprint=exact_fingerprint,
        ) is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "PEOPLE_BROADEN_NOT_ELIGIBLE",
                    "message": (
                        "Complete an exact-company search before broadening."
                    ),
                },
            )

    # Burst first: a rejected burst must not consume a daily unit.
    rate_limit(f"discover:{user.id}", settings.people_discovery_rate_limit_per_hour)
    # Provider cost control. Its exhaustion is an operational stop, not the
    # user's entitlement running out, so it is checked before the reservation
    # and reported with its own code.
    _budget_check(db, user.id)
    with _redis_lock(job_id, fingerprint) as acquired:
        if not acquired:
            # A coalesced waiter pays nothing: the leader's single unit covers
            # the work both callers are waiting on.
            metric("people_discovery_coalesced_waiter_total", provider=settings.people_primary_provider)
            event.final_status = "in_progress"
            event.quota_decision = "not_charged"
            event.cache_decision = "coalesced_waiter"
            return {
                "status": "in_progress",
                "availability_reason": "available",
                "beta": is_beta(user),
                "categories": _empty_categories(),
                "warnings": [],
                "search_scope": {
                    "company_scope": "Hiring company only",
                    "location_filter": "soft",
                    "parent_company_matches_included": False,
                    "refresh_eligible": False,
                },
                "controls": {
                    "email_discovery": settings.people_email_discovery_enabled,
                    "outreach_drafting": settings.people_outreach_drafting_enabled,
                },
            }
        # Recheck after lock acquisition.
        rechecked = _fresh_candidates(db, job_id, user.id)
        if rechecked:
            event.final_status = "complete"
            event.accepted_count = len(rechecked)
            event.quota_decision = "not_charged"
            event.cache_decision = "hit_candidates_after_lock"
            return recommendations_payload(db, user, job_id)
        if _fresh_no_match_run(
            db,
            job_id=job_id,
            user_id=user.id,
            fingerprint=fingerprint,
        ) is not None:
            event.final_status = "complete"
            event.quota_decision = "not_charged"
            event.cache_decision = "hit_no_match_after_lock"
            return recommendations_payload(db, user, job_id)
        cached_provider_error = _current_provider_error_run(
            db,
            job_id=job_id,
            user_id=user.id,
            fingerprint=fingerprint,
        )
        if (
            cached_provider_error is not None
            and _provider_error_blocks_discovery(
                cached_provider_error,
                fallback_available=_fallback_provider_available(db, user.id),
            )
        ):
            event.discovery_run_id = cached_provider_error.id
            event.final_status = cached_provider_error.status
            event.final_reason = cached_provider_error.failure_code
            event.quota_decision = "not_charged"
            event.cache_decision = "hit_provider_error_after_lock"
            return recommendations_payload(db, user, job_id)
        # Past every cache and coalescing opportunity: this is a genuine new
        # search, so exactly one user unit is reserved here — never inside the
        # category loop, the strategy ladder, or a provider adapter.
        reservation = reserve_user_discovery(db, user)
        db.commit()
        metric("people_user_discoveries_total", provider=settings.people_primary_provider)
        profile = extract_job_people_profile(job, db)
        provider = get_people_provider()
        company_context = {
            "canonical_company_name": profile.company_name,
            "canonical_company_domain": profile.company_domain,
            "aliases": profile.company_aliases,
            "parent_company": profile.parent_company_name,
            "parent_domain": profile.parent_company_domain,
            "domain_confidence": profile.domain_confidence,
            "evidence_source": profile.company_evidence_source,
            "scoring_version": SCORING_VERSION,
            "employment_validation_version": EMPLOYMENT_VALIDATION_VERSION,
            "employment_evidence_version": EMPLOYMENT_EVIDENCE_VERSION,
            "provider_adapter_version": (
                APOLLO_ENRICHMENT_ADAPTER_VERSION
                if settings.people_primary_provider == "apollo"
                else PDL_DISCOVERY_STRATEGY_VERSION
                if settings.people_primary_provider == "pdl"
                else "provider-neutral-v1"
            ),
            "secondary_employment_verification_enabled": (
                settings.people_employment_secondary_verification_enabled
            ),
            "discovery_strategy_version": DISCOVERY_STRATEGY_VERSION,
            "discovery_strategy": strategy,
            CONTRACT_VERSION_KEY: PEOPLE_SEARCH_CONTRACT_VERSION,
        }
        run = PeopleDiscoveryRun(
            job_id=job_id, user_id=user.id, status="running",
            provider=settings.people_primary_provider, query_fingerprint=fingerprint,
            company_context=company_context, category_diagnostics={},
        )
        db.add(run)
        db.commit()
        event.discovery_run_id = run.id
        _configure_provider_usage(
            provider,
            db=db,
            user_id=user.id,
            job_id=job_id,
            discovery_run_id=run.id,
            adapter_version=str(
                company_context["provider_adapter_version"]
            ),
        )
        categories: dict[PeopleCategory, list[ProviderPerson]] = {}
        diagnostics: dict[str, dict] = {
            category: {
                "search_queries": [],
                "title_groups": [],
                "company_domain_used": profile.company_domain,
                "company_aliases_considered": profile.company_aliases,
                "seniorities_used": [],
                "location_filter_mode": "soft",
                "raw_search_result_count": 0,
                "query_executed": False,
                "provider_call_count": 0,
                "normalized_profile_count": 0,
                "exact_company_current_profiles": 0,
                "former_employees": 0,
                "conflicting_employees": 0,
                "stale_or_insufficient_evidence": 0,
                "below_title_relevance": 0,
                "below_confidence_threshold": 0,
                "deduplicated_into_another_identity": 0,
                "assigned_to_another_category": 0,
                "assigned_to_stronger_category": 0,
                "accepted": 0,
                "display_cap_excluded": 0,
                "unique_candidate_count": 0,
                "preliminary_score_distribution": _score_distribution([]),
                "selected_for_enrichment": 0,
                "enrichment_matches": 0,
                "enrichment_misses": 0,
                "candidates_rejected": 0,
                "rejection_reason_counts": {},
                "final_displayed_count": 0,
                "related_company_search_used": False,
                "broadened_title_search_used": strategy == "broadened",
                "discovery_strategy": strategy,
                "employment_secondary_verification_attempts": 0,
                "employment_secondary_verification_matches": 0,
                "employment_secondary_verification_credits": 0,
                "employment_unresolved_candidates": 0,
            }
            for category in _PEOPLE_CATEGORIES
        }
        failures: list[str] = []
        # Provider problems that cost the run some data but not its people: an
        # Apollo enrichment rejected while the search results survived. The
        # finalizer reads these only when nothing at all was accepted, so they
        # never downgrade a run that produced contacts — and never let an
        # earlier budget stop answer for them either.
        warnings: list[str] = []
        # Categories the provider answered successfully with zero people. These
        # are results, not failures, and are what separates a truthful
        # "no strong matches" from "the provider rejected the request".
        no_match_categories: set[str] = set()
        searched = 0
        enriched: list[ProviderPerson] = []
        displayed: dict[str, int] = defaultdict(int)
        # Which provider each surviving contact came from. The run's `provider`
        # column is written from this, so a result Apollo supplied is never
        # filed under PDL.
        accepted_sources: dict[str, int] = {}
        # Every provider that actually ran, in order. Starts with the primary,
        # which is attempted before the waterfall is consulted.
        providers_attempted: list[str] = [settings.people_primary_provider]
        # Typed outcome per provider, for the finalization event.
        provider_outcomes: dict[str, str] = {}
        provider_calls = 0
        employment_outcomes: dict[str, int] = defaultdict(int)
        pdl_company_identity = None
        pipeline_stage = "search"
        try:
            exact_queries = {
                category: (
                    build_category_search_queries(profile, category)
                    if strategy == "exact"
                    else build_broadened_search_queries(profile, category)
                )
                for category in _PEOPLE_CATEGORIES
            }
            category_pdl_search = bool(
                strategy == "exact"
                and settings.people_primary_provider == "pdl"
                and hasattr(provider, "search_people_category")
            )
            # Resolve the employer to a stable PDL company id before searching
            # anyone. Searching by display name alone depends on the job feed
            # and the provider spelling the company identically, which is what
            # left Toshiba Global Commerce and Vanderbilt Health with nothing.
            if category_pdl_search and hasattr(provider, "resolve_company"):
                try:
                    pdl_company_identity = await provider.resolve_company(
                        raw_name=profile.company_raw_name or profile.company_name,
                        normalized_name=profile.company_normalized_name,
                        aliases=tuple(profile.company_aliases),
                        verified_domain=profile.company_domain,
                    )
                except ProviderUnavailable as exc:
                    failures.append(exc.reason)
                    _log_provider_failure(exc, run.id)
                    pdl_company_identity = None
                if pdl_company_identity is not None:
                    company_context.update(pdl_company_identity.safe_summary())
                # No verified company evidence at all — no PDL company id and no
                # verified domain. Searching anyway would return strangers who
                # merely work somewhere similarly named, so nothing is searched
                # and no credit is spent. This is distinct from "we searched and
                # nobody matched".
                company_unresolved = not (
                    (pdl_company_identity is not None and pdl_company_identity.searchable)
                    or profile.company_domain
                )
                if company_unresolved:
                    failures.append("company_domain_unresolved")
                    metric(
                        "people_domain_resolution_total",
                        result="unresolved",
                        source=profile.company_evidence_source,
                    )
                    category_pdl_search = False
            total_pdl_remaining = (
                settings.people_pdl_max_results_per_discovery
            )
            category_limits = {
                "likely_recruiter": settings.people_pdl_recruiter_results,
                "potential_hiring_manager": settings.people_pdl_manager_results,
                "potential_referrer": settings.people_pdl_referral_results,
            }
            for category in _PEOPLE_CATEGORIES:
                category_rows: list[ProviderPerson] = []
                queries = exact_queries[category]
                if category_pdl_search:
                    for query in queries:
                        diagnostics[category]["search_queries"].append({
                            "title_group": query.title_group,
                            "titles": query.titles,
                            "company_match_kind": query.company_match_kind,
                        })
                        diagnostics[category]["title_groups"].append(
                            query.title_group
                        )
                        diagnostics[category]["seniorities_used"].extend(
                            query.seniorities
                        )
                    call_limit = max(
                        0,
                        min(
                            category_limits[category],
                            total_pdl_remaining,
                        ),
                    )
                    if call_limit and _pdl_budget_allows_call(
                        db,
                        user.id,
                        call_limit,
                    ):
                        diagnostics[category]["query_executed"] = True
                        diagnostics[category]["provider_call_count"] = 1
                        try:
                            category_rows = await _coalesced_search(
                                provider,
                                profile=profile,
                                category=category,
                                queries=queries,
                                limit=call_limit,
                                adapter_version=str(
                                    company_context["provider_adapter_version"]
                                ),
                                company=pdl_company_identity,
                            )
                            if not category_rows and _searched_the_provider(
                                provider, queries
                            ):
                                # The provider answered; nobody matched. That is
                                # a result, and must never be reported as a
                                # rejected request. An empty *query set* is not
                                # an answer and must not land here.
                                no_match_categories.add(category)
                                metric(
                                    "people_no_match_total",
                                    provider=settings.people_primary_provider,
                                    category=category,
                                )
                        except ProviderUnavailable as exc:
                            failures.append(exc.reason)
                            _log_provider_failure(exc, run.id)
                        raw_count = int(
                            getattr(
                                provider,
                                "last_search_raw_count",
                                len(category_rows),
                            )
                        )
                        normalized_count = int(
                            getattr(
                                provider,
                                "last_search_normalized_count",
                                len(category_rows),
                            )
                        )
                        diagnostics[category][
                            "raw_search_result_count"
                        ] = raw_count
                        diagnostics[category][
                            "normalized_profile_count"
                        ] = normalized_count
                        searched += normalized_count
                        total_pdl_remaining -= raw_count
                    elif call_limit:
                        # A spent provider budget is its own operational state,
                        # not a provider failure, and it must never move the
                        # circuit.
                        failures.append("provider_budget_exceeded")
                        metric(
                            "people_budget_rejections_total",
                            provider=settings.people_primary_provider,
                            status="provider_budget",
                            category=category,
                        )
                        diagnostics[category]["rejection_reason_counts"][
                            "provider_budget_insufficient"
                        ] = 1
                for query in queries:
                    if category_pdl_search:
                        continue
                    diagnostics[category]["search_queries"].append({
                        "title_group": query.title_group,
                        "titles": query.titles,
                        "company_match_kind": query.company_match_kind,
                    })
                    diagnostics[category]["title_groups"].append(query.title_group)
                    diagnostics[category]["seniorities_used"].extend(query.seniorities)
                    if query.company_match_kind == "related":
                        diagnostics[category]["related_company_search_used"] = True
                    try:
                        rows = await provider.search_people(query)
                    except ProviderUnavailable as exc:
                        failures.append(exc.reason)
                        _log_provider_failure(exc, run.id)
                        rows = []
                    category_rows.extend(rows)
                    searched += len(rows)
                    diagnostics[category]["raw_search_result_count"] += len(rows)
                    diagnostics[category]["normalized_profile_count"] += len(rows)
                    diagnostics[category]["query_executed"] = True
                    diagnostics[category]["provider_call_count"] += 1
                categories[category] = deduplicate(category_rows)
                diagnostics[category]["unique_candidate_count"] = len(categories[category])
                duplicate_count = max(
                    0,
                    len(category_rows)
                    - diagnostics[category]["unique_candidate_count"],
                )
                if duplicate_count:
                    diagnostics[category]["rejection_reason_counts"]["duplicate_person"] = duplicate_count
                    diagnostics[category][
                        "deduplicated_into_another_identity"
                    ] += duplicate_count
                if not category_rows:
                    diagnostics[category]["rejection_reason_counts"]["no_search_results"] = 1
                metric(
                    "people_discovery_candidates_found",
                    len(categories[category]),
                    provider=settings.people_primary_provider,
                    category=category,
                    scoring_version=SCORING_VERSION,
                )
            pipeline_stage = "fallback"
            provider_calls += sum(
                int(diagnostics[category]["provider_call_count"])
                for category in _PEOPLE_CATEGORIES
            )
            provider_outcomes[settings.people_primary_provider] = (
                _provider_step_outcome(
                    searched=any(
                        diagnostics[category]["query_executed"]
                        for category in _PEOPLE_CATEGORIES
                    ),
                    failure=_dominant_failure(failures),
                    accepted=sum(len(rows) for rows in categories.values()),
                    enrichment_failed=False,
                )
            )
            # The primary provider has had its turn. Anything it left short is
            # offered to the rest of the configured chain — Apollo, then the
            # optional public-web fallback — for those categories only. A spent
            # PDL budget stops PDL, not the product.
            waterfall_result = await _run_provider_fallbacks(
                db,
                user=user,
                job_id=job_id,
                run=run,
                profile=profile,
                categories=categories,
                primary_failures=failures,
                primary_no_match=no_match_categories,
                diagnostics=diagnostics,
                company_identity=pdl_company_identity,
            )
            if waterfall_result is not None:
                categories = waterfall_result.candidates
                failures.extend(waterfall_result.failures)
                warnings.extend(waterfall_result.warnings)
                # A follower that answered with nobody is a truthful result and
                # must reach the finalizer: it is what stops an earlier
                # provider's budget stop from speaking for a provider that was
                # never blocked at all.
                no_match_categories |= waterfall_result.no_match_categories
                provider_outcomes.update(waterfall_result.provider_outcomes)
                provider_calls += waterfall_result.total_calls
                company_context["provider_waterfall"] = waterfall_result.safe_summary()
                for name in waterfall_result.providers_attempted:
                    if name not in providers_attempted:
                        providers_attempted.append(name)

            pipeline_stage = "enrichment"

            preliminary_by_category: dict[PeopleCategory, list[PreliminaryCandidate]] = {
                category: [] for category in _PEOPLE_CATEGORIES
            }
            for category, rows in categories.items():
                for person in rows:
                    school, employer = _shared_evidence(db, user.id, person)
                    score = score_candidate(
                        category, person, profile,
                        shared_school=bool(school), shared_employer=bool(employer),
                    )
                    preliminary_by_category[category].append(
                        (score, category, person, school, employer)
                    )
                diagnostics[category]["preliminary_score_distribution"] = _score_distribution(
                    [item[0] for item in preliminary_by_category[category]]
                )
            assigned_by_category = _strongest_category_candidates(
                preliminary_by_category
            )
            for category in _PEOPLE_CATEGORIES:
                weaker_assignments = (
                    len(preliminary_by_category[category])
                    - len(assigned_by_category[category])
                )
                if weaker_assignments:
                    counts = diagnostics[category][
                        "rejection_reason_counts"
                    ]
                    counts["weaker_category_assignment"] = (
                        counts.get("weaker_category_assignment", 0)
                        + weaker_assignments
                    )
                    diagnostics[category][
                        "assigned_to_another_category"
                    ] += weaker_assignments
                    diagnostics[category][
                        "assigned_to_stronger_category"
                    ] += weaker_assignments
            complete_person_only = getattr(
                provider, "bulk_capability_state", "unknown"
            ) in {"temporarily_rejected", "account_not_supported"}
            pdl_direct_profiles = category_pdl_search
            enrich_targets = allocate_enrichment_targets(
                assigned_by_category,
                total=(
                    settings.people_apollo_complete_person_max_per_job
                    if complete_person_only
                    else (
                        settings.people_max_displayed_recruiters
                        + settings.people_max_displayed_managers
                        + settings.people_max_displayed_referrers
                        if pdl_direct_profiles
                        else settings.people_max_enrichments_per_job
                    )
                ),
                reservations=(
                    {
                        "likely_recruiter": (
                            settings.people_apollo_complete_person_max_recruiters
                        ),
                        "potential_hiring_manager": (
                            settings.people_apollo_complete_person_max_managers
                        ),
                        "potential_referrer": (
                            settings.people_apollo_complete_person_max_referrers
                        ),
                    }
                    if complete_person_only
                    else (
                        {
                            "likely_recruiter": (
                                settings.people_max_displayed_recruiters
                            ),
                            "potential_hiring_manager": (
                                settings.people_max_displayed_managers
                            ),
                            "potential_referrer": (
                                settings.people_max_displayed_referrers
                            ),
                        }
                        if pdl_direct_profiles
                        else {
                            "likely_recruiter": (
                                settings.people_recruiter_enrichment_reserve
                            ),
                            "potential_hiring_manager": (
                                settings.people_manager_enrichment_reserve
                            ),
                            "potential_referrer": (
                                settings.people_referrer_enrichment_reserve
                            ),
                        }
                    )
                ),
            )
            for _score, category, _person, _school, _employer in enrich_targets:
                diagnostics[category]["selected_for_enrichment"] += 1
            # Only the primary provider's own records can be enriched by the
            # primary provider. A fallback provider's people arrive already
            # complete — its step ran its own search *and* its own enrichment —
            # and their identifiers belong to a different namespace entirely.
            #
            # Passing them here is what erased the live Apollo results: PDL's
            # enrich_people answers from its own search cache, found nothing
            # under an Apollo id, and every Apollo contact was dropped as an
            # "enrichment miss" before the run had a chance to display one.
            primary_name = str(settings.people_primary_provider).strip().lower()
            primary_targets = [
                item for item in enrich_targets if item[2].provider == primary_name
            ]
            carried_targets = [
                item for item in enrich_targets if item[2].provider != primary_name
            ]
            unique_enrichment_requests = list(
                dict.fromkeys(
                    item[2].provider_person_id for item in primary_targets
                )
            )
            try:
                enriched = await provider.enrich_people(
                    [
                        PersonEnrichmentRequest(
                            provider_person_id=person.provider_person_id,
                            category=category,
                            rank_score=score,
                        )
                        for score, category, person, _school, _employer
                        in primary_targets
                    ]
                )
            except ProviderUnavailable as exc:
                failures.append(exc.reason)
                _log_provider_failure(exc, run.id)
                enriched = []
                metric(
                    "people_discovery_provider_errors_total",
                    provider=settings.people_primary_provider,
                    status="enrichment_failed",
                )
            pipeline_stage = "employment_validation"
            metric(
                "people_enrichment_requests_total",
                len(unique_enrichment_requests),
                provider=settings.people_primary_provider,
            )
            # Keyed by provider as well as id: two providers' identifier spaces
            # overlap, and a collision would attach one person's record to
            # another's.
            enriched_by_id: dict[tuple[str, str], ProviderPerson] = {
                (item.provider, item.provider_person_id): item for item in enriched
            }
            for _score, _category, person, _school, _employer in carried_targets:
                enriched_by_id.setdefault(
                    (person.provider, person.provider_person_id), person
                )
            rejection_reason_for = getattr(
                provider, "enrichment_rejection_reason", lambda _value: None
            )
            for _score, category, initial, _school, _employer in enrich_targets:
                key = (
                    "enrichment_matches"
                    if (initial.provider, initial.provider_person_id)
                    in enriched_by_id
                    else "enrichment_misses"
                )
                diagnostics[category][key] += 1
                if key == "enrichment_misses":
                    counts = diagnostics[category]["rejection_reason_counts"]
                    reason = (
                        rejection_reason_for(initial.provider_person_id)
                        or "enrichment_record_not_found"
                    )
                    counts[reason] = counts.get(reason, 0) + 1
            for category in _PEOPLE_CATEGORIES:
                not_selected = max(
                    0,
                    len(assigned_by_category[category])
                    - diagnostics[category]["selected_for_enrichment"],
                )
                diagnostics[category]["candidates_rejected"] += not_selected
                if not_selected:
                    counts = diagnostics[category]["rejection_reason_counts"]
                    counts["enrichment_budget_exhausted"] = not_selected
            expires = _now() + timedelta(days=_people_result_ttl_days())
            caps = {
                "likely_recruiter": settings.people_max_displayed_recruiters,
                "potential_hiring_manager": settings.people_max_displayed_managers,
                "potential_referrer": settings.people_max_displayed_referrers,
            }
            for _, category, initial, school, employer in enrich_targets:
                if displayed[category] >= caps[category]:
                    diagnostics[category]["display_cap_excluded"] += 1
                    diagnostics[category]["candidates_rejected"] += 1
                    continue
                person = enriched_by_id.get(
                    (initial.provider, initial.provider_person_id)
                )
                if person is None:
                    diagnostics[category]["candidates_rejected"] += 1
                    continue
                person.exact_company_match = (
                    bool(profile.company_domain)
                    and person.current_company_domain == profile.company_domain
                )
                employment = _validate_employment(db, person, profile)
                score = score_candidate(
                    category, person, profile,
                    shared_school=bool(school), shared_employer=bool(employer),
                )
                data_confidence = confidence(person)
                threshold = _category_threshold(category)
                rejection_reasons = candidate_rejection_reasons(
                    category,
                    person,
                    profile,
                    relevance=score,
                    data_confidence=data_confidence,
                    relevance_threshold=threshold,
                    confidence_threshold=settings.people_min_data_confidence,
                )
                verification_blockers = {
                    reason
                    for reason in rejection_reasons
                    if reason
                    not in {"stale_employment", "below_confidence_threshold"}
                }
                verification_budget_reason = (
                    _employment_verification_budget_reason(db, user.id)
                )
                if verification_budget_reason:
                    diagnostics[category][
                        "employment_secondary_verification_budget_reason"
                    ] = verification_budget_reason
                secondary_verification_candidate = bool(
                    settings.people_employment_secondary_verification_enabled
                    and person.exact_company_match
                    and employment.identity_strong
                    and not verification_blockers
                    and (
                        employment.status
                        in {
                            "conflicting_current_employment",
                            "stale_or_uncertain",
                            "exact_company_current_but_unverified_freshness",
                        }
                        or settings.people_employment_comparison_mode
                    )
                )
                if secondary_verification_candidate:
                    diagnostics[category]["employment_unresolved_candidates"] += 1
                should_secondary_verify = bool(
                    secondary_verification_candidate
                    and verification_budget_reason is None
                    and diagnostics[category][
                        "employment_secondary_verification_attempts"
                    ]
                    < _employment_verification_cap(category)
                )
                if should_secondary_verify:
                    diagnostics[category][
                        "employment_secondary_verification_attempts"
                    ] += 1
                    secondary_match = await _secondary_employment_validation(
                        db,
                        user.id,
                        job_id,
                        run.id,
                        person,
                        profile,
                        category,
                    )
                    if secondary_match is not None:
                        secondary_result, secondary_person = secondary_match
                        diagnostics[category][
                            "employment_secondary_verification_matches"
                        ] += 1
                        diagnostics[category][
                            "employment_secondary_verification_credits"
                        ] += secondary_result.credits_consumed
                        if secondary_person is not None:
                            if (
                                secondary_result.status
                                == "confirmed_exact_company_verified"
                            ):
                                secondary_person.employment_verified_at = (
                                    secondary_result.verified_at
                                )
                                secondary_person.employment_source = (
                                    "secondary_verification"
                                )
                            _person_for_provider(db, secondary_person)
                            db.flush()
                        if secondary_result.status in {
                            "confirmed_exact_company_verified",
                            "conflicting_current_employment",
                        }:
                            employment = secondary_result
                employment_outcomes[employment.status] += 1
                if employment.status in {
                    "confirmed_exact_company_verified",
                    "exact_company_current_but_unverified_freshness",
                }:
                    diagnostics[category][
                        "exact_company_current_profiles"
                    ] += 1
                elif employment.status == "former_employee":
                    diagnostics[category]["former_employees"] += 1
                elif employment.status == "conflicting_current_employment":
                    diagnostics[category]["conflicting_employees"] += 1
                elif employment.status in {
                    "stale_or_uncertain",
                    "insufficient_evidence",
                }:
                    diagnostics[category][
                        "stale_or_insufficient_evidence"
                    ] += 1
                diagnostics[category].setdefault(
                    "employment_validation_outcomes", {}
                )
                diagnostics[category]["employment_validation_outcomes"][
                    employment.status
                ] = (
                    diagnostics[category][
                        "employment_validation_outcomes"
                    ].get(employment.status, 0)
                    + 1
                )
                if employment.status == "confirmed_exact_company_verified":
                    data_confidence = max(data_confidence, 0.75)
                    rejection_reasons = [
                        reason
                        for reason in rejection_reasons
                        if reason
                        not in {
                            "stale_employment",
                            "below_confidence_threshold",
                        }
                    ]
                rejection_reasons.extend(employment.rejection_codes)
                rejection_reasons = list(dict.fromkeys(rejection_reasons))
                if any(
                    reason in {
                        "weak_role_similarity",
                        "title_mismatch",
                        "below_relevance_threshold",
                    }
                    for reason in rejection_reasons
                ):
                    diagnostics[category]["below_title_relevance"] += 1
                if "below_confidence_threshold" in rejection_reasons:
                    diagnostics[category][
                        "below_confidence_threshold"
                    ] += 1
                if (
                    rejection_reasons == ["weak_company_confidence"]
                    and category != "potential_referrer"
                    and score >= threshold + 15
                ):
                    rejection_reasons = []
                # The actionable-contact gate, applied last so no earlier
                # relaxation can talk its way past it. A candidate that fails
                # here still takes the suppression path below — it is persisted
                # as a suppressed row and stays available as an internal search
                # hint, but it is never a visible recommendation.
                decision = evaluate_actionable_contact(
                    person,
                    profile,
                    category=category,
                    employment_status=employment.status,
                )
                metric("people_contacts_evaluated_total", provider=person.provider)
                if not decision.accepted:
                    # Merged, not counted: the suppression branch below tallies
                    # every reason exactly once, and counting here as well
                    # double-reported each withheld contact.
                    rejection_reasons = list(
                        dict.fromkeys([*rejection_reasons, *decision.rejection_reasons])
                    )
                    _record_actionable_rejection(
                        decision.rejection_reasons, provider=person.provider
                    )
                else:
                    # Accepted candidates carry the validated URL, never the raw
                    # one the provider sent.
                    person = decision.candidate or person
                    metric(
                        "people_contacts_accepted_total", provider=person.provider
                    )
                if rejection_reasons:
                    pipeline_stage = "recommendation_persistence"
                    canonical = _person_for_provider(db, person)
                    db.flush()
                    candidate = db.scalar(
                        select(JobPeopleCandidate).where(
                            JobPeopleCandidate.job_id == job_id,
                            JobPeopleCandidate.person_id == canonical.id,
                            JobPeopleCandidate.candidate_category == category,
                        )
                    )
                    if candidate is None:
                        candidate = JobPeopleCandidate(
                            job_id=job_id,
                            person_id=canonical.id,
                            candidate_category=category,
                            category_score=score,
                            data_confidence=data_confidence,
                            current_employment_confidence=employment.confidence,
                            employment_validation_status=employment.status,
                            employment_validation_version=(
                                EMPLOYMENT_VALIDATION_VERSION
                            ),
                            employment_validation_checked_at=_now(),
                            recommendation_reasons=[],
                            recommendation_limitations=rejection_reasons,
                            scoring_version=SCORING_VERSION,
                            expires_at=expires,
                        )
                        db.add(candidate)
                        db.flush()
                    else:
                        candidate.category_score = score
                        candidate.data_confidence = data_confidence
                        candidate.current_employment_confidence = (
                            employment.confidence
                        )
                        candidate.employment_validation_status = (
                            employment.status
                        )
                        candidate.employment_validation_version = (
                            EMPLOYMENT_VALIDATION_VERSION
                        )
                        candidate.employment_validation_checked_at = _now()
                        candidate.recommendation_reasons = []
                        candidate.recommendation_limitations = (
                            rejection_reasons
                        )
                        candidate.scoring_version = SCORING_VERSION
                        candidate.expires_at = expires
                    suppressed = _ensure_recommendation(
                        db,
                        user.id,
                        candidate,
                        school,
                        employer,
                    )
                    suppressed.suppressed_at = _now()
                    diagnostics[category]["candidates_rejected"] += 1
                    counts = diagnostics[category]["rejection_reason_counts"]
                    for reason in rejection_reasons:
                        counts[reason] = counts.get(reason, 0) + 1
                    continue
                reasons, limitations = explanations(
                    category,
                    person,
                    profile,
                    shared_school=school,
                    shared_employer=employer,
                    employment_validation_status=employment.status,
                )
                pipeline_stage = "recommendation_persistence"
                canonical = _person_for_provider(db, person)
                db.flush()
                candidate = db.scalar(
                    select(JobPeopleCandidate).where(
                        JobPeopleCandidate.job_id == job_id,
                        JobPeopleCandidate.person_id == canonical.id,
                        JobPeopleCandidate.candidate_category == category,
                    )
                )
                if candidate is None:
                    candidate = JobPeopleCandidate(
                        job_id=job_id, person_id=canonical.id, candidate_category=category,
                        category_score=score, data_confidence=data_confidence,
                        current_employment_confidence=employment.confidence,
                        employment_validation_status=employment.status,
                        employment_validation_version=EMPLOYMENT_VALIDATION_VERSION,
                        employment_validation_checked_at=_now(),
                        recommendation_reasons=reasons,
                        recommendation_limitations=limitations,
                        scoring_version=SCORING_VERSION, expires_at=expires,
                    )
                    db.add(candidate)
                    db.flush()
                else:
                    candidate.category_score = score
                    candidate.data_confidence = data_confidence
                    candidate.current_employment_confidence = employment.confidence
                    candidate.employment_validation_status = employment.status
                    candidate.employment_validation_version = EMPLOYMENT_VALIDATION_VERSION
                    candidate.employment_validation_checked_at = _now()
                    candidate.recommendation_reasons = reasons
                    candidate.recommendation_limitations = limitations
                    candidate.expires_at = expires
                recommendation = _ensure_recommendation(
                    db,
                    user.id,
                    candidate,
                    school,
                    employer,
                )
                recommendation.suppressed_at = None
                canonical.employment_revalidation_required = False
                canonical.employment_conflict_detected_at = None
                displayed[category] += 1
                accepted_sources[person.provider] = (
                    accepted_sources.get(person.provider, 0) + 1
                )
                diagnostics[category]["accepted"] += 1
                diagnostics[category]["final_displayed_count"] += 1
                metric(
                    "people_discovery_candidates_displayed",
                    provider=settings.people_primary_provider,
                    category=category,
                    scoring_version=SCORING_VERSION,
                )
                pipeline_stage = "employment_validation"
            usage = await provider.get_usage()
            run = db.get(PeopleDiscoveryRun, run.id)
            any_displayed = any(displayed.values())
            # ONE decision, for the whole chain, in one place. Every branch that
            # used to write its own status is gone: that is how a follower's
            # rejected request could be logged and then forgotten while an
            # earlier provider's budget stop was reported as the final word.
            outcome = decide_outcome(
                accepted_count=sum(displayed.values()),
                failures=failures,
                warnings=warnings,
                no_match_categories=no_match_categories,
            )
            run.status = outcome.status
            run.failure_code = outcome.reason[:60] if outcome.reason else None
            run.safe_failure_message = (
                _safe_provider_message(outcome.reason) if outcome.reason else None
            )
            if outcome.code is not None and _refundable_failure(
                outcome.code, provider
            ):
                # Nothing useful was bought with the user's unit: either
                # JobPilot's own data was insufficient, or the provider was
                # never meaningfully reached. Give it back.
                reservation.refund(db, reason=str(outcome.code))
            # The provider column names who actually answered. Writing the
            # configured primary here regardless — as this did — is what made an
            # Apollo-supplied result read as a PDL result, and an upstream PDL
            # budget stop read as the final word.
            run.provider = _final_provider_label(
                accepted_sources,
                attempted=providers_attempted,
                primary=settings.people_primary_provider,
            )
            run.records_searched = searched
            # Records carrying enriched detail, whichever provider supplied it.
            run.records_enriched = len(enriched_by_id)
            # Secondary employment verification has its own ledger and budget.
            # Do not fold those credits into the primary discovery run.
            run.provider_credits_used = usage.credits_used
            for category in _PEOPLE_CATEGORIES:
                diagnostics[category]["seniorities_used"] = list(dict.fromkeys(
                    diagnostics[category]["seniorities_used"]
                ))
                diagnostics[category]["title_groups"] = list(dict.fromkeys(
                    diagnostics[category]["title_groups"]
                ))
            completed_at = _now()
            provider_error_context = (
                _provider_error_context(
                    run.failure_code or "provider_unavailable",
                    now=completed_at,
                )
                if run.status in PROVIDER_ERROR_STATUSES
                else {}
            )
            durable_usage = _durable_usage_summary(db, run.id)
            # The ledger is the truth; recording the decision here means an
            # operator never has to infer it. The inspector previously derived
            # "charged" from `cache_hit`, so a run that reserved a unit and then
            # refunded it still claimed to have charged one — which is why the
            # run metadata and the quota row disagreed.
            quota_decision = reservation.decision
            run.company_context = {
                **company_context,
                "user_quota_decision": quota_decision,
                "providers_attempted": list(providers_attempted),
                "accepted_candidate_sources": dict(accepted_sources),
                "provider_request_count": usage.requests,
                "durable_provider_usage": durable_usage,
                "provider_bulk_capability_state": getattr(
                    provider, "bulk_capability_state", "unknown"
                ),
                "provider_outcomes": dict(sorted(provider_outcomes.items())),
                "provider_warnings": list(warnings),
                "finalization_version": PEOPLE_FINALIZATION_VERSION,
                "display_policy_version": PEOPLE_DISPLAY_POLICY_VERSION,
                # Only true when a budget is the *whole* story. The UI's
                # capacity copy is gated on this, never on a budget failure
                # merely being present somewhere in the chain.
                "all_providers_budget_blocked": (
                    not any_displayed
                    and every_failure_was_a_budget_stop([*failures, *warnings])
                ),
                "pipeline_outcomes": {
                    "search": (
                        "partial_failure" if failures else "completed"
                    ),
                    "enrichment": (
                        "degraded" if warnings else "completed"
                    ),
                    **_provider_pipeline_outcomes(
                        provider, durable_usage
                    ),
                    "employment_validation": dict(
                        sorted(employment_outcomes.items())
                    ),
                    "persistence": "completed",
                },
                "provider_enrichment_safe_metrics": getattr(
                    provider, "enrichment_safe_metrics", {}
                ),
                "provider_search_identifier_safe_metrics": getattr(
                    provider, "search_identifier_safe_metrics", {}
                ),
                **provider_error_context,
            }
            run.category_diagnostics = diagnostics
            run.completed_at = completed_at
            pipeline_stage = "recommendation_commit"
            db.commit()
            metric(
                "people_provider_credits_used",
                run.provider_credits_used,
                provider=usage.provider,
            )
            logger.info(
                "people_discovery status=%s job_id=%s searched=%s displayed=%s credits=%s scoring_version=%s",
                run.status, job_id, searched, sum(displayed.values()),
                run.provider_credits_used, SCORING_VERSION,
            )
            _log_search_orchestration(
                run=run,
                job_id=job_id,
                user_id=user.id,
                profile=profile,
                strategy=strategy,
                failures=failures,
                displayed=sum(displayed.values()),
                started=started,
                cache="miss",
            )
            event.providers_attempted = list(providers_attempted)
            event.provider_outcomes = dict(provider_outcomes)
            event.accepted_count = sum(displayed.values())
            event.accepted_sources = dict(accepted_sources)
            event.final_status = run.status
            event.final_reason = run.failure_code
            event.quota_decision = reservation.decision
            event.provider_calls = provider_calls + usage.requests
        except Exception as exc:
            db.rollback()
            persistence_failure = (
                isinstance(exc, ProviderUsagePersistenceError)
                or (
                    isinstance(exc, SQLAlchemyError)
                    and pipeline_stage
                    in {
                        "recommendation_persistence",
                        "recommendation_commit",
                    }
                )
            )
            failed_run = db.get(PeopleDiscoveryRun, run.id)
            if failed_run:
                completed_at = _now()
                durable_usage = _durable_usage_summary(db, run.id)
                failure_code = (
                    "recommendation_commit_failed"
                    if persistence_failure
                    else "discovery_failed"
                )
                failed_run.status = (
                    "persistence_error"
                    if persistence_failure
                    else "provider_unavailable"
                )
                failed_run.failure_code = failure_code
                failed_run.safe_failure_message = (
                    "JobPilot found potential contacts but could not save "
                    "the results. No additional search will run unless you retry."
                    if persistence_failure
                    else "People discovery is temporarily unavailable."
                )
                failed_run.company_context = {
                    **(failed_run.company_context or {}),
                    "durable_provider_usage": durable_usage,
                    "provider_bulk_capability_state": getattr(
                        provider, "bulk_capability_state", "unknown"
                    ),
                    "pipeline_outcomes": {
                        "search": (
                            "completed"
                            if pipeline_stage != "search"
                            else "failed"
                        ),
                        "enrichment": (
                            "completed"
                            if pipeline_stage
                            in {
                                "employment_validation",
                                "recommendation_persistence",
                                "recommendation_commit",
                            }
                            else "failed"
                        ),
                        **_provider_pipeline_outcomes(
                            provider, durable_usage
                        ),
                        "employment_validation": dict(
                            sorted(employment_outcomes.items())
                        ),
                        "persistence": (
                            "failed"
                            if persistence_failure
                            else "not_completed"
                        ),
                    },
                    **_provider_error_context(
                        failure_code,
                        now=completed_at,
                    ),
                }
                failed_run.category_diagnostics = diagnostics
                failed_run.records_searched = searched
                failed_run.records_enriched = len(enriched)
                failed_run.completed_at = completed_at
                if not _provider_work_started(provider):
                    # An internal failure before any provider call is not a
                    # search the user should pay for.
                    reservation.refund(db, reason="internal_error_before_provider_work")
                db.commit()
                event.final_status = failed_run.status
                event.final_reason = failed_run.failure_code
            event.providers_attempted = list(providers_attempted)
            event.provider_outcomes = dict(provider_outcomes)
            event.accepted_sources = dict(accepted_sources)
            event.accepted_count = sum(displayed.values())
            event.quota_decision = reservation.decision
            event.provider_calls = provider_calls
            metric(
                "people_discovery_provider_errors_total",
                provider=settings.people_primary_provider,
                status=(
                    "recommendation_commit_failed"
                    if persistence_failure
                    else "discovery_failed"
                ),
            )
            logger.exception("people_discovery failed job_id=%s", job_id)
        metric("people_discovery_duration_ms", (time.monotonic() - started) * 1000)
        return recommendations_payload(db, user, job_id)


def _empty_categories() -> dict[str, list]:
    return {
        "likely_recruiters": [],
        "potential_hiring_managers": [],
        "potential_referrers": [],
    }


def recommendations_payload(db: Session, user: User, job_id: int) -> dict:
    job = _job_or_404(db, job_id)
    rows = db.execute(
        select(UserJobPeopleRecommendation, JobPeopleCandidate, ProfessionalPerson)
        .join(JobPeopleCandidate, UserJobPeopleRecommendation.job_people_candidate_id == JobPeopleCandidate.id)
        .join(ProfessionalPerson, JobPeopleCandidate.person_id == ProfessionalPerson.id)
        .where(
            UserJobPeopleRecommendation.user_id == user.id,
            UserJobPeopleRecommendation.job_id == job_id,
            UserJobPeopleRecommendation.suppressed_at.is_(None),
            JobPeopleCandidate.scoring_version == SCORING_VERSION,
            JobPeopleCandidate.employment_validation_version
            == EMPLOYMENT_VALIDATION_VERSION,
            JobPeopleCandidate.employment_validation_status.in_(
                DISPLAYABLE_EMPLOYMENT_STATUSES
            ),
            ProfessionalPerson.employment_revalidation_required.is_(False),
        )
        .order_by(JobPeopleCandidate.category_score.desc())
    ).all()
    categories = _empty_categories()
    key_map = {
        "likely_recruiter": "likely_recruiters",
        "potential_hiring_manager": "potential_hiring_managers",
        "potential_referrer": "potential_referrers",
    }
    now = _now()
    stale = False
    expires_at: datetime | None = None
    # Stale-while-error: when the provider is unavailable, previously verified
    # results are far more useful than an error page. They are only served
    # inside an explicitly configured window, and the response says so.
    circuit_snapshot = people_circuit_snapshot()
    serve_stale = bool(circuit_snapshot.open_kinds)
    stale_cutoff = now - timedelta(days=max(0, settings.people_stale_result_window_days))
    served_stale = False
    for recommendation, candidate, person in rows:
        expires = candidate.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=UTC)
        stale = stale or expires <= now
        expires_at = expires if expires_at is None else min(expires_at, expires)
        if expires <= now:
            if not (serve_stale and expires > stale_cutoff):
                continue
            served_stale = True
            metric(
                "people_cache_stale_served_total",
                provider=settings.people_primary_provider,
                circuit=circuit_snapshot.as_label(),
            )
        # Defence in depth on the read path. A row written under an older, laxer
        # contract — a masked name, no LinkedIn URL — must not be served just
        # because it is already in the database. Contract versioning retires the
        # *run*; this retires the individual record.
        displayable, suppressed_reasons = is_displayable_record(
            full_name=person.canonical_full_name,
            linkedin_url=person.linkedin_url,
            employment_validation_status=candidate.employment_validation_status,
        )
        if not displayable:
            for reason in suppressed_reasons:
                metric(
                    "people_legacy_record_suppressed_total",
                    reason=reason,
                    policy_version=ACTIONABLE_CONTACT_POLICY_VERSION,
                )
            continue
        email_lookup_allowed = (
            candidate.employment_validation_status
            in {
                "confirmed_exact_company_verified",
                "exact_company_current_but_unverified_freshness",
            }
            and not person.employment_revalidation_required
        )
        email = (
            decrypt_email(person.professional_email_ciphertext)
            if person.email_verification_status == "verified"
            and email_lookup_allowed
            else None
        )
        categories[key_map[candidate.candidate_category]].append(
            {
                "recommendation_id": recommendation.id,
                "full_name": _display_name(person.canonical_full_name),
                "current_title": person.current_title,
                "current_company": person.current_company_name,
                "category": candidate.candidate_category,
                "category_label": {
                    "likely_recruiter": "Likely recruiter",
                    "potential_hiring_manager": "Potential hiring manager",
                    "potential_referrer": "Potential referral candidate",
                }[candidate.candidate_category],
                "relevance_score": round(candidate.category_score),
                "confidence": confidence_label(candidate.data_confidence),
                "current_employment_confidence": round(
                    candidate.current_employment_confidence, 2
                ),
                "employment_validation_status": (
                    candidate.employment_validation_status
                ),
                "employment_last_verified_at": (
                    person.employment_last_verified_at
                    if candidate.employment_validation_status
                    == "confirmed_exact_company_verified"
                    else None
                ),
                "employment_warning": (
                    "Currently listed at the hiring company. Current employment has not been independently verified."
                    if candidate.employment_validation_status
                    == "exact_company_current_but_unverified_freshness"
                    else None
                ),
                "email_lookup_allowed": email_lookup_allowed,
                "reasons": [*candidate.recommendation_reasons, *recommendation.personalized_reasons][:3],
                "limitations": candidate.recommendation_limitations,
                "last_checked_at": candidate.discovered_at,
                "professional_profile_url": safe_profile_url(person.linkedin_url),
                "email_status": (
                    person.email_verification_status
                    if email_lookup_allowed
                    else "employment_conflict"
                ),
                "professional_email": email,
                "email_verified_at": person.email_verified_at,
                "saved": recommendation.saved_at is not None,
                "contacted": recommendation.contacted_at is not None,
            }
        )
    exact_fingerprint = query_fingerprint(job, "exact")
    broadened_fingerprint = query_fingerprint(job, "broadened")
    current_fingerprints = [exact_fingerprint, broadened_fingerprint]
    latest_current_run = _latest_run(
        db,
        job_id=job_id,
        user_id=user.id,
        fingerprints=current_fingerprints,
    )
    if latest_current_run is not None and not run_is_compatible(latest_current_run):
        # A run recorded without the current contract is legacy even when its
        # fingerprint still matches: rows written before versioning existed
        # carry statuses that were interpreted differently. Treating it as
        # absent routes the job to the "refresh to check again" state.
        latest_current_run = None
    latest_any_run = _latest_run(db, job_id=job_id, user_id=user.id)
    latest_run = latest_current_run or latest_any_run
    has_results = any(categories.values())
    stale_version = latest_any_run is not None and latest_current_run is None
    stale_strategy_without_results = stale_version and not has_results
    response_status = "complete" if has_results else "not_started"
    if (
        has_results
        and latest_current_run is not None
        and latest_current_run.status == "partial"
    ):
        # People were found, but at least one category was answered with
        # nobody. Saying "complete" would overstate the coverage.
        response_status = "partial"
    warnings: list[str] = []
    if stale_strategy_without_results:
        response_status = "stale"
        warnings.append(
            "Contact discovery has been upgraded. Refresh to check again."
        )
        if latest_any_run is not None and not run_is_compatible(latest_any_run):
            metric(
                "people_legacy_cache_invalidations_total",
                provider=latest_any_run.provider or "unknown",
                status=latest_any_run.status,
            )
    elif not has_results and latest_run and latest_run.status in {"running"}:
        response_status = "in_progress"
    elif (
        not has_results
        and latest_run
        and latest_run.status == "persistence_error"
    ):
        response_status = "persistence_error"
        warnings.append(
            latest_run.safe_failure_message
            or (
                "JobPilot found potential contacts but could not save the "
                "results. No additional search will run unless you retry."
            )
        )
    elif (
        not has_results
        and latest_run
        and latest_run.status in PROVIDER_ERROR_STATUSES
    ):
        # Each failure keeps its own status so the UI can explain the real
        # cause instead of the old catch-all "temporarily paused" line.
        response_status = latest_run.status
        warnings.append(
            latest_run.safe_failure_message
            or _safe_provider_message(latest_run.failure_code or "")
        )
    elif not has_results and latest_run and latest_run.status == "partial":
        response_status = "partial"
        warnings.append("Some professional data sources were unavailable; showing reliable partial results.")
    elif latest_run and not has_results:
        response_status = "no_reliable_matches"
    if stale and not has_results:
        response_status = "stale"
        warnings.append("Previous results are stale. Refresh is available.")
    availability_reason = (
        latest_run.failure_code
        # A legacy run's failure_code was written under provider semantics that
        # no longer hold, so it must not be surfaced as the current reason.
        # Doing so is what left one Toshiba job permanently reporting
        # "the provider request was invalid" while an identical job did not.
        if latest_run
        and run_is_compatible(latest_run)
        and (
            response_status in PROVIDER_ERROR_STATUSES
            or (
                response_status == "stale"
                and latest_run.status
                in PROVIDER_ERROR_STATUSES
            )
        )
        else "available"
    )
    retry_eligible = False
    retry_after_seconds: int | None = None
    retry_eligible_at: datetime | None = None
    if (
        stale_version
        and latest_run
        and latest_run.status == "provider_unavailable"
        and availability_reason == "provider_schema_error"
    ):
        # A provider-schema failure becomes retryable only when its adapter
        # fingerprint is obsolete. The POST remains an explicit user action.
        retry_eligible = True
    elif latest_run and latest_run.status in PROVIDER_ERROR_STATUSES:
        (
            retry_eligible,
            retry_after_seconds,
            retry_eligible_at,
        ) = _provider_error_retry_state(latest_run)
    exact_no_match = _fresh_no_match_run(
        db,
        job_id=job_id,
        user_id=user.id,
        fingerprint=exact_fingerprint,
    )
    broadened_no_match = _fresh_no_match_run(
        db,
        job_id=job_id,
        user_id=user.id,
        fingerprint=broadened_fingerprint,
    )
    broaden_eligible = bool(
        not has_results
        and exact_no_match is not None
        and broadened_no_match is None
    )
    broaden_attempted = bool(
        latest_current_run
        and (latest_current_run.company_context or {}).get("discovery_strategy")
        == "broadened"
    )
    related_company_search_attempted = bool(
        latest_current_run
        and any(
            bool(value.get("related_company_search_used"))
            for value in (latest_current_run.category_diagnostics or {}).values()
            if isinstance(value, dict)
        )
    )
    if has_results:
        metric(
            "people_results_total",
            sum(len(items) for items in categories.values()),
            provider=settings.people_primary_provider,
            status="stale" if served_stale else "fresh",
        )
    return {
        "status": response_status,
        "availability_reason": availability_reason,
        "retry_eligible": retry_eligible,
        "retry_after_seconds": retry_after_seconds,
        "retry_eligible_at": retry_eligible_at,
        # Tells the client these results predate the provider outage, so it can
        # label them as cached instead of presenting them as a fresh search.
        "result_freshness": (
            "stale" if served_stale else "fresh" if has_results else "none"
        ),
        "provider_circuit": circuit_snapshot.as_label(),
        "beta": is_beta(user),
        "generated_at": latest_run.completed_at if latest_run else None,
        "expires_at": expires_at,
        "categories": categories,
        "coverage": {key: bool(value) for key, value in categories.items()},
        "search_scope": {
            "company_scope": (
                "Hiring company and evidence-backed related domain"
                if related_company_search_attempted
                else "Hiring company only"
            ),
            "location_filter": "soft",
            "parent_company_matches_included": related_company_search_attempted,
            "refresh_eligible": response_status == "stale"
            or (
                response_status
                in PROVIDER_ERROR_STATUSES
                and retry_eligible
            ),
            "exact_company_search_completed": exact_no_match is not None
            or bool(has_results and latest_current_run),
            "related_company_search_attempted": related_company_search_attempted,
            "broaden_eligible": broaden_eligible,
            "broaden_attempted": broaden_attempted,
        },
        "warnings": warnings,
        # The user's remaining allowance, counted in deliberate actions. Reading
        # this payload never consumes any of it.
        "quota": quota_snapshot(db, user).as_payload(),
        "controls": {
            "email_discovery": settings.people_email_discovery_enabled,
            "outreach_drafting": settings.people_outreach_drafting_enabled,
        },
    }


def diagnostics_payload(db: Session, user: User, job_id: int) -> dict:
    if settings.app_env != "development":
        raise HTTPException(status_code=404, detail="Not found")
    _job_or_404(db, job_id)
    run = db.scalar(
        select(PeopleDiscoveryRun)
        .where(
            PeopleDiscoveryRun.job_id == job_id,
            PeopleDiscoveryRun.user_id == user.id,
        )
        .order_by(PeopleDiscoveryRun.started_at.desc())
    )
    if run is None:
        return {"discovery_run_id": None, "company_context": {}, "categories": {}}
    return {
        "discovery_run_id": run.id,
        "status": run.status,
        "company_context": run.company_context or {},
        "categories": run.category_diagnostics or {},
        "credits_consumed": run.provider_credits_used,
        "completed_at": run.completed_at,
    }


def owned_recommendation(
    db: Session, user: User, job_id: int, recommendation_id: int
) -> tuple[UserJobPeopleRecommendation, JobPeopleCandidate, ProfessionalPerson]:
    row = db.execute(
        select(UserJobPeopleRecommendation, JobPeopleCandidate, ProfessionalPerson)
        .join(JobPeopleCandidate, UserJobPeopleRecommendation.job_people_candidate_id == JobPeopleCandidate.id)
        .join(ProfessionalPerson, JobPeopleCandidate.person_id == ProfessionalPerson.id)
        .where(
            UserJobPeopleRecommendation.id == recommendation_id,
            UserJobPeopleRecommendation.user_id == user.id,
            UserJobPeopleRecommendation.job_id == job_id,
        )
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Recommendation not found")
    return row


async def find_email(db: Session, user: User, job_id: int, recommendation_id: int) -> dict:
    if not settings.people_email_discovery_enabled:
        raise HTTPException(status_code=404, detail="Email discovery is disabled")
    recommendation, candidate, person = owned_recommendation(
        db, user, job_id, recommendation_id
    )
    if (
        recommendation.suppressed_at is not None
        or
        candidate.employment_validation_version != EMPLOYMENT_VALIDATION_VERSION
        or candidate.employment_validation_status
        not in {
            "confirmed_exact_company_verified",
            "exact_company_current_but_unverified_freshness",
        }
        or person.employment_revalidation_required
    ):
        status_value = (
            "employment_conflict"
            if person.employment_revalidation_required
            or candidate.employment_validation_status
            == "conflicting_current_employment"
            else "identity_uncertain"
        )
        return {
            "status": status_value,
            "professional_email": None,
            "verified_at": None,
        }
    checked_at = person.email_verified_at
    if checked_at and checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=UTC)
    reusable_statuses = {"verified", "accept_all", "risky", "unknown", "not_found"}
    if (
        person.email_verification_status in reusable_statuses
        and checked_at
        and checked_at
        > _now() - timedelta(days=settings.people_email_result_ttl_days)
    ):
        return {
            "status": person.email_verification_status,
            "professional_email": (
                decrypt_email(person.professional_email_ciphertext)
                if person.email_verification_status == "verified"
                else None
            ),
            "verified_at": person.email_verified_at,
        }
    try:
        rate_limit(f"email:{user.id}", settings.people_email_rate_limit_per_hour)
    except HTTPException:
        return {
            "status": "rate_limited",
            "professional_email": None,
            "verified_at": None,
        }
    if _email_budget_exceeded(db, user.id):
        return {
            "status": "budget_exceeded",
            "professional_email": None,
            "verified_at": None,
        }
    job = _job_or_404(db, job_id)
    domain = extract_job_people_profile(job, db).company_domain
    if not domain or person.current_company_domain != domain:
        return {
            "status": "employment_conflict",
            "professional_email": None,
            "verified_at": None,
        }
    with _redis_lock(
        job_id, f"{user.id}:{person.id}", namespace="email"
    ) as acquired:
        if not acquired:
            return {
                "status": "searching",
                "professional_email": None,
                "verified_at": None,
            }
        db.refresh(person)
        if (
            person.email_verification_status in reusable_statuses
            and person.email_verified_at
            and (
                person.email_verified_at
                if person.email_verified_at.tzinfo
                else person.email_verified_at.replace(tzinfo=UTC)
            )
            > _now() - timedelta(days=settings.people_email_result_ttl_days)
        ):
            return {
                "status": person.email_verification_status,
                "professional_email": (
                    decrypt_email(person.professional_email_ciphertext)
                    if person.email_verification_status == "verified"
                    else None
                ),
                "verified_at": person.email_verified_at,
            }
        provider = get_email_provider()
        metric("people_email_find_requests_total", provider="hunter")
        try:
            found = await provider.find_work_email(
                WorkEmailRequest(
                    full_name=person.canonical_full_name,
                    company_domain=domain,
                )
            )
            if not found.email or not is_professional_email(found.email, domain):
                person.email_verification_status = "not_found"
                person.email_verified_at = _now()
            else:
                verified = await provider.verify_work_email(found.email)
                person.email_verification_status = verified.status
                person.email_verified_at = verified.verified_at or _now()
                if verified.status == "verified":
                    person.professional_email_ciphertext = encrypt_email(found.email)
                    person.professional_email_hash = email_hash(found.email)
                    metric("people_email_verified_total", provider=verified.provider)
                else:
                    person.professional_email_ciphertext = None
                    person.professional_email_hash = None
            db.add(
                PeopleDiscoveryRun(
                    job_id=job_id,
                    user_id=user.id,
                    status=f"email_{person.email_verification_status}",
                    provider="hunter",
                    query_fingerprint=hashlib.sha256(
                        f"email:{user.id}:{person.id}:{_now().date().isoformat()}".encode()
                    ).hexdigest(),
                    records_searched=1,
                    records_enriched=1
                    if person.email_verification_status != "not_found"
                    else 0,
                    provider_credits_used=int(getattr(provider, "credits", 0)),
                    completed_at=_now(),
                )
            )
            record_audit(
                db,
                user.id,
                "people_work_email_discovered",
                {
                    "job_id": job_id,
                    "recommendation_id": recommendation.id,
                    "status": person.email_verification_status,
                },
            )
            db.commit()
        except ProviderUnavailable as exc:
            person.email_verification_status = (
                "rate_limited"
                if exc.reason == "provider_rate_limited"
                else "provider_unavailable"
            )
            db.commit()
    if person.email_verification_status == "not_found":
        metric("people_email_not_found_total", provider="hunter")
    return {
        "status": person.email_verification_status,
        "professional_email": (
            decrypt_email(person.professional_email_ciphertext)
            if person.email_verification_status == "verified" else None
        ),
        "verified_at": person.email_verified_at,
    }


def outreach_draft(
    db: Session, user: User, job_id: int, recommendation_id: int, request: OutreachDraftRequest
) -> dict:
    if not settings.people_outreach_drafting_enabled:
        raise HTTPException(status_code=404, detail="Outreach drafting is disabled")
    started = time.monotonic()
    recommendation, candidate, person = owned_recommendation(db, user, job_id, recommendation_id)
    metric(
        "people_outreach_draft_requests_total",
        channel=request.message_type,
        category=candidate.candidate_category,
    )
    # The gate must match what the UI is allowed to *show*. It previously
    # accepted only ``confirmed_exact_company_verified`` while the card and the
    # work-email action both accept the full displayable set, so every person
    # discovered through PDL — which never carries an independent freshness
    # verification — rendered a draft button that always answered 409.
    if (
        recommendation.suppressed_at is not None
        or candidate.employment_validation_version
        != EMPLOYMENT_VALIDATION_VERSION
        or candidate.employment_validation_status
        not in DISPLAYABLE_EMPLOYMENT_STATUSES
        or person.employment_revalidation_required
    ):
        metric(
            "people_outreach_draft_failures_total",
            channel=request.message_type,
            stage="employment_validation",
            error_code="PEOPLE_EMPLOYMENT_REVALIDATION_REQUIRED",
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "PEOPLE_EMPLOYMENT_REVALIDATION_REQUIRED",
                "message": (
                    "Current employment must be revalidated before drafting outreach."
                ),
            },
        )
    job = _job_or_404(db, job_id)
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    name = (profile.full_name if profile else "") or "a candidate"
    first_name = person.canonical_full_name.split()[0]
    greeting = f"Hi {first_name},"
    facts_used = [
        f"job:{job.title}",
        f"company:{job.company}",
        f"recipient_title:{person.current_title}",
        f"recipient_company:{person.current_company_name}",
    ]
    shared_line = ""
    if request.draft_type == "shared_school" and recommendation.shared_school:
        shared_line = f" We both attended {recommendation.shared_school}."
        facts_used.append("confirmed_shared_school")
    elif request.draft_type == "shared_previous_employer" and recommendation.shared_employer:
        shared_line = f" We both worked at {recommendation.shared_employer}."
        facts_used.append("confirmed_shared_previous_employer")
    elif request.draft_type in {"shared_school", "shared_previous_employer"}:
        raise HTTPException(status_code=422, detail="The selected shared evidence is not available.")

    skills = [
        str(value).strip()
        for value in (profile.skills if profile else [])
        if str(value).strip()
    ]
    job_skills = {
        normalize_text(str(value))
        for value in [*(job.required_skills or []), *(job.preferred_skills or [])]
    }
    qualifications = [
        skill for skill in skills if normalize_text(skill) in job_skills
    ][:2]
    if not qualifications:
        qualifications = skills[:2]
    qualification_line = ""
    if qualifications:
        qualification_line = (
            " My relevant experience includes "
            + " and ".join(qualifications)
            + "."
        )
        facts_used.extend(f"applicant_skill:{value}" for value in qualifications)
    advertised_skills = [
        str(value).strip()
        for value in (job.required_skills or [])
        if str(value).strip()
    ][:2]
    job_focus_line = ""
    if advertised_skills:
        job_focus_line = (
            " The posting specifically emphasizes "
            + " and ".join(advertised_skills)
            + "."
        )
        facts_used.extend(f"job_skill:{value}" for value in advertised_skills)

    if candidate.candidate_category == "likely_recruiter":
        role_line = (
            f" I applied for the {job.title} role at {job.company}."
            f"{qualification_line}{job_focus_line}"
        )
        ask = (
            " If you handle this area, could you point me to the most useful "
            "information to include for the recruiting team?"
        )
        omitted = ["recruiter_assignment_unconfirmed"]
    elif candidate.candidate_category == "potential_hiring_manager":
        role_line = (
            f" I’m applying for the {job.title} role at {job.company}."
            f"{qualification_line}{job_focus_line}"
        )
        ask = (
            " From your perspective, what capability matters most for someone "
            "joining this engineering function?"
        )
        omitted = ["team_membership_unconfirmed", "hiring_responsibility_unconfirmed"]
    else:
        role_line = (
            f" I’m applying for the {job.title} role at {job.company}, and your "
            f"work as {person.current_title} is close to the area I’m exploring."
            f"{qualification_line}{job_focus_line}"
        )
        direct_referral = request.draft_type in {
            "referral_request",
            "direct_referral_request",
        }
        ask = (
            " If you’re comfortable, would you consider referring me after "
            "reviewing my background?"
            if direct_referral
            else " Would you be open to sharing one perspective on the role or application process?"
        )
        omitted = ["referral_willingness_unconfirmed"]
    guidance = request.user_guidance or request.user_details
    guidance_line = f" {guidance.strip()}" if guidance and guidance.strip() else ""
    if guidance_line:
        facts_used.append("user_provided_guidance")

    if request.tone == "warm":
        opener = " I appreciate you taking a moment to read this."
        close = "Thanks for any perspective you’re comfortable sharing."
    elif request.tone == "direct":
        opener = ""
        close = "Thank you for considering the question."
    else:
        opener = ""
        close = "Thanks for your time."
    core = f"{greeting}{opener}{shared_line}{role_line}{guidance_line}{ask}"
    if request.message_type == "email":
        category_context = {
            "likely_recruiter": (
                "I want to give the recruiting team the clearest, most relevant "
                "summary rather than send a broad introduction."
            ),
            "potential_hiring_manager": (
                "I’m especially interested in how the advertised work maps to "
                "the engineering priorities your function is solving."
            ),
            "potential_referrer": (
                "I’m looking for candid context before making any request beyond "
                "learning more about the opportunity."
            ),
        }[candidate.candidate_category]
        body = (
            f"{core}\n\n{category_context} That context would help me keep the "
            "application focused and useful. I’m happy to share a concise resume "
            f"or clarify any relevant experience.\n\n{close}\n{name}"
        )
        subject = f"Question about {job.title} at {job.company}"
    elif request.message_type == "linkedin_connection_note":
        body = f"{greeting}{role_line}{ask}"
        if len(body) > 300:
            body = (
                f"Hi {first_name}, I’m applying for {job.title} at {job.company}. "
                "Would you be open to connecting and sharing one brief perspective?"
            )
        body = body[:300]
        subject = None
    else:
        direct_context = {
            "likely_recruiter": (
                "I want to make the application easy for the recruiting team "
                "to review."
            ),
            "potential_hiring_manager": (
                "I’m trying to understand how the advertised work connects to "
                "the function’s current engineering priorities."
            ),
            "potential_referrer": (
                "I’m looking for candid context before making any request beyond "
                "learning about the opportunity."
            ),
        }[candidate.candidate_category]
        body = f"{core}\n\n{direct_context}\n\n{close}\n{name}"
        subject = None
    # Channel handoff evidence. The client opens LinkedIn or an email composer
    # only from these values — it never derives a profile URL from a name or a
    # company domain, because a guessed URL points at a real stranger.
    linkedin_url = safe_profile_url(person.linkedin_url)
    verified_email = (
        decrypt_email(person.professional_email_ciphertext)
        if person.email_verification_status == "verified"
        else None
    )
    generation_path = "deterministic_template"
    response = {
        "message_type": request.message_type,
        "subject": subject,
        "body": body,
        "draft": body,
        "facts_used": facts_used,
        "assumptions": [],
        "omitted_uncertain_facts": omitted,
        "character_count": len(body),
        "requires_manual_review": True,
        "requires_user_review": True,
        "sent": False,
        # Every draft is built from verified fields by a deterministic template,
        # so there is no model call to fail and nothing to fall back from.
        "generation_path": generation_path,
        "template_version": OUTREACH_TEMPLATE_VERSION,
        "recipient_name": _display_name(person.canonical_full_name),
        "recipient_category": candidate.candidate_category,
        "linkedin_url": linkedin_url,
        "linkedin_available": linkedin_url is not None,
        "professional_email": verified_email,
        "email_available": verified_email is not None,
    }
    metric(
        "people_outreach_draft_success_total",
        channel=request.message_type,
        generation_path=generation_path,
        category=candidate.candidate_category,
    )
    logger.info(
        "people_outreach_draft job_id=%s recommendation_id=%s user_ref=%s "
        "channel=%s category=%s generation_path=%s template=%s cache=miss "
        "grounding=passed linkedin_available=%s email_available=%s "
        "character_count=%s duration_ms=%.1f",
        job_id,
        recommendation.id,
        _safe_user_reference(user.id),
        request.message_type,
        candidate.candidate_category,
        generation_path,
        OUTREACH_TEMPLATE_VERSION,
        linkedin_url is not None,
        verified_email is not None,
        len(body),
        (time.monotonic() - started) * 1000,
    )
    record_audit(db, user.id, "people_outreach_draft_generated", {
        "job_id": job_id, "recommendation_id": recommendation.id,
        "draft_type": request.draft_type, "message_type": request.message_type,
        "automatically_sent": False, "category": candidate.candidate_category,
    })
    db.commit()
    return response


def set_saved(db: Session, user: User, job_id: int, recommendation_id: int, saved: bool) -> dict:
    recommendation, _, _ = owned_recommendation(db, user, job_id, recommendation_id)
    recommendation.saved_at = _now() if saved else None
    db.commit()
    return {"saved": saved}


def mark_contacted(db: Session, user: User, job_id: int, recommendation_id: int) -> dict:
    recommendation, _, _ = owned_recommendation(db, user, job_id, recommendation_id)
    recommendation.contacted_at = _now()
    db.commit()
    return {"contacted": True}


def submit_feedback(
    db: Session, user: User, job_id: int, recommendation_id: int, request: FeedbackRequest
) -> dict:
    recommendation, candidate, person = owned_recommendation(
        db, user, job_id, recommendation_id
    )
    feedback = PeopleRecommendationFeedback(
        user_id=user.id, recommendation_id=recommendation.id,
        relevance_rating=request.relevance_rating,
        employment_current_rating=request.employment_current_rating,
        information_correct_rating=request.information_correct_rating,
        contacted=request.contacted, received_response=request.received_response,
        incorrect_reason=(
            "employment_revalidation_requested"
            if request.employment_current_rating == "stale"
            else "information_reported_incorrect"
            if request.information_correct_rating == "incorrect"
            else None
        ),
    )
    db.add(feedback)
    metric(
        "people_recommendation_feedback_total",
        category="all",
        scoring_version=SCORING_VERSION,
    )
    employment_reported_incorrect = (
        request.employment_current_rating == "stale"
        or request.information_correct_rating == "incorrect"
    )
    if request.information_correct_rating == "incorrect":
        recommendation.suppressed_at = _now()
        metric(
            "people_recommendation_reported_incorrect_total",
            scoring_version=SCORING_VERSION,
        )
    if employment_reported_incorrect:
        recommendation.suppressed_at = _now()
        person.employment_revalidation_required = True
        person.employment_conflict_detected_at = _now()
        candidate.employment_validation_status = "conflicting_current_employment"
        candidate.employment_validation_checked_at = _now()
    record_audit(db, user.id, "people_recommendation_feedback", {
        "job_id": job_id, "recommendation_id": recommendation.id,
        "reported_incorrect": request.information_correct_rating == "incorrect",
    })
    db.commit()
    return {"accepted": True, "suppressed": recommendation.suppressed_at is not None}
