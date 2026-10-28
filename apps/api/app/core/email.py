"""Outbound email: one small interface, two real backends.

Only account-recovery mail uses this today. Nothing here is a mock of delivery:

- ``smtp``   speaks SMTP to a real relay (STARTTLS or implicit TLS, optional
             authentication) using the standard library, so no new dependency.
- ``outbox`` writes each message to a ``.eml`` file. For local development and
             tests ONLY: production validation refuses it, because a file is not
             delivery.
- ``disabled`` (the default) sends nothing; callers must treat the feature that
             needs email as unavailable rather than pretend.

Message bodies are built by the caller. Recipients are never written to logs
(a hashed form is); bodies, which can hold a reset link, are never logged at all.
"""

from __future__ import annotations

import hashlib
import logging
import re
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger("jobpilot.email")

_HEADER_UNSAFE = re.compile(r"[\r\n]")


class EmailDeliveryError(RuntimeError):
    """Raised when a message could not be handed to the backend."""


def recipient_fingerprint(address: str) -> str:
    """A stable, non-reversible label for log lines (never the address itself)."""
    return hashlib.sha256(address.strip().lower().encode()).hexdigest()[:12]


def build_message(*, to: str, subject: str, text: str, html: str | None = None) -> EmailMessage:
    if _HEADER_UNSAFE.search(to) or _HEADER_UNSAFE.search(subject):
        raise EmailDeliveryError("Refusing a header containing a line break.")
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain=_from_domain())
    # RFC 3834: mark transactional mail so autoresponders do not answer it.
    message["Auto-Submitted"] = "auto-generated"
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
    return message


def _from_domain() -> str:
    address = parseaddr(settings.email_from)[1]
    return address.rsplit("@", 1)[-1] if "@" in address else "localhost"


def send_email(*, to: str, subject: str, text: str, html: str | None = None) -> None:
    backend = (settings.email_backend or "disabled").strip().lower()
    message = build_message(to=to, subject=subject, text=text, html=html)
    if backend == "smtp":
        _send_smtp(message)
    elif backend == "outbox":
        _write_outbox(message, to)
    else:
        raise EmailDeliveryError("Email delivery is not configured.")


def _send_smtp(message: EmailMessage) -> None:
    host = (settings.smtp_host or "").strip()
    if not host:
        raise EmailDeliveryError("SMTP host is not configured.")
    security = (settings.smtp_security or "starttls").strip().lower()
    timeout = settings.smtp_timeout_seconds
    try:
        if security == "ssl":
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                host, settings.smtp_port, timeout=timeout, context=ssl.create_default_context()
            )
        else:
            client = smtplib.SMTP(host, settings.smtp_port, timeout=timeout)
        with client:
            if security == "starttls":
                client.starttls(context=ssl.create_default_context())
            if settings.smtp_username:
                client.login(settings.smtp_username, settings.smtp_password or "")
            client.send_message(message)
    except (smtplib.SMTPException, OSError) as exc:
        # The exception text can carry server banners but never our credentials;
        # still, log only its type.
        raise EmailDeliveryError(f"SMTP delivery failed ({type(exc).__name__}).") from exc


def _write_outbox(message: EmailMessage, to: str) -> None:
    directory = Path(settings.email_outbox_dir)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        name = f"{int(time.time() * 1000)}-{recipient_fingerprint(to)}.eml"
        (directory / name).write_bytes(bytes(message))
    except OSError as exc:
        raise EmailDeliveryError("Outbox is not writable.") from exc
