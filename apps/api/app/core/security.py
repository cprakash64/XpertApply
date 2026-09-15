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
# The ONLY algorithm this service issues or accepts. Passed explicitly to
# `jwt.decode` as a single-element allow-list so the accepted algorithm can
# never be read from the token's own header — the shape of every JWT
# algorithm-confusion attack. Adding to this list is a security decision.
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
    expires = datetime.now(UTC) + timedelta(minutes=settings.jwt_expires_minutes)
    payload = {"sub": subject, "exp": expires}
    # PyJWT returns `str` on every supported version; callers hand this straight
    # to an Authorization header, so a bytes return would be a contract change.
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> str | None:
    """The subject of a valid token, or None.

    `InvalidTokenError` is PyJWT's base for every rejection this cares about —
    bad signature, expired, malformed, disallowed algorithm — so catching it
    keeps the previous `JWTError` boundary exactly: a bad token is None, never
    an exception that would surface as a 500.
    """
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except InvalidTokenError:
        return None
    subject = payload.get("sub")
    return subject if isinstance(subject, str) else None
