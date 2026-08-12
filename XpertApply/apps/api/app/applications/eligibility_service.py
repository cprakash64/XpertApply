"""Explicit application-eligibility answers.

The three legal questions an employer asks — work authorization, current
sponsorship, future sponsorship — are answered ONCE here by the user, and only
here. This module is the sole writer of a trusted legal answer.

The design rule that shapes everything below: the browser states *what the user
chose*, and the server decides *what that means*. A client cannot mark an answer
verified, cannot pick its source, and cannot set its confirmation time. Those
are consequences of an authenticated user action, not inputs to it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.applications.answer_vault_service import (
    ALLOWED_LEGAL_SOURCES,
    LEGAL_ANSWER_KEYS,
    legal_answer_state,
)
from app.core.config import get_settings
from app.models.entities import ApplicationAnswer

#: What the user may say. Deliberately three states — "answer_each_time" is a
#: real choice, not the absence of one, and it must never be stored as False.
EligibilityChoice = Literal["yes", "no", "answer_each_time"]

#: Public field names. Internal canonical keys stay out of the API surface.
FIELD_TO_CANONICAL: dict[str, str] = {
    "work_authorization_us": "work_authorization_us",
    "sponsorship_required_now": "sponsorship_required_now",
    "sponsorship_required_future": "sponsorship_required_future",
}

#: The question text shown to the user, so UI and API cannot drift apart.
FIELD_PROMPTS: dict[str, str] = {
    "work_authorization_us": (
        "Are you legally authorized to work in the United States without restriction?"
    ),
    "sponsorship_required_now": (
        "Do you currently require employer sponsorship or a visa transfer?"
    ),
    "sponsorship_required_future": (
        "Will you require employer sponsorship or a visa transfer in the future?"
    ),
}


def reconfirmation_days() -> int:
    """How long a confirmation stays trustworthy. Configurable, read at call
    time so tests and deployments can vary it without patching call sites."""
    return int(getattr(get_settings(), "legal_answer_reconfirmation_days", 365) or 365)


def is_stale(row: ApplicationAnswer, *, now: datetime | None = None) -> bool:
    """A confirmation ages out. Circumstances change, and an answer given years
    ago is not evidence of what is true today."""
    if row.last_verified_at is None:
        return True
    moment = now or datetime.now(UTC)
    confirmed = row.last_verified_at
    if confirmed.tzinfo is None:
        confirmed = confirmed.replace(tzinfo=UTC)
    return moment - confirmed > timedelta(days=reconfirmation_days())


def _rows(db: Session, user_id: int) -> dict[str, ApplicationAnswer]:
    rows = db.scalars(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id)
            & (ApplicationAnswer.canonical_key.in_(sorted(LEGAL_ANSWER_KEYS)))
        )
    )
    return {row.canonical_key: row for row in rows}


def read_eligibility(db: Session, user_id: int) -> list[dict]:
    """Display-safe state of all three answers.

    Never returns immigration status as a stand-in, and never reports an
    unanswered question as "No" — `answered` and `value` are separate so the UI
    cannot accidentally render one as the other.
    """
    rows = _rows(db, user_id)
    result: list[dict] = []
    for field, canonical in FIELD_TO_CANONICAL.items():
        row = rows.get(canonical)
        state = legal_answer_state(row)
        stale = bool(row is not None and state == "explicit_verified" and is_stale(row))
        answered = state == "explicit_verified"
        value = (row.value or "").strip().lower() if row is not None else ""
        result.append(
            {
                "field": field,
                "prompt": FIELD_PROMPTS[field],
                # "yes" | "no" | None — None means genuinely unanswered.
                "answer": ("yes" if value in {"yes", "true"} else "no") if answered else None,
                "answered": answered,
                "reusable": answered and not stale,
                "needs_confirmation": stale,
                "confirmed_at": row.last_verified_at if row is not None else None,
                "version": _version_of(row),
            }
        )
    return result


def _version_of(row: ApplicationAnswer | None) -> int:
    if row is None:
        return 0
    try:
        raw = row.display_value or ""
        return int(raw.split("|v")[-1]) if "|v" in raw else 1
    except ValueError:
        return 1


def set_eligibility_answer(
    db: Session, user_id: int, field: str, choice: EligibilityChoice
) -> dict:
    """Record the user's own answer.

    ``yes``/``no`` create or refresh a trusted, reusable answer. ``answer_each_time``
    removes reusability WITHOUT storing a value — the distinction that keeps
    "I'd rather decide per application" from silently becoming "No".
    """
    canonical = FIELD_TO_CANONICAL.get(field)
    if canonical is None:
        raise ValueError(f"Unknown eligibility field: {field}")

    row = _rows(db, user_id).get(canonical)
    now = datetime.now(UTC)

    if choice == "answer_each_time":
        # A row is created even when none existed. "I want to be asked every
        # time" is a decision the user made, and storing nothing would make it
        # indistinguishable from never having visited the screen — the choice
        # would silently vanish on reload.
        #
        # The row deliberately holds NO value: empty value, not verified, not
        # auto-fillable. `legal_answer_state` therefore still reports "missing",
        # so nothing downstream can mistake this for a Yes or a No.
        if row is None:
            row = ApplicationAnswer(
                user_id=user_id,
                canonical_key=canonical,
                scope="sensitive",
                company_key="",
            )
            db.add(row)
        row.value = ""
        row.display_value = ""
        row.source = "explicit_profile"
        row.is_user_verified = False
        row.allow_auto_fill = False
        row.verification_required = True
        row.last_verified_at = None
        db.flush()
        return {"field": field, "answered": False, "reusable": False}

    value = "Yes" if choice == "yes" else "No"
    version = _version_of(row) + 1
    if row is None:
        row = ApplicationAnswer(
            user_id=user_id,
            canonical_key=canonical,
            # Sensitive scope keeps it out of any generic auto-fill path that
            # does not go through the legal gate.
            scope="sensitive",
            company_key="",
        )
        db.add(row)

    row.value = value
    row.display_value = f"{value}|v{version}"
    # Server-owned provenance. These are the fields a client may never supply.
    row.source = "explicit_profile"
    row.is_user_verified = True
    row.allow_auto_fill = True
    row.verification_required = True
    row.last_verified_at = now
    row.confidence = 1.0
    db.flush()

    assert row.source in ALLOWED_LEGAL_SOURCES  # noqa: S101 - invariant, not validation
    return {
        "field": field,
        "answered": True,
        "answer": choice,
        "reusable": True,
        "confirmed_at": now,
        "version": version,
    }


def resolve_combined_sponsorship(db: Session, user_id: int) -> dict:
    """The TikTok-style combined question: *now or in the future*.

    Truth table, computed only from two explicitly confirmed answers::

        now=No,  future=No   -> "No"
        now=Yes, future=No   -> "Yes"
        now=No,  future=Yes  -> "Yes"
        now=Yes, future=Yes  -> "Yes"

    A missing or stale component makes the combined answer unresolved. There is
    no "probably No" — an unanswered half is not evidence about the whole.
    """
    rows = _rows(db, user_id)
    parts: dict[str, bool] = {}
    for key in ("sponsorship_required_now", "sponsorship_required_future"):
        row = rows.get(key)
        if legal_answer_state(row) != "explicit_verified":
            return {"status": "unresolved", "reason_code": legal_answer_state(row), "missing": key}
        if is_stale(row):  # type: ignore[arg-type]
            return {"status": "needs_confirmation", "reason_code": "stale", "missing": key}
        parts[key] = (row.value or "").strip().lower() in {"yes", "true"}  # type: ignore[union-attr]

    combined = parts["sponsorship_required_now"] or parts["sponsorship_required_future"]
    return {"status": "resolved", "value": "Yes" if combined else "No"}
