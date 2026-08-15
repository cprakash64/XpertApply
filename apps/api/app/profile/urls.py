"""Canonical validation types for user-entered profile web links.

Profile links are stored, not fetched.  The boundary therefore accepts normal
HTTP(S) web URLs without adding SSRF-oriented network restrictions, while still
rejecting script-capable and non-web schemes through Pydantic's ``HttpUrl``.

Users commonly enter a host without URI syntax.  Scheme-less, host-qualified
input is interpreted as HTTPS; arbitrary text is not.  Both the normal profile
API and resume/import application use these types so one write path can never
create a value the other path cannot consume.
"""

from __future__ import annotations

from ipaddress import ip_address
from typing import Annotated, Any
from urllib.parse import urlsplit

from pydantic import BeforeValidator, HttpUrl


def normalize_profile_url_input(value: Any) -> Any:
    """Prepare user-entered web input for authoritative ``HttpUrl`` validation.

    ``None`` and blank strings mean an absent optional link.  Explicit schemes
    are left intact so ``HttpUrl`` preserves HTTP and rejects every unsupported
    scheme.  A missing scheme is defaulted to HTTPS only when the candidate has
    a complete host (a dotted domain, IP address, or localhost), which prevents
    arbitrary words from being promoted into URLs.

    The return value is deliberately still validated by ``HttpUrl``.  This
    function is normalization, not a replacement URL parser.
    """

    if value is None:
        return None
    if not isinstance(value, str):
        # Let Pydantic produce the canonical type error for unsupported input.
        return value

    text = value.strip()
    if not text:
        return None

    try:
        parsed = urlsplit(text)
    except ValueError:
        # Preserve malformed input so HttpUrl rejects it with its standard
        # validation error rather than silently converting or discarding it.
        return text

    if parsed.scheme:
        return text
    if text.startswith("//"):
        # A scheme-relative URL is not user-friendly bare-domain input.  Keep it
        # unchanged so HttpUrl rejects the missing scheme.
        return text

    candidate = f"https://{text}"
    try:
        host = urlsplit(candidate).hostname
    except ValueError:
        return candidate
    if host and not _is_qualified_scheme_less_host(host):
        raise ValueError("Enter a complete web address, such as example.com.")
    return candidate


def _is_qualified_scheme_less_host(host: str) -> bool:
    normalized = host.rstrip(".").lower()
    if normalized == "localhost" or "." in normalized:
        return True
    try:
        ip_address(normalized)
    except ValueError:
        return False
    return True


# A required URL (used inside a non-empty additional-link row) and its optional
# counterpart share the exact same pre-validation policy.
ProfileUrl = Annotated[HttpUrl, BeforeValidator(normalize_profile_url_input)]
OptionalProfileUrl = Annotated[HttpUrl | None, BeforeValidator(normalize_profile_url_input)]
