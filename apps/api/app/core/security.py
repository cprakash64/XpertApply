import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from jwt import InvalidTokenError

try:
    from passlib.context import CryptContext
except ModuleNotFoundError:
    CryptContext = None

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto") if CryptContext else None
ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    if pwd_context:
        return pwd_context.hash(password)
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 310_000).hex()
    return f"pbkdf2_sha256${salt}${digest}"


def verify_password(password: str, hashed_password: str) -> bool:
    if pwd_context:
        return pwd_context.verify(password, hashed_password)
    try:
        scheme, salt, digest = hashed_password.split("$", 2)
    except ValueError:
        return False
    if scheme != "pbkdf2_sha256":
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 310_000).hex()
    return hmac.compare_digest(candidate, digest)


def create_access_token(subject: str) -> str:
    now = datetime.now(UTC)
    expires = now + timedelta(minutes=settings.jwt_expires_minutes)
    # `iat` lets the server refuse tokens issued before a password change.
    payload = {"sub": subject, "exp": expires, "iat": now.timestamp()}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token_claims(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except InvalidTokenError:
        return None
    return payload if isinstance(payload.get("sub"), str) else None


def decode_access_token(token: str) -> str | None:
    payload = decode_access_token_claims(token)
    return payload["sub"] if payload else None


def token_predates_password_change(claims: dict, password_changed_at: datetime | None) -> bool:
    """True when a login token was issued before the user's last password change.

    A user who has never changed their password has no cutoff, so every
    existing token keeps working. After a change, a token is accepted only if it
    carries an ``iat`` at or after the change (compared at
    microsecond resolution: ``iat`` is a fractional NumericDate); tokens with no
    ``iat`` are pre-change by definition.
    """
    if password_changed_at is None:
        return False
    changed = password_changed_at if password_changed_at.tzinfo else password_changed_at.replace(tzinfo=UTC)
    issued = claims.get("iat")
    if not isinstance(issued, int | float):
        return True
    return float(issued) < changed.timestamp()
