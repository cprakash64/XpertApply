from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.audit import record_audit
from app.core.config import settings
from app.core.security import create_access_token, hash_password, verify_password
from app.db.session import get_db
from app.models.entities import PasswordResetToken, User, UserProfile
from app.schemas.auth import (
    LoginRequest,
    PasswordResetAvailability,
    PasswordResetConfirm,
    PasswordResetRequest,
    PasswordResetVerify,
    SignupRequest,
    TokenResponse,
    UserResponse,
)
from app.services import auth_throttle
from app.services import password_reset as recovery

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup", response_model=TokenResponse)
def signup(payload: SignupRequest, request: Request, db: Session = Depends(get_db)) -> TokenResponse:
    auth_throttle.check_signup_allowed(request)
    try:
        existing = db.scalar(select(User).where(User.email == payload.email.lower()))
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
        user = User(email=payload.email.lower(), hashed_password=hash_password(payload.password))
        db.add(user)
        db.flush()
        db.add(
            UserProfile(
                user_id=user.id,
                full_name="",
                target_roles=[],
                target_levels=[],
                preferred_locations=[],
                skills=[],
            )
        )
        db.commit()
        return TokenResponse(access_token=create_access_token(str(user.id)))
    except HTTPException:
        raise
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        ) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable or not migrated. Run alembic upgrade head.",
        ) from exc


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> TokenResponse:
    # Counted and, past the limit, refused BEFORE the password is checked: unknown and known emails behave identically.
    account_key = auth_throttle.begin_login_attempt(request, payload.email)
    try:
        user = db.scalar(select(User).where(User.email == payload.email.lower()))
        if (
            user is None
            or user.hashed_password is None
            or not verify_password(payload.password, user.hashed_password)
        ):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
        auth_throttle.login_succeeded(account_key)
        return TokenResponse(access_token=create_access_token(str(user.id)))
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable or not migrated. Run alembic upgrade head.",
        ) from exc


@router.get("/me", response_model=UserResponse)
def me(user: User = Depends(get_current_user)) -> User:
    return user


# --- Password recovery --------------------------------------------------------
GENERIC_REQUEST_RESPONSE = {
    "status": "accepted",
    "message": "If an account exists for that email, a reset link is on its way.",
}
INVALID_TOKEN = HTTPException(
    status_code=status.HTTP_400_BAD_REQUEST,
    detail="This reset link is invalid or has expired. Request a new one.",
)


def _client_key(request: Request, scope: str) -> str:
    host = request.client.host if request.client else "unknown"
    return f"pwreset:{scope}:client:{host}"


@router.get("/password-reset/availability", response_model=PasswordResetAvailability)
def password_reset_availability() -> PasswordResetAvailability:
    """Whether recovery can really deliver email here. The UI uses this so it
    never offers a form that cannot work."""
    return PasswordResetAvailability(available=settings.password_reset_available)


@router.post("/password-reset/request", status_code=status.HTTP_202_ACCEPTED)
def request_password_reset(
    payload: PasswordResetRequest,
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    if not settings.password_reset_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password recovery is not available right now.",
        )
    email = payload.email.lower()
    # Both caps apply to known and unknown addresses alike, so a 429 reveals nothing.
    recovery.rate_limit(
        recovery.email_key(email),
        limit=settings.password_reset_per_email_hourly_limit,
        window_seconds=recovery.HOUR,
    )
    recovery.rate_limit(
        _client_key(request, "request"),
        limit=settings.password_reset_per_client_hourly_limit,
        window_seconds=recovery.HOUR,
    )
    try:
        user = db.scalar(select(User).where(User.email == email))
        if user is not None:
            if user.hashed_password:
                token = recovery.issue_token(db, user.id)
                if token is not None:
                    record_audit(db, user.id, "password_reset_requested")
                    db.commit()
                    background.add_task(recovery.send_reset_email, user.email, token)
            else:
                # Provider-only account: no token, just a note about how to sign in.
                background.add_task(recovery.send_provider_account_notice, user.email)
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password recovery is not available right now.",
        ) from exc
    return GENERIC_REQUEST_RESPONSE


def _live_token(db: Session, token: str) -> PasswordResetToken | None:
    row = db.scalar(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == recovery.hash_token(token))
    )
    if row is None or row.used_at is not None or recovery.aware(row.expires_at) <= recovery.utcnow():
        return None
    return row


@router.post("/password-reset/verify")
def verify_password_reset(
    payload: PasswordResetVerify, request: Request, db: Session = Depends(get_db)
) -> dict[str, bool]:
    """Read-only check so the page can say up front whether a link still works.
    It never consumes the token (mail scanners may open links)."""
    recovery.rate_limit(_client_key(request, "verify"), limit=60, window_seconds=600)
    try:
        return {"valid": _live_token(db, payload.token) is not None}
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password recovery is not available right now.",
        ) from exc


@router.post("/password-reset/confirm")
def confirm_password_reset(
    payload: PasswordResetConfirm, request: Request, db: Session = Depends(get_db)
) -> dict[str, str]:
    recovery.rate_limit(_client_key(request, "confirm"), limit=20, window_seconds=600)
    try:
        row = _live_token(db, payload.token)
        if row is None:
            raise INVALID_TOKEN
        user = db.get(User, row.user_id)
        if user is None:
            raise INVALID_TOKEN
        if payload.new_password.strip().lower() == user.email.lower():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=[
                    {
                        "loc": ["body", "new_password"],
                        "msg": "Choose a password that is not your email address.",
                    }
                ],
            )
        now = recovery.utcnow()
        # Claim the token atomically: two simultaneous submissions cannot both win.
        claimed = db.execute(
            update(PasswordResetToken)
            .where(PasswordResetToken.id == row.id, PasswordResetToken.used_at.is_(None))
            .values(used_at=now)
        ).rowcount
        if claimed != 1:
            db.rollback()
            raise INVALID_TOKEN
        user.hashed_password = hash_password(payload.new_password)
        user.password_changed_at = now
        db.execute(
            delete(PasswordResetToken).where(
                PasswordResetToken.user_id == user.id, PasswordResetToken.id != row.id
            )
        )
        record_audit(db, user.id, "password_reset_completed")
        db.commit()
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password recovery is not available right now.",
        ) from exc
    # No session is created: the user signs in with the new password.
    return {"status": "password_updated"}
