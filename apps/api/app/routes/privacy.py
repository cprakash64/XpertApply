from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.audit import record_audit
from app.db.session import get_db
from app.documents.materialized_files import MaterializedFileError, remove_document_exports
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


#: Columns that must never leave the API inside a data export.
#:
#: ``public_dict`` already drops ``hashed_password``. It does not know about
#: ``workday_password_ciphertext`` — the encrypted third-party ATS credential on
#: ``UserProfile`` — and serializing the profile row would have placed that
#: ciphertext in the export body. It is a stored credential, not user content:
#: the account holder manages it through ``PUT``/``DELETE
#: /profile/workday-credentials``, and it has no place in a subject-access
#: download. Excluded here explicitly so the omission is visible and tested
#: rather than incidental.
EXPORT_EXCLUDED_COLUMNS = frozenset({"workday_password_ciphertext"})


def _export_dict(row: object) -> dict:
    return {
        key: value
        for key, value in public_dict(row).items()
        if key not in EXPORT_EXCLUDED_COLUMNS
    }


def _rows(db: Session, model: type, user_id: int) -> list[dict]:
    """Every row of ``model`` owned by ``user_id``, as JSON-safe dictionaries.

    Each category was previously handed back as raw SQLAlchemy rows under a
    declared ``dict`` contract, so pydantic could not encode the response and
    the endpoint answered 500 for every caller. ``public_dict`` is this
    repository's existing row-to-dictionary helper — the same one
    ``services.documents.profile_payload`` uses — and it drops
    ``hashed_password`` so a password hash cannot reach an export.
    """
    return [
        _export_dict(row)
        for row in db.scalars(select(model).where(model.user_id == user_id))
    ]


@router.get("/export")
def export_user_data(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """The user's own data, for GDPR/CCPA subject access.

    Scope is unchanged from the original implementation: the same categories,
    the same per-user filters, and ``user`` still built by hand so that only
    id/email/created_at are exposed rather than the whole row. Documents go
    through ``serialize_document``, which is what every document route returns
    and which omits internal storage paths.
    """
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
    # Keep the rows available until filesystem cleanup succeeds. If a later DB
    # commit fails, the retained document can render a missing export again.
    # Returning success after a file failure would instead orphan user content.
    documents = list(db.scalars(
        select(GeneratedDocument)
        .where(GeneratedDocument.user_id == user.id)
        .with_for_update()
    ))
    try:
        for document in documents:
            remove_document_exports(db, document)
    except MaterializedFileError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Account deletion could not be completed. Please retry.",
        ) from exc
    record_audit(db, user.id, "account_deleted")
    db.flush()
    db.execute(delete(User).where(User.id == user.id))
    db.commit()
