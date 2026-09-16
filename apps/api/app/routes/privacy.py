from fastapi import APIRouter, Depends, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.audit import record_audit
from app.db.session import get_db
from app.documents.store import serialize_document
from app.models.entities import (
    ApplicationTracker,
    Award,
    Certification,
    Education,
    Experience,
    GeneratedDocument,
    JobMatch,
    PeopleDiscoveryRun,
    PeopleRecommendationFeedback,
    Project,
    SensitiveDemographics,
    User,
    UserJobPeopleRecommendation,
    UserProfile,
)
from app.services.documents import public_dict

router = APIRouter(prefix="/privacy", tags=["privacy"])

EXPORT_EXCLUDED_COLUMNS = frozenset({"workday_password_ciphertext"})


def _export_dict(row: object) -> dict:
    return {
        key: value
        for key, value in public_dict(row).items()
        if key not in EXPORT_EXCLUDED_COLUMNS
    }


def _rows(db: Session, model: type, user_id: int) -> list[dict]:
    return [
        _export_dict(row)
        for row in db.scalars(select(model).where(model.user_id == user_id))
    ]


@router.get("/export")
def export_user_data(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    demographics = db.scalar(
        select(SensitiveDemographics).where(SensitiveDemographics.user_id == user.id)
    )
    data = {
        "user": {"id": user.id, "email": user.email, "created_at": user.created_at},
        "profile": _export_dict(profile) if profile is not None else None,
        "career": {
            "education": _rows(db, Education, user.id),
            "experience": _rows(db, Experience, user.id),
            "projects": _rows(db, Project, user.id),
            "certifications": _rows(db, Certification, user.id),
            "awards": _rows(db, Award, user.id),
        },
        "sensitive_demographics": (
            _export_dict(demographics) if demographics is not None else None
        ),
        "matches": _rows(db, JobMatch, user.id),
        "documents": [
            serialize_document(record)
            for record in db.scalars(
                select(GeneratedDocument).where(GeneratedDocument.user_id == user.id)
            )
        ],
        "applications": _rows(db, ApplicationTracker, user.id),
        "people_recommendations": _rows(db, UserJobPeopleRecommendation, user.id),
        "people_discovery_runs": _rows(db, PeopleDiscoveryRun, user.id),
        "people_feedback": _rows(db, PeopleRecommendationFeedback, user.id),
    }
    record_audit(db, user.id, "data_exported")
    db.commit()
    return data


@router.delete("/account", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    record_audit(db, user.id, "account_deleted")
    db.flush()
    db.execute(delete(User).where(User.id == user.id))
    db.commit()
