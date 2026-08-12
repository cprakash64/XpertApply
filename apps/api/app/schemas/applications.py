"""Request/response schemas for assisted auto-apply."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.applications.answer_resolution_service import (
    MAX_OPTION_LABEL_LENGTH,
    MAX_OPTIONS_PER_QUESTION,
    MAX_QUESTION_LENGTH,
    MAX_QUESTIONS,
    MAX_REF_LENGTH,
    MAX_SECTION_LENGTH,
)


class CreateSessionIn(BaseModel):
    job_id: int


class ExchangeTokenIn(BaseModel):
    launch_token: str = Field(min_length=10, max_length=4000)


class StatusPatchIn(BaseModel):
    status: str


class CompleteSessionIn(BaseModel):
    confirmed: bool = False


class SubmissionConfirmedIn(BaseModel):
    """A confirmed ATS submission reported by the extension or an auto-apply run.

    Note what is absent: no ``user_id``, no ``job_id``, no ``status``, no resume
    id, no company or title. All of those are derived server-side from the
    session the caller's token is scoped to, so a compromised or buggy client
    cannot mark a *different* job — or another user's job — as applied.

    ``evidence_type`` is a closed vocabulary. The server rejects anything else,
    which means a client cannot invent a weaker justification (for example
    "submit_clicked") and have it accepted as proof."""

    model_config = ConfigDict(extra="forbid")

    #: How success was established. Validated against EVIDENCE_TYPES at the route.
    evidence_type: str = Field(min_length=1, max_length=40)
    #: Which confirmation path this is; defaults to the extension.
    confirmation_source: str = Field(default="extension_confirmed", max_length=40)
    #: When the ATS confirmed the submission. Server-clamped to "not in the future".
    submission_timestamp: datetime | None = None
    #: Opaque ATS receipt/confirmation number, when the success page exposes one.
    submission_reference: str | None = Field(default=None, max_length=200)
    #: Applicant tracking system id, for metrics only.
    ats: str | None = Field(default=None, max_length=40)


class ConfirmAppliedIn(BaseModel):
    """The user's explicit "yes, I submitted this application".

    The job is taken from the URL path and the user from the bearer token; this
    body only carries the user's own account of *when*."""

    model_config = ConfigDict(extra="forbid")

    confirmed: bool = False
    submitted_at: datetime | None = None


class SessionEventIn(BaseModel):
    action_type: str = Field(min_length=1, max_length=60)
    field_key: str | None = Field(default=None, max_length=120)
    source: str | None = Field(default=None, max_length=60)
    status: str | None = Field(default=None, max_length=40)
    confidence: float | None = Field(default=None, ge=0, le=1)
    metadata: dict[str, Any] | None = None


class AnswerUpsertIn(BaseModel):
    value: str | None = None
    display_value: str | None = None
    source: str | None = None
    is_user_verified: bool | None = None
    allow_auto_fill: bool | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    scope: str | None = None
    company_key: str | None = None


class SessionAnswerUpsertIn(BaseModel):
    """Save-for-future-applications from the extension's review widget. Always
    an explicit, user-initiated confirmation — the caller (background.ts)
    only sends this after the user picks "Save and fill" on an unresolved
    question, so it is always recorded as ``source="user_confirmed"`` and
    verified."""

    value: str = Field(min_length=1, max_length=4000)
    display_value: str | None = Field(default=None, max_length=4000)
    scope: str | None = None
    company_key: str | None = Field(default=None, max_length=160)


class SessionNameConfirmIn(BaseModel):
    """Session-scoped structured-name confirmation. ``given_name``/
    ``family_name`` stay accepted as aliases for older extension builds."""

    model_config = ConfigDict(populate_by_name=True)

    first_name: str = Field(
        min_length=1, max_length=120,
        validation_alias=AliasChoices("first_name", "given_name"),
    )
    last_name: str = Field(
        min_length=1, max_length=120,
        validation_alias=AliasChoices("last_name", "family_name"),
    )
    middle_name: str | None = Field(default=None, max_length=120)
    preferred_first_name: str | None = Field(default=None, max_length=120)
    preferred_last_name: str | None = Field(default=None, max_length=120)


class AutofillFailure(BaseModel):
    """A single field the extension could not confidently fill. Carries only a
    canonical key and a machine reason code — never the employer value/HTML."""

    field_key: str = Field(min_length=1, max_length=120)
    reason_code: str = Field(min_length=1, max_length=60)


class MapOptionIn(BaseModel):
    """Request to translate a confirmed answer into an employer's exact option
    wording. Carries ONLY the question, its options, the canonical key, and the
    confirmed answer — never profile data, tokens, or document content."""

    question_label: str = Field(min_length=1, max_length=500)
    options: list[str] = Field(min_length=1, max_length=200)
    canonical_key: str = Field(min_length=1, max_length=100)
    confirmed_answer: str | None = Field(default=None, max_length=500)
    help_text: str | None = Field(default=None, max_length=1000)


class AutofillResultIn(BaseModel):
    """Safe, PII-free summary the extension reports after an autofill pass.

    Deliberately counts + codes only: no field values, no page HTML, no personal
    data. Used for the tracker and debugging.
    """

    status: str = Field(min_length=1, max_length=40)
    ats: str | None = Field(default=None, max_length=40)
    fields_discovered: int = Field(default=0, ge=0, le=1000)
    fields_filled: int = Field(default=0, ge=0, le=1000)
    documents_uploaded: list[str] = Field(default_factory=list, max_length=10)
    review_items: int = Field(default=0, ge=0, le=1000)
    failures: list[AutofillFailure] = Field(default_factory=list, max_length=100)


# --------------------------------------------------------------------------- #
# Question resolution
# --------------------------------------------------------------------------- #
class ResolveOptionIn(BaseModel):
    """One visible option. The extension supplies an opaque reference it can map
    back to a DOM node; the server never receives or returns a selector."""

    option_ref: str = Field(min_length=1, max_length=MAX_REF_LENGTH)
    label: str = Field(min_length=1, max_length=MAX_OPTION_LABEL_LENGTH)


class ResolveQuestionIn(BaseModel):
    field_ref: str = Field(min_length=1, max_length=MAX_REF_LENGTH)
    question: str = Field(min_length=1, max_length=MAX_QUESTION_LENGTH)
    raw_label: str | None = Field(default=None, max_length=MAX_QUESTION_LENGTH)
    accessible_name: str | None = Field(default=None, max_length=MAX_QUESTION_LENGTH)
    nearby_text: str | None = Field(default=None, max_length=MAX_QUESTION_LENGTH)
    field_name: str | None = Field(default=None, max_length=MAX_SECTION_LENGTH)
    field_id: str | None = Field(default=None, max_length=MAX_SECTION_LENGTH)
    placeholder: str | None = Field(default=None, max_length=MAX_QUESTION_LENGTH)
    aria_role: str | None = Field(default=None, max_length=40)
    section: str | None = Field(default=None, max_length=MAX_SECTION_LENGTH)
    control_type: str = Field(default="other", max_length=40)
    required: bool = False
    locale: str = Field(default="en-US", max_length=16)
    options: list[ResolveOptionIn] = Field(
        default_factory=list, max_length=MAX_OPTIONS_PER_QUESTION
    )


class ResolveQuestionsIn(BaseModel):
    """A bounded batch of what the extension can SEE.

    Everything consequential — who the user is, which session, what their answer
    is, whether it is trustworthy — is derived server-side and is deliberately
    absent from this model.
    """

    schema_version: int = Field(default=2, ge=2, le=3)
    questions: list[ResolveQuestionIn] = Field(min_length=1, max_length=MAX_QUESTIONS)


class ApplicationOverrideIn(BaseModel):
    """A single answer, for this application only.

    Only the value. Source, verification, confirmation time and scope are
    consequences the server derives from an authenticated action — accepting
    them here would let a page mint a trusted answer.
    """

    value: bool | str
