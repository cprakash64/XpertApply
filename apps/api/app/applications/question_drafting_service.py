# ruff: noqa: E501
"""Draft grounded, editable answers to open-ended employer questions.

The extension sends only what it can see (a question, its input kind and length
limit). Who the candidate is and which job this is come from the authenticated
session, never from the request. The model is called server-side with a bounded
slice of career facts, and its output is VALIDATED here in code: it may only cite
sources we supplied, may not introduce unsupported specifics, and never produces
an answer to a legal, consent, compensation, authorization or demographic
question. A draft is never "verified"; it always requires the applicant's review.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

from app.ai.provider import ai_provider
from app.applications.generated_answer_service import (
    _contains_unsupported_specificity,
    _dict_list,
    _normalize_claim,
    _string_list,
    _text,
)
from app.core.config import settings

logger = logging.getLogger("jobpilot.question_drafting")

MAX_QUESTIONS = 8
MODEL_TIMEOUT_SECONDS = 30.0
MIN_LIMIT = 40
DEFAULT_LIMIT = 1500

# Answers the applicant alone may give. The model never originates these.
_USER_ONLY = re.compile(
    r"sponsor|visa|work(?:ing)?\s+authori[sz]|authori[sz]ed\s+to\s+work|right\s+to\s+work|"
    r"salary|compensation|pay\s+expect|expected\s+pay|desired\s+pay|"
    r"relocat|notice\s+period|start\s+date|when\s+can\s+you\s+start|availab|"
    r"gender|race|ethnic|veteran|disabilit|pronoun|sexual|religio|"
    r"criminal|convict|felony|background\s+check|"
    r"consent|agree|acknowledg|certify|attest|declar|privacy|terms|"
    r"citizen|nationalit|date\s+of\s+birth|social\s+security|"
    r"non-?compete|conflict\s+of\s+interest|previously\s+(?:worked|employed|applied)",
    re.I,
)
_LINK_FIELD = re.compile(r"\b(?:github|linkedin|portfolio|website|personal\s+site|url|link|twitter|x\.com)\b", re.I)
_URL_OR_CONTACT = re.compile(r"https?://|www\.|[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{8,}\d", re.I)


class DraftingDisabledError(RuntimeError):
    """Raised when answer drafting is invoked while APPLICATION_ANSWER_DRAFTING_ENABLED is off."""


def drafting_enabled() -> bool:
    return settings.application_answer_drafting_enabled is True


@dataclass(frozen=True)
class DraftQuestion:
    field_identifier: str
    question: str
    control_type: str = "textarea"
    max_length: int | None = None
    required: bool = False


def classify_question(question: DraftQuestion) -> str | None:
    """None when the question may be drafted, else the reason it may not."""
    text = question.question
    if _USER_ONLY.search(text):
        return "needs_user_answer"
    if question.control_type not in {"textarea", "text"}:
        return "not_drafted"
    if _LINK_FIELD.search(text) and len(text) < 80:
        return "not_drafted"
    return None


def grounding_sources(profile_payload: dict[str, Any], job_payload: dict[str, Any]) -> list[dict[str, str]]:
    """Every fact the model may rely on, each with an id it must cite."""
    sources: list[dict[str, str]] = []

    def add(source_id: str, source: str, claim: str) -> None:
        claim = _text(claim)
        if claim:
            sources.append({"sourceId": source_id, "source": source, "claim": claim[:600]})

    profile = profile_payload.get("profile") if isinstance(profile_payload.get("profile"), dict) else {}
    for index, skill in enumerate(_string_list(profile.get("skills"))[:30]):
        add(f"profile.skill.{index}", "profile", skill)
    for index, item in enumerate(_dict_list(profile_payload.get("experience"))[:6]):
        title, company = _text(item.get("title")), _text(item.get("company"))
        if title or company:
            add(f"resume.experience.{index}", "resume", " at ".join(v for v in (title, company) if v))
        for b_index, bullet in enumerate(_string_list(item.get("bullets"))[:8]):
            add(f"resume.experience.{index}.bullet.{b_index}", "resume", bullet)
        if techs := _string_list(item.get("technologies")):
            add(f"resume.experience.{index}.technologies", "resume", ", ".join(techs[:20]))
    for index, item in enumerate(_dict_list(profile_payload.get("projects"))[:6]):
        if name := _text(item.get("name")):
            add(f"resume.project.{index}", "resume", name)
        for b_index, bullet in enumerate(_string_list(item.get("bullets"))[:8]):
            add(f"resume.project.{index}.bullet.{b_index}", "resume", bullet)
        if techs := _string_list(item.get("technologies")):
            add(f"resume.project.{index}.technologies", "resume", ", ".join(techs[:20]))
    for index, item in enumerate(_dict_list(profile_payload.get("education"))[:3]):
        parts = [_text(item.get(k)) for k in ("degree", "major", "school")]
        add(f"resume.education.{index}", "resume", " ".join(p for p in parts if p))
    add("company_context.company", "company_context", _text(job_payload.get("company")))
    add("job_description.title", "job_description", _text(job_payload.get("title")))
    for index, claim in enumerate(
        (_string_list(job_payload.get("responsibilities")) + _string_list(job_payload.get("required_skills")))[:12]
    ):
        add(f"job_description.requirement.{index}", "job_description", claim)
    return sources


def _limit(question: DraftQuestion) -> int:
    value = question.max_length or (240 if question.control_type == "text" else DEFAULT_LIMIT)
    return max(MIN_LIMIT, min(int(value), 4000))


def _fit(answer: str, limit: int) -> str:
    if len(answer) <= limit:
        return answer
    cut = answer[:limit]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "), cut.rfind("."))
    return cut[: end + 1].strip() if end >= limit * 0.4 else ""


def _result(question: DraftQuestion, status: str, **extra: Any) -> dict[str, Any]:
    return {
        "field_identifier": question.field_identifier,
        "proposed_answer": "",
        "evidence_references": [],
        "requires_user_review": True,
        "missing_information": [],
        "generation_status": status,
        "verified": False,
        **extra,
    }


def _validate(
    question: DraftQuestion, record: dict[str, Any] | None, sources: list[dict[str, str]], model: str
) -> dict[str, Any]:
    if not isinstance(record, dict):
        return _result(question, "invalid_response")
    index = {item["sourceId"]: item for item in sources}
    refs: list[dict[str, str]] = []
    for ref in record.get("evidence_references") if isinstance(record.get("evidence_references"), list) else []:
        if not isinstance(ref, dict):
            return _result(question, "invalid_response")
        known = index.get(_text(ref.get("sourceId")))
        if not known or _normalize_claim(_text(ref.get("claim"))) != _normalize_claim(known["claim"]):
            return _result(question, "invalid_response")  # an invented or altered source invalidates the whole draft
        refs.append({"sourceId": known["sourceId"], "claim": known["claim"], "source": known["source"]})
    missing = (
        [_text(m)[:200] for m in record.get("missing_information", []) if _text(m)][:6]
        if isinstance(record.get("missing_information"), list)
        else []
    )
    status = _text(record.get("generation_status"))
    # Paragraph breaks are kept (a technical answer is often two or three paragraphs); runs of spaces and 3+ newlines are normalised.
    answer = re.sub(
        r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", re.sub(r"[ \t]*\n[ \t]*", "\n", _text(record.get("proposed_answer"))))
    ).strip()
    if status == "insufficient_evidence" or not answer:
        return _result(question, "insufficient_evidence", missing_information=missing or ["evidence for this question"])
    if status not in {"drafted", "partial"}:
        return _result(question, "invalid_response")
    # A draft about the candidate must rest on at least one fact about the candidate, not on the job posting alone.
    if not any(r["source"] in {"profile", "resume"} for r in refs):
        return _result(question, "insufficient_evidence", missing_information=missing or ["evidence for this question"])
    if _URL_OR_CONTACT.search(answer):
        return _result(question, "invalid_response")
    if _contains_unsupported_specificity(answer, {"grounding_sources": sources}):
        return _result(question, "invalid_response")
    fitted = _fit(answer, _limit(question))
    if not fitted:
        return _result(
            question, "invalid_response", missing_information=["a shorter answer for this field's length limit"]
        )
    return _result(
        question,
        "partial" if (status == "partial" or missing) else "drafted",
        proposed_answer=fitted,
        evidence_references=refs,
        missing_information=missing,
        source=f"openai:{model}",
    )


async def draft_answers(
    *, questions: list[DraftQuestion], profile_payload: dict[str, Any], job_payload: dict[str, Any]
) -> list[dict[str, Any]]:
    # Defense in depth: the route gates first, but a direct caller must not reach the provider either.
    if not drafting_enabled():
        raise DraftingDisabledError("application answer drafting is disabled")
    results: dict[str, dict[str, Any]] = {}
    eligible: list[DraftQuestion] = []
    for question in questions[:MAX_QUESTIONS]:
        reason = classify_question(question)
        if reason:
            results[question.field_identifier] = _result(question, reason)
        else:
            eligible.append(question)
    sources = grounding_sources(profile_payload, job_payload)
    if eligible and not any(s["source"] in {"profile", "resume"} for s in sources):
        for question in eligible:
            results[question.field_identifier] = _result(
                question, "insufficient_evidence", missing_information=["saved experience, projects or skills"]
            )
        eligible = []
    if eligible:
        payload = {
            "job": {"company": _text(job_payload.get("company")), "title": _text(job_payload.get("title"))},
            "questions": [
                {"field_identifier": q.field_identifier, "question": q.question[:600], "max_length": _limit(q)}
                for q in eligible
            ],
            # Career facts only: contact details, authorization, demographics and credentials are never included.
            "grounding_sources": sources,
        }
        try:
            outcome = await asyncio.wait_for(
                ai_provider.json_task("question_answers.md", payload, smart=True), MODEL_TIMEOUT_SECONDS
            )
        except Exception as exc:  # noqa: BLE001 - sanitized, never logs inputs or outputs
            logger.warning("question drafting failed reason=%s", type(exc).__name__)
            outcome = None
        if outcome is None or not outcome.ai_used:
            for question in eligible:
                results[question.field_identifier] = _result(question, "unavailable")
        else:
            by_id = {
                _text(item.get("field_identifier")): item
                for item in (outcome.data.get("answers") if isinstance(outcome.data.get("answers"), list) else [])
                if isinstance(item, dict)
            }
            for question in eligible:
                results[question.field_identifier] = _validate(
                    question, by_id.get(question.field_identifier), sources, outcome.model_used
                )
    return [results[q.field_identifier] for q in questions[:MAX_QUESTIONS]]
