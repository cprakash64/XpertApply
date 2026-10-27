"""Authenticated, secret-free diagnostics endpoints."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.provider import ai_provider
from app.api.deps import get_current_user
from app.db.session import get_db
from app.jobs.scheduled_ingestion import recent_runs
from app.jobs.scoring_service import SCORE_VERSION
from app.models.entities import JobMatch, JobPosting, ScoreState, User

router = APIRouter(prefix="/debug", tags=["debug"])


@router.get("/openai-status")
def openai_status(user: User = Depends(get_current_user)) -> dict:
    """Report whether OpenAI is configured and which models are set.

    Never returns the API key itself — only whether one is present, the
    configured model names, and the last sanitized error (if any).
    """
    return ai_provider.status()


@router.get("/ingestion-runs")
def ingestion_runs(
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Recent ingestion-run history (Part 6). Secret-free, summarized tallies."""
    return {"runs": recent_runs(db, limit=limit)}


@router.get("/scoring-status")
def scoring_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Authenticated user diagnostics over at most100 actor-owned matches.

    No operator role exists. Global counters are not authorized by a user JWT.
    This security correction applies in both scoring modes.
    """
    rows = db.execute(
        select(JobMatch.score_state, JobMatch.updated_at, JobPosting.is_active)
        .join(JobPosting, JobPosting.id == JobMatch.job_id)
        .where(JobMatch.user_id == user.id)
        .order_by(JobMatch.id.desc()).limit(101)
    ).all()
    page = rows[:100]
    by_state = {s.value: 0 for s in ScoreState}
    for row in page:
        by_state[row.score_state] = by_state.get(row.score_state, 0) + 1
    pending = [r.updated_at for r in page if r.score_state in ("pending", "scoring")]
    return {
        "score_version": SCORE_VERSION,
        "by_state": by_state,
        "pending_backlog": len(pending),
        "oldest_pending_at": min(pending) if pending else None,
        "active_jobs": sum(bool(r.is_active) for r in page),
        "window_size": len(page),
        "has_more": len(rows) > 100,
    }
