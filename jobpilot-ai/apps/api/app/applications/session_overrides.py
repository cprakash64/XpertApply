"""Answers the user gives for one application only.

The distinction this module protects: "yes, for this application" is not the
same statement as "yes, always". An override answers the employer in front of
the user right now and expires with the session; it never touches the reusable
ApplicationAnswer vault, and it never becomes a profile answer without a
separate, explicit save.

As everywhere else in the answer path, the browser says only *what the user
chose*. Provenance, verification and scope are decided here.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.applications.question_registry import REGISTRY, AnswerType, Sensitivity
from app.models.entities import ApplicationSession

#: Sensitivities that may never be answered for the user, at any scope. Consent
#: and attestations are the user's signature; demographics are theirs to
#: volunteer. An override is still an XpertApply-assisted answer, so these are
#: excluded here exactly as they are from reusable storage.
INELIGIBLE_SENSITIVITIES = frozenset(
    {Sensitivity.consent, Sensitivity.attestation, Sensitivity.demographic}
)

#: Answer types an override may carry. Deliberately narrow — an override exists
#: to answer a bounded employer question, not to accept arbitrary prose.
SUPPORTED_TYPES = frozenset({AnswerType.boolean, AnswerType.single_select, AnswerType.short_text})

MAX_TEXT_LENGTH = 200


class OverrideRejected(ValueError):
    """Why an override was refused. The reason is a low-cardinality code."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _normalize(canonical_key: str, value: Any) -> str:
    """Validate against the registry's declared answer type.

    A question the registry calls boolean must receive a boolean; accepting
    "maybe" and coercing it would produce an answer the user never gave.
    """
    spec = REGISTRY.get(canonical_key)
    if spec is None:
        raise OverrideRejected("unknown_canonical_key")
    if spec.sensitivity in INELIGIBLE_SENSITIVITIES:
        raise OverrideRejected("sensitivity_not_eligible")
    # A question the registry refuses to auto-fill at all (salary expectation,
    # say) must not become fillable just because the scope is narrower. The
    # reason it is excluded is that XpertApply should not be answering it.
    if not spec.autofill_allowed:
        raise OverrideRejected("autofill_not_permitted")
    if spec.answer_type not in SUPPORTED_TYPES:
        raise OverrideRejected("answer_type_not_supported")

    if spec.answer_type is AnswerType.boolean:
        if isinstance(value, bool):
            return "Yes" if value else "No"
        if isinstance(value, str) and value.strip().lower() in {"yes", "no", "true", "false"}:
            return "Yes" if value.strip().lower() in {"yes", "true"} else "No"
        raise OverrideRejected("invalid_boolean")

    if not isinstance(value, str) or not value.strip():
        raise OverrideRejected("invalid_value")
    text = value.strip()
    if len(text) > MAX_TEXT_LENGTH:
        raise OverrideRejected("value_too_long")
    return text


def set_override(session: ApplicationSession, canonical_key: str, value: Any) -> dict:
    """Record an application-scoped answer on the session.

    Returns display-safe metadata. The value itself is stored on the session
    row (which the extension already reads through an authenticated,
    ownership-checked route) and is never echoed into logs.
    """
    normalized = _normalize(canonical_key, value)
    overrides = dict(session.application_overrides or {})
    overrides[canonical_key] = {
        # Server-owned, every one of them. None of these may be supplied by a
        # client — that is the whole point of doing this here.
        "value": normalized,
        "source": "user_confirmed_application",
        "scope": "application_session",
        "confirmed_at": datetime.now(UTC).isoformat(),
    }
    # Reassigned rather than mutated in place so SQLAlchemy sees the JSON change.
    session.application_overrides = overrides
    return {
        "canonical_key": canonical_key,
        "scope": "application_session",
        "answered": True,
        # What the UI shows as provenance. Not an internal enum.
        "source_label": "Confirmed for this application",
        "confirmed_at": overrides[canonical_key]["confirmed_at"],
    }


def get_override(session: ApplicationSession, canonical_key: str) -> str | None:
    """The override value for this session, if the user gave one."""
    entry = (session.application_overrides or {}).get(canonical_key)
    if not isinstance(entry, dict):
        return None
    value = entry.get("value")
    return value if isinstance(value, str) and value else None


def clear_override(session: ApplicationSession, canonical_key: str) -> None:
    overrides = dict(session.application_overrides or {})
    overrides.pop(canonical_key, None)
    session.application_overrides = overrides


def list_overrides(session: ApplicationSession) -> list[dict]:
    """Display-safe summary. Values are omitted; the caller shows the employer
    control, not a rendering of the user's legal answer."""
    result: list[dict] = []
    for key, entry in (session.application_overrides or {}).items():
        if not isinstance(entry, dict):
            continue
        result.append(
            {
                "canonical_key": key,
                "scope": "application_session",
                "source_label": "Confirmed for this application",
                "confirmed_at": entry.get("confirmed_at"),
            }
        )
    return result
