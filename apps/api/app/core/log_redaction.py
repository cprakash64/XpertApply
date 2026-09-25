"""Redaction of credentials from log records.

Secrets reach logs by accident, not by design: a driver stringifies its DSN into
a connection error, a traceback repr's a settings object, a retry loop prints the
URL it failed on. `start-api.sh` did exactly this — it printed the SQLAlchemy
exception, DSN and password included, on every connection retry.

This filter is a safety net, not a licence to log secrets. It rewrites the
recognisable shapes (URL userinfo, common key=value pairs, bearer tokens,
provider tokens) in the formatted message.
"""

from __future__ import annotations

import logging
import re

REDACTED = "***REDACTED***"

_PATTERNS: tuple[re.Pattern[str], ...] = (
    # scheme://user:password@host  ->  scheme://user:***@host
    re.compile(r"(?P<pre>[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s:/@]+:)(?P<secret>[^\s@/]+)(?P<post>@)"),
    # Authorization: Bearer <token>. MUST precede the generic key=value rule
    # below, whose `authorization` alternative would otherwise match
    # "Authorization: Bearer" and redact the word "Bearer", leaving the token.
    re.compile(r"(?P<pre>(?i:bearer)\s+)(?P<secret>[A-Za-z0-9._\-]{8,})"),
    # key=value / key: value for secret-ish names, quoted or bare
    re.compile(
        r"(?P<pre>(?i:password|passwd|secret|secret_key|api_key|apikey|token|access_token|"
        r"refresh_token|authorization|auth|private_key|encryption_key)\s*[=:]\s*)"
        r"(?P<secret>\"[^\"]+\"|'[^']+'|[^\s,;&)}\]]+)"
    ),
    # Provider tokens that are self-identifying regardless of context.
    re.compile(r"(?P<pre>)(?P<secret>sk-[A-Za-z0-9]{16,})(?P<post>)"),
    re.compile(r"(?P<pre>)(?P<secret>gh[pousr]_[A-Za-z0-9]{20,})(?P<post>)"),
    re.compile(r"(?P<pre>)(?P<secret>xox[baprs]-[A-Za-z0-9\-]{8,})(?P<post>)"),
)


def redact(text: str) -> str:
    """Replace credential-shaped substrings. Safe on arbitrary input."""
    if not text:
        return text
    result = text
    def _replace(match: re.Match[str]) -> str:
        groups = match.groupdict()
        return f"{groups.get('pre') or ''}{REDACTED}{groups.get('post') or ''}"

    for pattern in _PATTERNS:
        result = pattern.sub(_replace, result)
    return result


class RedactingFilter(logging.Filter):
    """Redact secrets from a record before any handler formats it.

    Applied to the record's formatted message (and its args), so it covers both
    ``logger.info("url=%s", dsn)`` and pre-formatted f-strings.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - never let logging break the request
            return True
        redacted = redact(message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


class QueryFreeUvicornAccessFilter(logging.Filter):
    """Remove query strings from Uvicorn's structured access-log arguments.

    Uvicorn 0.30.x emits ``(client, method, full_path, http_version, status)``.
    Mutating the target before ``AccessFormatter`` runs preserves operational
    metadata without ever serializing query values into a handler or sink.
    Unknown record shapes are left untouched rather than risking logging
    failures during an incident.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != "uvicorn.access":
            return True
        args = record.args
        if not isinstance(args, tuple) or len(args) != 5:
            return True
        full_path = args[2]
        if not isinstance(full_path, str):
            return True
        path, separator, _query = full_path.partition("?")
        if separator:
            record.args = (*args[:2], path or "/", *args[3:])
        return True


def install(root: logging.Logger | None = None) -> None:
    """Attach the filter to the root logger's handlers (and the root itself, so
    handlers added later by uvicorn/gunicorn inherit the filtered records)."""
    target = root or logging.getLogger()
    log_filter = RedactingFilter()
    if not any(isinstance(f, RedactingFilter) for f in target.filters):
        target.addFilter(log_filter)
    for handler in target.handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(log_filter)

    # ``uvicorn.access`` logs directly with ``propagate=False`` under the
    # default server configuration, so root filters do not see these records.
    # Install on the named logger before lifespan startup completes and the
    # server begins accepting requests.
    access_logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, QueryFreeUvicornAccessFilter) for f in access_logger.filters):
        access_logger.addFilter(QueryFreeUvicornAccessFilter())
