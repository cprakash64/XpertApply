from __future__ import annotations

# ruff: noqa: E501
import base64
import hashlib
import hmac
from urllib.parse import urlparse, urlunparse

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


def _material() -> str:
    return settings.people_data_encryption_key or settings.secret_key


def encrypt_email(email: str) -> str:
    key = base64.urlsafe_b64encode(hashlib.sha256(f"people-encryption:{_material()}".encode()).digest())
    return Fernet(key).encrypt(email.lower().strip().encode()).decode()


def decrypt_email(ciphertext: str | None) -> str | None:
    if not ciphertext:
        return None
    key = base64.urlsafe_b64encode(hashlib.sha256(f"people-encryption:{_material()}".encode()).digest())
    try:
        return Fernet(key).decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError, UnicodeError):
        return None


def email_hash(email: str) -> str:
    return hmac.new(
        hashlib.sha256(f"people-hash:{_material()}".encode()).digest(),
        email.lower().strip().encode(),
        hashlib.sha256,
    ).hexdigest()


def safe_profile_url(value: str | None) -> str | None:
    if not value or len(value) > 1000:
        return None
    parsed = urlparse(value.strip())
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return None
    host = parsed.hostname.lower().strip(".")
    if host != "linkedin.com" and not host.endswith(".linkedin.com"):
        return None
    if not parsed.path.lower().startswith("/in/"):
        return None
    return urlunparse(("https", host, parsed.path.rstrip("/"), "", "", ""))


# People providers reference the same LinkedIn profile in three surface forms:
# a full ``https://`` URL, a legacy ``http://`` URL, and — People Data Labs'
# documented form — a bare ``linkedin.com/in/<slug>`` carrying no scheme at all.
#
# ``safe_profile_url`` is the security boundary and correctly accepts only
# ``https``. It was being handed raw provider values, so every PDL record
# normalized to ``linkedin_url=None`` and was then rejected by the actionable
# gate as ``missing_linkedin_url``. Because PDL is the primary provider, that
# emptied the entire feature while every test — all of which used fixtures
# already in ``https://`` form — stayed green.
#
# So provider values are canonicalized to the accepted form *first* and
# validated after. Nothing below relaxes validation: a non-LinkedIn host, a
# non-``/in/`` path, or embedded credentials still fail, and no URL is ever
# assembled from a person's name.
def canonical_profile_url(value: str | None) -> str | None:
    """Canonicalize a provider-supplied profile reference, then validate it."""

    text = (value or "").strip()
    if not text or len(text) > 1000:
        return None
    lowered = text.lower()
    if lowered.startswith("http://"):
        text = f"https://{text[len('http://') :]}"
    elif not lowered.startswith("https://"):
        # Scheme-less. Upgraded only when the value is already a host-qualified
        # path, so a bare slug or a relative path is refused rather than guessed
        # into some host's namespace.
        if "/" not in text or text.startswith("/") or "." not in text.split("/", 1)[0]:
            return None
        text = f"https://{text}"
    validated = safe_profile_url(text)
    if validated is None:
        return None
    parsed = urlparse(validated)
    segments = [segment for segment in parsed.path.split("/") if segment]
    # ``safe_profile_url`` checks only that the path *starts* with "/in/", so
    # "/in/rita/../../company/x" satisfies it while resolving, in any browser,
    # to a company page. Refuse relative segments outright rather than trying to
    # collapse them.
    if any(segment in {".", ".."} for segment in segments):
        return None
    # "/in/" with no slug identifies nobody.
    if len(segments) < 2:
        return None
    # Reduce to the canonical profile: "/in/<slug>". Deeper paths ("/detail/…")
    # are subpages of the same person, and LinkedIn treats slugs as
    # case-insensitive. Both are normalized because _same_identity compares
    # these URLs with exact string equality (service.py), so "/in/Rita" and
    # "/in/rita" would otherwise be deduplicated as two different people —
    # which is exactly how one person appears twice when PDL and Apollo
    # disagree about slug casing.
    slug = segments[1].lower()
    if not slug:
        return None
    # One host, so one person is one string. A public profile slug is global on
    # LinkedIn: "linkedin.com/in/x", "www.linkedin.com/in/x" and
    # "uk.linkedin.com/in/x" are the same profile, and all three resolve.
    # _same_identity compares these URLs with exact string equality, so leaving
    # the host as-sent means the same person found by PDL ("linkedin.com/in/x")
    # and by Apollo ("www.linkedin.com/in/x") survives deduplication and is
    # rendered as two contact cards.
    return f"https://www.linkedin.com/in/{slug}"


def profile_url_from_provider_username(value: str | None) -> str | None:
    """A profile URL built from a provider's own structured profile slug.

    Not a guess, and not a pattern: the slug is an identifier the provider
    stores *for that record*, exactly as it stores the URL. Used only when the
    provider supplied no URL, and callers record the distinct provenance so a
    record sourced this way stays auditable.
    """

    slug = (value or "").strip().strip("/")
    if not slug or "/" in slug or len(slug) > 200:
        return None
    return canonical_profile_url(f"https://www.linkedin.com/in/{slug}")


def is_professional_email(email: str, company_domain: str) -> bool:
    value = email.lower().strip()
    if "@" not in value:
        return False
    local, domain = value.rsplit("@", 1)
    personal = {"gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me"}
    return bool(local) and domain == company_domain.lower() and domain not in personal
