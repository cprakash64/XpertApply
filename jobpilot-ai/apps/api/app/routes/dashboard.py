"""Dashboard summary endpoint.

One authenticated read that returns exactly what the Dashboard renders. It
replaces the three broad reads (``/jobs``, ``/jobs/tracker/all``, ``/profile``)
the screen used to fan out to, none of which were shaped for a summary.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.dashboard.summary_service import build_dashboard_summary
from app.db.session import get_db
from app.models.entities import User

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary")
def get_dashboard_summary(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Counts, the three most recent applications, and the suggested next step.

    The authenticated user is the only scope: the identity comes from the bearer
    token via ``get_current_user`` and there is no parameter that could point
    this at another user's data.
    """
    return build_dashboard_summary(db, user.id)
