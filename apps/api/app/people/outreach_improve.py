"""The explicit "Improve with AI" action.

Everything here is arranged so a model failure is boring. The deterministic
draft is built **first**, and it is what the caller gets back unless a model
answer survives :func:`validate_outreach` intact. There is no path that returns
empty content, and no path that lets a model result through unchecked.

Why this is a separate endpoint rather than a flag on the existing one: the
person card prefetches drafts on hover and focus. Putting model generation
behind the existing draft call would bill an OpenAI request every time a user
pointed at a LinkedIn link. Generation must cost a deliberate click, so it gets
its own route and the old one is left exactly as it was.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.ai.provider import AIProvider
from app.core.config import running_under_test, settings
from app.models.entities import User, UserProfile
from app.people.observability import metric
from app.people.outreach_ai import (
    OUTREACH_PROMPT_NAME,
    OUTREACH_PROMPT_VERSION,
    OutreachContext,
    OutreachFact,
    build_model_payload,
    validate_outreach,
)
from app.people.schemas import OutreachDraftRequest

__all__ = ["GENERATION_PATHS", "improve_outreach_draft"]

GENERATION_PATHS = (
    "deterministic_template",
    "openai_validated",
    "deterministic_fallback",
)

# Cached refinements are cheap to keep and expensive to regenerate.
_CACHE_TTL_SECONDS = 24 * 3600
# How long a concurrent caller waits for the in-flight request to finish before
# giving up and returning the deterministic draft. Bounded so a stuck model
# cannot pile up requests behind it.
_COALESCE_WAIT_SECONDS = 25.0
_CACHE_PREFIX = f"people:outreach-ai:{OUTREACH_PROMPT_VERSION}"


def _fingerprint(*parts: object) -> str:
    joined = "\x1f".join(str(part or "") for part in parts)
    return hashlib.sha256(joined.encode()).hexdigest()[:32]


def _model_configuration_version() -> str:
    """Model identity is part of the cache key: a model swap changes the copy."""

    return f"{settings.openai_model_fast}:{settings.openai_model_smart}"


def _profile_fingerprint(profile: UserProfile | None) -> str:
    """Changes when the facts the model was given change."""

    if profile is None:
        return "none"
    return _fingerprint(
        profile.full_name,
        tuple(profile.skills or ()),
    )


def _cache_key(
    *,
    user_id: int,
    job_id: int,
    recommendation_id: int,
    deterministic: dict[str, Any],
    profile_fingerprint: str,
) -> str:
    """User-scoped, and invalidated by anything that changes the output.

    The deterministic draft's own fingerprint is included, so an edit to the
    template — or a change in the facts feeding it — retires the refinement
    built from the older text instead of serving a refinement of something the
    user is no longer looking at.
    """

    return ":".join(
        (
            _CACHE_PREFIX,
            str(user_id),
            str(job_id),
            str(recommendation_id),
            _fingerprint(
                deterministic.get("subject"),
                deterministic.get("body"),
                deterministic.get("linkedin_body"),
            ),
            profile_fingerprint,
            _model_configuration_version(),
        )
    )


def _redis():
    """A Redis client, or ``None``. The cache is an optimisation, never a
    dependency — losing Redis costs a duplicate model call, not the feature."""

    if running_under_test():
        return None
    try:
        import redis

        return redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=0.5, socket_timeout=0.5
        )
    except Exception:  # noqa: BLE001
        return None


def _build_context(
    *,
    candidate: Any,
    person: Any,
    job: Any,
    profile: UserProfile | None,
    recommendation: Any,
) -> OutreachContext:
    """Assemble the model's entire world from trusted server-side records.

    Nothing here comes from the browser. The request carries identifiers only,
    so a caller cannot supply a name, a company, a title, a relationship or a
    fact id and have it treated as verified.
    """

    from app.people.service import _display_name, _first_name, outreach_job_title

    skills = [
        str(value).strip()
        for value in (profile.skills if profile else [])
        if str(value).strip()
    ][:2]
    priorities = [
        str(value).strip()
        for value in (job.required_skills or [])
        if str(value).strip()
    ][:2]

    category = candidate.candidate_category
    # Relationship evidence comes from the stored recommendation's own verified
    # columns — the same ones the deterministic template uses — and nowhere
    # else. An earlier version read a "shared_background" key that the draft
    # payload never contained, so signals were silently always empty and a warm
    # connection could never be produced. Reading the real fields is also what
    # keeps this layer from *discovering* a relationship: it can only repeat one
    # already established upstream.
    signals: list[OutreachFact] = []
    shared_school = (getattr(recommendation, "shared_school", None) or "").strip()
    shared_employer = (getattr(recommendation, "shared_employer", None) or "").strip()
    if shared_school:
        signals.append(
            OutreachFact("rel:school", f"Also attended {shared_school}")
        )
    if shared_employer:
        signals.append(
            OutreachFact("rel:employer", f"Previously worked at {shared_employer}")
        )
    if signals:
        category = "warm_connection"

    return OutreachContext(
        recipient_first_name=_first_name(person.canonical_full_name) or "",
        recipient_full_name=_display_name(person.canonical_full_name),
        category=category,
        company=job.company,
        short_job_title=outreach_job_title(job.title),
        # Application status is not plumbed into this path yet, so the truthful
        # neutral form is used rather than an inferred one. See the report.
        application_status="not_submitted",
        candidate_display_name=_display_name((profile.full_name if profile else "") or ""),
        candidate_first_name=_first_name((profile.full_name if profile else "") or "") or "",
        recipient_title=person.current_title,
        normalized_function=job.role_family if hasattr(job, "role_family") else None,
        qualifications=[
            OutreachFact(f"qual:{index}", value) for index, value in enumerate(skills)
        ],
        job_priorities=[
            OutreachFact(f"job:{index}", value)
            for index, value in enumerate(priorities)
        ],
        relationship_signals=signals,
    )


def _fallback(
    deterministic: dict[str, Any], reason: str, category: str
) -> dict[str, Any]:
    """The deterministic draft, unchanged, plus why the model did not replace it."""

    result = dict(deterministic)
    result["generation_path"] = "deterministic_fallback"
    result["ai_fallback_reason"] = reason
    result["prompt_version"] = OUTREACH_PROMPT_VERSION
    metric("people_outreach_ai_fallback_total", reason=reason, category=category)
    metric(
        "people_outreach_ai_generation_path_total",
        generation_path="deterministic_fallback",
        category=category,
    )
    return result


async def improve_outreach_draft(
    db: Session,
    user: User,
    job_id: int,
    recommendation_id: int,
    request: OutreachDraftRequest,
) -> dict[str, Any]:
    """Refine an existing deterministic draft, or return it untouched."""

    from app.people.service import (
        _job_or_404,
        outreach_draft,
        owned_recommendation,
        rate_limit,
    )

    if not settings.people_outreach_ai_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "PEOPLE_OUTREACH_AI_DISABLED",
                "message": "AI improvement is not enabled.",
            },
        )

    # Ownership first: the deterministic build is not free, and an unauthorised
    # caller should never reach it.
    job = _job_or_404(db, job_id)
    recommendation, candidate, person = owned_recommendation(
        db, user, job_id, recommendation_id
    )
    category = candidate.candidate_category

    # The deterministic draft is built before anything else, so every exit path
    # below already has something correct to return.
    deterministic = outreach_draft(db, user, job_id, recommendation_id, request)
    deterministic.setdefault("prompt_version", OUTREACH_PROMPT_VERSION)

    from sqlalchemy import select as _select

    profile_obj = db.scalar(
        _select(UserProfile).where(UserProfile.user_id == user.id)
    )

    key = _cache_key(
        user_id=user.id,
        job_id=job_id,
        recommendation_id=recommendation_id,
        deterministic=deterministic,
        profile_fingerprint=_profile_fingerprint(profile_obj),
    )
    client = _redis()

    if client is not None:
        cached = client.get(key)
        if cached:
            metric("people_outreach_ai_cache_hit_total", category=category)
            import json

            try:
                stored = json.loads(cached)
            except ValueError:
                stored = None
            if isinstance(stored, dict):
                merged = dict(deterministic)
                merged.update(stored)
                metric(
                    "people_outreach_ai_generation_path_total",
                    generation_path=merged.get("generation_path", "openai_validated"),
                    category=category,
                )
                return merged

        # One in-flight request per key. A second click waits for the first
        # rather than buying a second completion.
        lock_key = f"{key}:lock"
        if not client.set(lock_key, "1", nx=True, ex=int(_COALESCE_WAIT_SECONDS) + 5):
            metric("people_outreach_ai_coalesced_total", category=category)
            deadline = time.monotonic() + _COALESCE_WAIT_SECONDS
            while time.monotonic() < deadline:
                await asyncio.sleep(0.25)
                cached = client.get(key)
                if cached:
                    import json

                    try:
                        stored = json.loads(cached)
                    except ValueError:
                        break
                    merged = dict(deterministic)
                    merged.update(stored)
                    return merged
            return _fallback(deterministic, "coalesced_timeout", category)

    # Budgets. Both are counted per calendar day and refuse rather than queue.
    rate_limit(
        f"outreach-ai:user:{user.id}",
        settings.people_outreach_ai_per_user_daily_limit,
        window_seconds=86_400,
    )
    rate_limit(
        "outreach-ai:global",
        settings.people_outreach_ai_daily_budget,
        window_seconds=86_400,
    )

    context = _build_context(
        candidate=candidate,
        person=person,
        job=job,
        profile=profile_obj,
        recommendation=recommendation,
    )
    metric("people_outreach_ai_requested_total", category=category)

    started = time.monotonic()
    try:
        result = await asyncio.wait_for(
            AIProvider().json_task(
                OUTREACH_PROMPT_NAME, build_model_payload(context), smart=False
            ),
            timeout=settings.people_outreach_ai_timeout_seconds,
        )
    except TimeoutError:
        return _fallback(deterministic, "timeout", category)
    except Exception:  # noqa: BLE001 - a refinement must never break the draft
        return _fallback(deterministic, "provider_error", category)
    finally:
        metric(
            "people_outreach_ai_generation_duration",
            int((time.monotonic() - started) * 1000),
            category=category,
        )
        if client is not None:
            client.delete(f"{key}:lock")

    if not getattr(result, "ai_used", False):
        # AIProvider fell back to its own local stub; that is not a refinement.
        return _fallback(deterministic, "provider_unavailable", category)

    outcome = validate_outreach(result.data, context)
    metric(
        "people_outreach_ai_validation_total",
        outcome="accepted" if outcome.accepted else "rejected",
        reason=outcome.reason,
        category=category,
    )
    if not outcome.accepted:
        return _fallback(deterministic, outcome.reason, category)

    improved = dict(deterministic)
    improved.update(
        {
            "subject": outcome.email_subject,
            "body": outcome.email_body,
            "draft": outcome.email_body,
            "linkedin_body": outcome.linkedin_body,
            "facts_used": outcome.facts_used,
            "requires_manual_review": outcome.requires_manual_review,
            "generation_path": "openai_validated",
            "prompt_version": OUTREACH_PROMPT_VERSION,
            "character_count": len(outcome.email_body),
        }
    )
    metric("people_outreach_ai_completed_total", category=category)
    metric(
        "people_outreach_ai_generation_path_total",
        generation_path="openai_validated",
        category=category,
    )
    metric(
        "people_outreach_ai_output_length",
        len(outcome.email_body),
        channel="email",
        category=category,
    )

    if client is not None:
        import json

        client.setex(
            key,
            _CACHE_TTL_SECONDS,
            json.dumps(
                {
                    "subject": improved["subject"],
                    "body": improved["body"],
                    "draft": improved["draft"],
                    "linkedin_body": improved["linkedin_body"],
                    "facts_used": improved["facts_used"],
                    "generation_path": "openai_validated",
                    "prompt_version": OUTREACH_PROMPT_VERSION,
                }
            ),
        )
    return improved
