"""Dashboard summary aggregation.

The Dashboard is a *summary* screen: four counts, a three-row recent list, and
one suggested next action. Before this module it was assembled client-side from
``GET /jobs``, ``GET /jobs/tracker/all`` and ``GET /profile`` — which meant
hydrating every active posting (raw_json and all) and every JobMatch row for the
user just to display a single integer. This module answers the same questions
without loading any collection the screen does not render:

* application counts come from a ``GROUP BY`` — the database counts, not Python;
* the recent list is ``LIMIT 3`` with the job joined in one query;
* the fresh-match count reads only the columns the eligibility gate consults,
  for only the postings that are actually fresh, and is cached (see
  :mod:`app.dashboard.summary_cache`).

Nothing here writes, re-ranks, or re-scores. Navigating to the Dashboard must
never regenerate matches; it reports what discovery and scoring already decided.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.applications.canonical import normalize_company_key
from app.applications.mark_applied import DISCOVERY_HIDDEN_STATUSES
from app.dashboard.summary_cache import (
    cache_key,
    read_fresh_matches,
    write_fresh_matches,
)
from app.jobs.company_logo_service import (
    is_safe_logo_url,
    is_untrusted_simplify_logo_url,
    resolve_company_logo,
)
from app.jobs.job_eligibility_service import evaluate_eligibility
from app.jobs.job_matching_service import JobView
from app.jobs.job_normalization_service import DEMO_COMPANIES, is_placeholder_url
from app.jobs.scoring_service import build_profile_view
from app.models.entities import (
    ApplicationSession,
    ApplicationSessionStatus,
    ApplicationStatus,
    ApplicationTracker,
    JobMatch,
    JobPosting,
    JobSource,
    UserProfile,
)
from app.profile.completeness import build_profile_signals, profile_completion

#: Rows rendered by the "Recently updated" card. The Dashboard shows three; the
#: query asks for exactly that many rather than paging the whole ledger.
RECENT_APPLICATION_LIMIT = 3

#: Freshness window for the match count, matching the Jobs screen's default.
FRESH_WINDOW_DAYS = 7

#: Roles shown by the "Best matches this week" card.
TOP_MATCH_LIMIT = 3

#: What counts as a "strong" fit. Applied to stored JobMatch scores only — the
#: Dashboard never computes a score to answer this.
STRONG_FIT_THRESHOLD = 80

#: How far ahead an interview-stage follow-up date is treated as "coming up".
INTERVIEW_HORIZON_DAYS = 7

#: Assisted-apply sessions that are waiting on the user. These are the states
#: the flow stops in when it cannot proceed without an answer — nothing here
#: infers "needs attention" from age or absence.
SESSIONS_NEEDING_USER: tuple[ApplicationSessionStatus, ...] = (
    ApplicationSessionStatus.review_required,
    ApplicationSessionStatus.ready_for_review,
)

#: How the lifecycle vocabulary rolls up into the four headline numbers. Every
#: member of ApplicationStatus is accounted for: ``rejected`` and ``withdrawn``
#: are closed outcomes and belong to no active bucket.
STATUS_BUCKETS: dict[str, tuple[ApplicationStatus, ...]] = {
    "saved": (ApplicationStatus.saved, ApplicationStatus.ready_to_apply),
    "inProgress": (ApplicationStatus.applying, ApplicationStatus.applied),
    "interviews": (ApplicationStatus.interview,),
    "offers": (ApplicationStatus.offer,),
}


def build_dashboard_summary(db: Session, user_id: int) -> dict:
    """The whole Dashboard payload for ``user_id``.

    Every query in here is scoped to ``user_id``; no argument can widen that.
    """
    profile = _profile_row(db, user_id)
    counts, ledger_fingerprint = _application_counts(db, user_id)
    fingerprint = _fingerprint(profile, ledger_fingerprint)
    discovery = _fresh_discovery(db, user_id, fingerprint)
    return {
        "freshMatches": discovery["count"],
        "applications": counts,
        "recentApplications": _recent_applications(db, user_id),
        "topMatches": _top_matches(db, user_id, discovery["topJobIds"]),
        "strongMatches": discovery["strongCount"],
        "nextAction": _next_action(
            db, user_id, profile, counts, discovery["strongCount"]
        ),
    }


def _profile_row(db: Session, user_id: int):
    """The only profile read the Dashboard performs.

    Just the columns two things need: the next-action hint, and the cache
    fingerprint. The screen never had a use for the rest of the profile.
    """
    return db.execute(
        select(
            UserProfile.first_name,
            UserProfile.full_name,
            UserProfile.preferred_first_name,
            UserProfile.application_email,
            UserProfile.target_roles,
            UserProfile.target_levels,
            UserProfile.preferred_locations,
            UserProfile.remote_preference,
            UserProfile.requires_sponsorship,
            UserProfile.open_to_relocation,
            UserProfile.location_country,
            UserProfile.skills,
        ).where(UserProfile.user_id == user_id)
    ).first()


def _fingerprint(profile, ledger_fingerprint: str) -> str:
    """Cache identity for the fresh-match count.

    Built from the *values* the eligibility gate reads rather than from the
    profile's ``updated_at``: a timestamp only invalidates reliably if the
    database's clock resolution happens to exceed the edit interval, whereas
    hashing the inputs is exact. Career rows (experience, education) also feed
    the gate indirectly and are covered by the TTL instead of the fingerprint.
    """
    gate_inputs = (
        None
        if profile is None
        else [
            profile.target_roles,
            profile.target_levels,
            profile.preferred_locations,
            profile.remote_preference,
            profile.requires_sponsorship,
            profile.open_to_relocation,
            profile.location_country,
        ]
    )
    payload = json.dumps([gate_inputs, ledger_fingerprint], sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


# --------------------------------------------------------------------------- #
# Application counts
# --------------------------------------------------------------------------- #
def _application_counts(db: Session, user_id: int) -> tuple[dict[str, int], str]:
    """Bucketed counts plus a fingerprint of the ledger they came from.

    One ``GROUP BY`` over an index-covered predicate replaces fetching the
    user's whole application history and calling ``len()`` on filtered lists.
    The fingerprint rides along because it is derived from the same scan.
    """
    rows = db.execute(
        select(
            ApplicationTracker.status,
            func.count(ApplicationTracker.id),
            func.max(ApplicationTracker.updated_at),
        )
        .where(ApplicationTracker.user_id == user_id)
        .group_by(ApplicationTracker.status)
    ).all()

    by_status = {status: count for status, count, _ in rows}
    counts = {
        bucket: sum(by_status.get(status, 0) for status in statuses)
        for bucket, statuses in STATUS_BUCKETS.items()
    }

    total = sum(by_status.values())
    latest = max((updated for _, _, updated in rows if updated is not None), default=None)
    fingerprint = f"{total}:{latest.isoformat() if latest else 'none'}"
    return counts, fingerprint


# --------------------------------------------------------------------------- #
# Recent applications
# --------------------------------------------------------------------------- #
def _recent_applications(db: Session, user_id: int) -> list[dict]:
    """The most recently touched applications, newest first.

    ``LIMIT`` is applied by the database. The join pulls each posting in the
    same round trip, so rendering three rows costs one query rather than one
    per row.
    """
    rows = db.execute(
        select(
            ApplicationTracker.id,
            ApplicationTracker.status,
            ApplicationTracker.updated_at,
            JobPosting.title,
            JobPosting.company,
            JobPosting.company_logo_url,
            JobPosting.application_url,
            JobSource.type,
        )
        .join(JobPosting, JobPosting.id == ApplicationTracker.job_id)
        .outerjoin(JobSource, JobSource.id == JobPosting.source_id)
        .where(ApplicationTracker.user_id == user_id)
        .order_by(ApplicationTracker.updated_at.desc(), ApplicationTracker.id.desc())
        .limit(RECENT_APPLICATION_LIMIT)
    ).all()

    return [
        {
            "id": str(row.id),
            "title": row.title,
            "company": row.company,
            "status": row.status.value,
            "updatedAt": row.updated_at,
            "logoUrl": _logo_url(row),
        }
        for row in rows
    ]


def _logo_url(row) -> str | None:
    """The same logo the Jobs and Tracker cards use, resolved in-process.

    ``resolve_company_logo`` is pure lookup and string work — it performs no
    network I/O — so this cannot make the summary wait on a third party.
    """
    stored = row.company_logo_url
    if is_untrusted_simplify_logo_url(stored) or not is_safe_logo_url(stored):
        stored = ""
    if not stored:
        stored = resolve_company_logo(
            row.company or "",
            source_type=row.type,
            application_url=row.application_url,
        )["company_logo_url"]
    if not stored:
        return None
    # Prefer our own proxy for the same reasons the job cards do: it is cached,
    # SSRF-checked, and survives the upstream URL expiring.
    return f"/jobs/companies/{normalize_company_key(row.company or '')}/logo"


# --------------------------------------------------------------------------- #
# Fresh matches
# --------------------------------------------------------------------------- #
def _fresh_discovery(db: Session, user_id: int, fingerprint: str) -> dict:
    """How many fresh, eligible, untracked postings this user has — and the best
    few of them.

    This is the number the old Dashboard paid ~7.7s for by downloading every
    posting. Both answers come out of one gate evaluation and are cached
    together under a key that already encodes the user's profile and application
    ledger, so the only thing the TTL hides is a background ingestion batch.
    """
    key = cache_key(user_id=user_id, fingerprint=fingerprint)

    cached = read_fresh_matches(key)
    if cached is not None:
        return cached

    discovery = _compute_fresh_discovery(db, user_id)
    write_fresh_matches(key, discovery)
    return discovery


def _compute_fresh_discovery(db: Session, user_id: int) -> dict:
    """Evaluate the discovery gate over fresh postings only.

    Two passes, because one input is expensive and rarely decisive.
    ``description_clean`` is consulted by exactly one rule — the
    "requires N+ years" check inside the seniority gate — but it is by far the
    largest column involved. Eligibility is a conjunction, so deferring that one
    rule and applying it to the rows that passed everything else yields the
    identical set while transferring the text for hundreds of rows instead of
    thousands.
    """
    built = build_profile_view(db, user_id)
    profile_view = built[0] if built else None

    cutoff = datetime.now(UTC) - timedelta(days=FRESH_WINDOW_DAYS)
    tracked = select(ApplicationTracker.job_id).where(
        (ApplicationTracker.user_id == user_id)
        & (ApplicationTracker.status.in_(tuple(DISCOVERY_HIDDEN_STATUSES)))
    )
    demo_source_ids = set(
        db.scalars(select(JobSource.id).where(func.lower(JobSource.type) == "demo")).all()
    )

    # Freshness, activity and the user's own exclusions are all predicates the
    # database can apply. Postings with no posted_at are excluded here for the
    # same reason the Jobs list excludes them by default.
    rows = db.execute(
        select(
            JobPosting.id,
            JobPosting.title,
            JobPosting.company,
            JobPosting.location,
            JobPosting.remote_type,
            JobPosting.seniority_level,
            JobPosting.work_authorization_notes,
            JobPosting.application_url,
            JobPosting.source_url,
            JobPosting.source_id,
        ).where(
            JobPosting.is_active.is_(True),
            JobPosting.posted_at.is_not(None),
            JobPosting.posted_at >= cutoff,
            JobPosting.id.not_in(tracked),
        )
    ).all()

    survivors = []
    for row in rows:
        if (row.company or "").strip().lower() in DEMO_COMPANIES:
            continue
        if row.source_id is not None and row.source_id in demo_source_ids:
            continue
        if is_placeholder_url(row.application_url) or is_placeholder_url(row.source_url):
            continue
        if profile_view is None:
            # No profile to gate against: the Jobs list counts these as fresh.
            survivors.append(row)
            continue
        if evaluate_eligibility(profile_view, _job_view(row, description="")).eligible:
            survivors.append(row)

    if profile_view is not None and survivors:
        descriptions = dict(
            db.execute(
                select(JobPosting.id, JobPosting.description_clean).where(
                    JobPosting.id.in_([row.id for row in survivors])
                )
            ).all()
        )
        survivors = [
            row
            for row in survivors
            if evaluate_eligibility(
                profile_view, _job_view(row, description=descriptions.get(row.id) or "")
            ).eligible
        ]

    eligible_ids = [row.id for row in survivors]
    return {
        "count": len(survivors),
        "topJobIds": _rank_top_job_ids(db, user_id, eligible_ids),
        "strongCount": _strong_match_count(db, user_id, eligible_ids),
    }


def _rank_top_job_ids(db: Session, user_id: int, eligible_ids: list[int]) -> list[int]:
    """The best-scoring eligible postings, read from stored JobMatch rows.

    Scores are whatever discovery and the scoring worker already wrote. The
    Dashboard ranks, it never scores: nothing here triggers a match refresh, so
    navigating to this page cannot kick off scoring work.
    """
    if not eligible_ids:
        return []
    rows = db.execute(
        select(JobMatch.job_id)
        .where(
            JobMatch.user_id == user_id,
            JobMatch.job_id.in_(eligible_ids),
            JobMatch.fit_score.is_not(None),
        )
        .order_by(JobMatch.fit_score.desc(), JobMatch.job_id.desc())
        .limit(TOP_MATCH_LIMIT)
    ).all()
    return [row.job_id for row in rows]


def _strong_match_count(db: Session, user_id: int, eligible_ids: list[int]) -> int:
    """How many eligible postings already scored at or above the strong-fit bar.

    A ``COUNT`` over stored ``JobMatch.fit_score`` — the same rows the ranking
    query reads, so this is a persisted fact rather than a fresh computation.
    It rides along inside the cached discovery result, which means the warm
    Dashboard pays nothing for it.
    """
    if not eligible_ids:
        return 0
    return (
        db.scalar(
            select(func.count())
            .select_from(JobMatch)
            .where(
                JobMatch.user_id == user_id,
                JobMatch.job_id.in_(eligible_ids),
                JobMatch.fit_score >= STRONG_FIT_THRESHOLD,
            )
        )
        or 0
    )


def _top_matches(db: Session, user_id: int, job_ids: list[int]) -> list[dict]:
    """Display rows for the "Best matches this week" card.

    At most :data:`TOP_MATCH_LIMIT` postings, fetched by primary key — the card
    renders three roles, so three rows are read. ``description_clean`` and the
    rest of the posting are left in the database.
    """
    if not job_ids:
        return []
    rows = db.execute(
        select(
            JobPosting.id,
            JobPosting.title,
            JobPosting.company,
            JobPosting.location_display,
            JobPosting.location,
            JobMatch.fit_score,
        )
        .join(
            JobMatch,
            (JobMatch.job_id == JobPosting.id) & (JobMatch.user_id == user_id),
        )
        .where(JobPosting.id.in_(job_ids))
    ).all()

    by_id = {row.id: row for row in rows}
    # Preserve the ranking the scores produced; the IN clause does not.
    return [
        {
            "id": by_id[job_id].id,
            "title": by_id[job_id].title,
            "company": by_id[job_id].company,
            "location": by_id[job_id].location_display or by_id[job_id].location,
            "fitScore": by_id[job_id].fit_score,
        }
        for job_id in job_ids
        if job_id in by_id
    ]


def _job_view(row, *, description: str) -> JobView:
    """The eligibility gate's view of a posting.

    Skills are intentionally empty: the gate reads title, description, location,
    workplace type, seniority and work-authorization notes, and never the skill
    lists, so fetching them would be pure transfer cost.
    """
    return JobView(
        title=row.title or "",
        description=description,
        required_skills=[],
        preferred_skills=[],
        location=row.location,
        workplace_type=(row.remote_type or "unknown"),
        seniority=row.seniority_level,
        work_authorization_notes=row.work_authorization_notes,
    )


# --------------------------------------------------------------------------- #
# Next action
# --------------------------------------------------------------------------- #
def _sessions_needing_user(db: Session, user_id: int) -> int:
    """Assisted-apply runs that stopped and are waiting on the user.

    One indexed count over the user's own sessions. This is a *recorded* state,
    not a guess: the flow writes these statuses when it cannot continue without
    an answer.
    """
    return (
        db.scalar(
            select(func.count())
            .select_from(ApplicationSession)
            .where(
                ApplicationSession.user_id == user_id,
                ApplicationSession.status.in_(SESSIONS_NEEDING_USER),
            )
        )
        or 0
    )


def _upcoming_interview_date(db: Session, user_id: int):
    """The nearest follow-up date on an interview-stage application, if any.

    Only a date the user actually recorded is considered. Nothing is inferred
    from the status alone — an application sitting at ``interview`` with no date
    produces no claim about an upcoming event.
    """
    today = datetime.now(UTC).date()
    return db.scalar(
        select(func.min(ApplicationTracker.follow_up_date)).where(
            ApplicationTracker.user_id == user_id,
            ApplicationTracker.status == ApplicationStatus.interview,
            ApplicationTracker.follow_up_date.is_not(None),
            ApplicationTracker.follow_up_date >= today,
            ApplicationTracker.follow_up_date <= today + timedelta(days=INTERVIEW_HORIZON_DAYS),
        )
    )


def _next_action(
    db: Session,
    user_id: int,
    profile,
    counts: dict[str, int],
    strong_matches: int,
) -> dict:
    """The single most useful next step, decided server-side.

    Priority order, highest first. Every branch is driven by state the product
    already records — no branch invents a count, and none of them performs work
    beyond two indexed per-user reads:

    0. The profile is too thin to match well. It gates everything below it:
       suggesting matches from a half-built profile wastes the user's time.
    1. An assisted-apply session is paused waiting for an answer.
    2. An interview-stage application has a follow-up date within the horizon.
    3. Enough already-scored postings clear the strong-fit bar.
    4. Saved roles are waiting to be moved forward.
    5. Nothing pending — go and discover.

    The percentage comes from :mod:`app.profile.completeness`, the same helper
    the Profile overview reports, so the two screens can never quote different
    numbers for the same profile.
    """
    first_name = ""
    if profile is not None:
        first_name = (profile.preferred_first_name or profile.first_name or "").strip()
    progress = profile_completion(build_profile_signals(db, user_id))["percent"]

    needs_attention = _sessions_needing_user(db, user_id)
    interview_on = _upcoming_interview_date(db, user_id) if counts["interviews"] else None

    if progress < 80:
        action = {
            "kind": "complete_profile",
            "eyebrow": f"{progress}% profile complete",
            "title": "Finish your profile",
            "body": "A complete profile improves matching and application accuracy.",
            "href": "/profile",
            "cta": "Continue profile",
        }
    elif needs_attention:
        action = {
            "kind": "needs_attention",
            # Noun and verb have to agree: "1 application needs" / "3 applications need".
            "eyebrow": (
                f"{needs_attention} application{'' if needs_attention == 1 else 's'} "
                f"{'needs' if needs_attention == 1 else 'need'} attention"
            ),
            "title": "Complete unanswered application questions",
            "body": "An assisted application is paused until you answer a few questions.",
            "href": "/tracker",
            "cta": "Finish applications",
        }
    elif interview_on is not None:
        action = {
            "kind": "interview_upcoming",
            "eyebrow": "Interview coming up",
            "title": "Prepare for your interview",
            "body": "Review the role and your application before the date you set.",
            "href": "/tracker",
            "cta": "Open tracker",
            # The recorded date, so the client never has to guess or re-derive.
            "dueOn": interview_on,
        }
    elif strong_matches > 0:
        action = {
            "kind": "strong_matches",
            "eyebrow": f"{strong_matches} strong match{'' if strong_matches == 1 else 'es'}",
            "title": "Review your highest-fit opportunities",
            "body": (
                f"{strong_matches} fresh match{'' if strong_matches == 1 else 'es'} "
                f"scored {STRONG_FIT_THRESHOLD}%+ fit."
            ),
            "href": "/jobs",
            "cta": "View matches",
        }
    elif counts["saved"] > 0:
        action = {
            "kind": "advance_saved",
            "eyebrow": f"{counts['saved']} saved",
            "title": "Move a saved role forward",
            "body": "Review your strongest saved role and prepare its application.",
            "href": "/tracker",
            "cta": "Review saved roles",
        }
    else:
        action = {
            "kind": "discover",
            "eyebrow": "Nothing pending",
            "title": "Discover new opportunities",
            "body": "Run a search to bring in fresh roles that match your profile.",
            "href": "/jobs",
            "cta": "Find jobs",
        }
    action["firstName"] = first_name
    action["profileProgress"] = progress
    return action
