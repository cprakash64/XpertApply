"""Resolve employer questions against the user's verified answers.

This is the join the pipeline was missing: the deterministic resolver knew what
a question MEANT, and the vault knew what the user ANSWERED, but nothing put
them together and picked an option that exists on the employer's page.

Everything consequential is decided here, server-side. The browser contributes
only what it can see — wording, option labels, opaque references — and receives
back an option reference to click. It never states who the user is, what the
answer is, or whether an answer is trustworthy.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.applications.answer_vault_service import (
    LEGAL_ANSWER_KEYS,
    legal_answer_state,
)
from app.applications.eligibility_service import is_stale
from app.applications.question_registry import REGISTRY, REGISTRY_VERSION, Sensitivity
from app.applications.question_resolver import (
    combine_sponsorship,
    map_boolean_option,
    map_job_source_option,
    resolve_question_descriptor,
)
from app.models.entities import ApplicationAnswer, JobPosting, JobSource

logger = logging.getLogger("jobpilot.applications")

#: Payload bounds. An application page is tens of fields, not thousands; these
#: keep a compromised or buggy content script from turning one request into a
#: denial-of-service.
MAX_QUESTIONS = 60
MAX_QUESTION_LENGTH = 500
MAX_SECTION_LENGTH = 120
MAX_OPTIONS_PER_QUESTION = 60
MAX_OPTION_LABEL_LENGTH = 200
MAX_REF_LENGTH = 128


@dataclass(frozen=True)
class OptionIn:
    option_ref: str
    label: str


@dataclass(frozen=True)
class QuestionIn:
    field_ref: str
    question: str
    section: str | None
    control_type: str
    required: bool
    locale: str
    options: list[OptionIn]
    raw_label: str | None = None
    accessible_name: str | None = None
    nearby_text: str | None = None
    field_name: str | None = None
    field_id: str | None = None
    placeholder: str | None = None
    aria_role: str | None = None


@dataclass
class QuestionResult:
    field_ref: str
    status: str
    canonical_key: str | None = None
    answer_type: str | None = None
    selected_option_ref: str | None = None
    safe_source: str = "none"
    confidence: float = 0.0
    sensitivity: str | None = None
    reason_code: str = "unresolved"
    resolution_method: str = "unresolved"
    transform: str = "none"
    required_canonical_keys: tuple[str, ...] = ()
    # The semantic answer is deliberately separate from option mapping. A
    # closed ARIA combobox may expose no options until the actuator opens it;
    # that must not turn a confirmed ``False`` into "missing information".
    typed_answer: bool | None = None
    display_answer: str | None = None
    source_values: tuple[bool | None, ...] = ()

    def as_dict(self) -> dict:
        return {
            "field_ref": self.field_ref,
            "status": self.status,
            "canonical_key": self.canonical_key,
            "answer_type": self.answer_type,
            "selected_option_ref": self.selected_option_ref,
            "safe_source": self.safe_source,
            "confidence": round(self.confidence, 3),
            "sensitivity": self.sensitivity,
            "reason_code": self.reason_code,
            "resolution_method": self.resolution_method,
            "transform": self.transform,
            "required_canonical_keys": list(self.required_canonical_keys),
            "typed_answer": self.typed_answer,
            "display_answer": self.display_answer,
            "source_values": list(self.source_values),
        }


# --------------------------------------------------------------------------- #
# Vault lookup
# --------------------------------------------------------------------------- #
def _legal_rows(db: Session, user_id: int) -> dict[str, ApplicationAnswer]:
    rows = db.scalars(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id)
            & (ApplicationAnswer.canonical_key.in_(sorted(LEGAL_ANSWER_KEYS)))
        )
    )
    return {row.canonical_key: row for row in rows}


def _boolean_answer(row: ApplicationAnswer | None) -> tuple[bool | None, str]:
    """``(value, status)`` for one legal component.

    ``status`` is the resolution status this component would produce on its own:
    ``resolved``, ``missing``, ``requires_confirmation`` or ``unsupported``.
    A component is never guessed — every non-resolved path returns ``None``.
    """
    state = legal_answer_state(row)
    if state == "missing":
        return None, "missing"
    if state == "source_not_allowed":
        # Present but originated somewhere we do not trust for a legal claim.
        return None, "unsupported"
    if state in {"unverified", "auto_fill_disabled", "invalid_type"}:
        return None, "requires_confirmation"
    if state != "explicit_verified" or row is None:
        return None, "missing"
    if is_stale(row):
        return None, "requires_confirmation"
    return (row.value or "").strip().lower() in {"yes", "true"}, "resolved"


# --------------------------------------------------------------------------- #
# Job-source metadata
# --------------------------------------------------------------------------- #
#: How a job reached XpertApply -> the category the option mapper understands.
#: Board integrations mean the posting came from the employer's own careers
#: site, which is the truthful answer to "where did you hear about this".
_SOURCE_TYPE_TO_CATEGORY = {
    "greenhouse": "company_site",
    "lever": "company_site",
    "ashby": "company_site",
    "workday": "company_site",
    "smartrecruiters": "company_site",
    "linkedin": "linkedin",
    "indeed": "indeed",
    "handshake": "handshake",
}


def job_source_category(db: Session, job_id: int | None) -> str | None:
    """The verified provenance of this posting, or None when we do not know.

    Deliberately conservative: an unrecognised source type yields None so the
    question goes to the user rather than being answered from a guess.
    """
    if job_id is None:
        return None
    job = db.get(JobPosting, job_id)
    if job is None or job.source_id is None:
        return None
    source = db.get(JobSource, job.source_id)
    if source is None:
        return None
    return _SOURCE_TYPE_TO_CATEGORY.get((source.type or "").strip().lower())


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #
def resolve_questions(
    db: Session,
    *,
    user_id: int,
    job_id: int | None,
    questions: list[QuestionIn],
    overrides: dict | None = None,
) -> list[QuestionResult]:
    """Resolve a batch, preserving input order and answering every field_ref.

    ``overrides`` are answers the user gave for THIS application. They take
    precedence over the reusable vault for this session only, and are already
    validated and provenance-stamped by session_overrides.
    """
    rows = _legal_rows(db, user_id)
    source_category = job_source_category(db, job_id)
    results = [
        _resolve_one(question, rows, source_category, overrides or {}) for question in questions
    ]

    # Aggregate, low-cardinality only: counts and outcome codes. No question
    # text, no option labels, no answer values, no identifiers.
    outcomes: dict[str, int] = {}
    for result in results:
        outcomes[result.status] = outcomes.get(result.status, 0) + 1
    logger.info(
        "apply.questions.resolved count=%d registry=%s outcomes=%s",
        len(results),
        REGISTRY_VERSION,
        outcomes,
    )
    return results


def _override_boolean(overrides: dict, canonical_key: str) -> bool | None:
    entry = overrides.get(canonical_key)
    if not isinstance(entry, dict):
        return None
    raw_value = entry.get("value")
    # Be tolerant of an older/newer JSON writer storing a real boolean. In
    # particular, ``False`` must not disappear through ``value or ""``.
    if isinstance(raw_value, bool):
        return raw_value
    if raw_value is None:
        return None
    value = str(raw_value).strip().lower()
    if value in {"yes", "true"}:
        return True
    if value in {"no", "false"}:
        return False
    return None


def _component_answer(
    rows: dict[str, ApplicationAnswer],
    overrides: dict,
    key: str,
) -> tuple[bool | None, str, str]:
    """One sponsorship component: this application's answer, else the vault.

    Returns ``(value, status, safe_source)``. An override outranks the reusable
    answer for this session only — it is not written back, so the vault answer is
    exactly what it was before and is used again in the next application.
    """
    override = _override_boolean(overrides, key)
    if override is not None:
        return override, "resolved", "application_override"
    value, status = _boolean_answer(rows.get(key))
    return value, status, "saved_profile"


def _resolve_one(
    question: QuestionIn,
    rows: dict[str, ApplicationAnswer],
    source_category: str | None,
    overrides: dict,
) -> QuestionResult:
    resolution = resolve_question_descriptor(
        question=question.question,
        raw_label=question.raw_label,
        accessible_name=question.accessible_name,
        nearby_text=question.nearby_text,
        section=question.section,
        field_name=question.field_name,
        field_id=question.field_id,
        placeholder=question.placeholder,
    )

    # Consent and attestations are the user's signature. Recognised only so
    # they can be handed back untouched.
    if resolution.method == "consent":
        return QuestionResult(
            question.field_ref,
            "manual",
            sensitivity=Sensitivity.consent.value,
            reason_code="consent_requires_user",
        )

    if resolution.method == "ambiguous_legal":
        return QuestionResult(
            question.field_ref,
            "ambiguous",
            sensitivity=Sensitivity.legal.value,
            reason_code=resolution.reason_code,
        )

    if resolution.canonical_key is None:
        # Unknown wording. A classifier may recognise it later; today it goes
        # to the user rather than to a nearby key.
        return QuestionResult(
            question.field_ref, "unsupported", reason_code=resolution.reason_code
        )

    key = resolution.canonical_key
    spec = REGISTRY[key]
    base = QuestionResult(
        question.field_ref,
        "unsupported",
        canonical_key=key,
        answer_type=spec.answer_type.value,
        sensitivity=spec.sensitivity.value,
        resolution_method=resolution.method,
        transform="boolean_or" if spec.composed_of else "identity",
        required_canonical_keys=spec.composed_of or (key,),
    )

    if not spec.autofill_allowed:
        base.status = "manual"
        base.reason_code = "autofill_not_permitted"
        return base

    labels = [option.label for option in question.options]
    by_label = {option.label: option.option_ref for option in question.options}

    # ------------------------------------------------------------ combined --
    if key == "sponsorship_required_now_or_future":
        # An override on the COMBINED question answers it directly for this
        # session. It deliberately does not decompose into the two reusable
        # components — the user answered the employer's question, not ours.
        combined_override = _override_boolean(overrides, key)
        if combined_override is not None:
            return _select_boolean(
                base, combined_override, labels, by_label, spec, "application_override"
            )
        # A component answered for this application changes what the combined
        # question resolves to. Without this, an employer page asking only the
        # combined question would keep reporting "missing" after the user had
        # answered the component the extension asked them about.
        now_value, now_status, now_source = _component_answer(
            rows, overrides, "sponsorship_required_now"
        )
        future_value, future_status, future_source = _component_answer(
            rows, overrides, "sponsorship_required_future"
        )
        for status in (now_status, future_status):
            if status != "resolved":
                base.status = status
                base.reason_code = f"component_{status}"
                return base
        combined, reason = combine_sponsorship(now_value, future_value)
        if combined is None:
            base.status = "missing"
            base.reason_code = reason
            return base
        base.source_values = (now_value, future_value)
        # Attributed to the narrower scope when either half came from one, so the
        # extension never labels an application-only answer as a saved profile
        # answer.
        safe_source = (
            "application_override"
            if "application_override" in (now_source, future_source)
            else "saved_profile"
        )
        return _select_boolean(base, combined, labels, by_label, spec, safe_source)

    # --------------------------------------------------------------- legal --
    if key in LEGAL_ANSWER_KEYS:
        override = _override_boolean(overrides, key)
        if override is not None:
            return _select_boolean(base, override, labels, by_label, spec, "application_override")
        value, status = _boolean_answer(rows.get(key))
        if status != "resolved" or value is None:
            base.status = status
            base.reason_code = f"answer_{status}"
            return base
        if resolution.method.startswith("deterministic_implication") and value is False:
            # "Authorized without restriction = No" does not tell us whether
            # the user is authorized with restrictions. Only the affirmative
            # direction is a valid logical implication.
            base.status = "requires_confirmation"
            base.reason_code = "non_equivalent_negative_requires_confirmation"
            return base
        return _select_boolean(base, value, labels, by_label, spec, "saved_profile")

    # ---------------------------------------------------------- job source --
    if key == "source_where_heard_about_job":
        label, reason = map_job_source_option(source_category, labels)
        if label is None:
            base.status = "missing"
            base.reason_code = reason
            return base
        base.status = "resolved"
        base.selected_option_ref = by_label[label]
        base.safe_source = "saved_profile"
        base.confidence = 0.9
        base.reason_code = reason
        return base

    # Recognised, but this task does not resolve it yet.
    base.status = "unsupported"
    base.reason_code = "canonical_key_not_wired"
    return base


def _select_boolean(
    base: QuestionResult,
    value: bool,
    labels: list[str],
    by_label: dict[str, str],
    spec,
    safe_source: str,
) -> QuestionResult:
    """Preserve a verified boolean, then map it to a reported option when possible.

    A closed custom dropdown often has no option DOM before it is opened. In
    that case the semantic answer remains resolved and the extension receives
    the canonical Yes/No display answer to use when the actuator opens the
    control. When options were submitted, the option reference is still looked
    up only from that submitted set.
    """
    base.typed_answer = value
    base.display_answer = "Yes" if value else "No"
    if not base.source_values:
        base.source_values = (value,)
    base.safe_source = safe_source
    base.confidence = 1.0

    if not labels:
        base.status = "resolved"
        base.reason_code = "answer_resolved_options_unavailable"
        return base

    label, reason = map_boolean_option(value, labels, spec)
    if label is None:
        # "qualified_option_requires_review" and "ambiguous_option" are genuine
        # ambiguity; a plain miss is unresolved. Neither is ever approximated.
        base.status = (
            "ambiguous"
            if reason in {"qualified_option_requires_review", "ambiguous_option"}
            else "missing"
        )
        base.reason_code = reason
        return base
    base.status = "resolved"
    base.selected_option_ref = by_label[label]
    base.reason_code = reason
    return base
