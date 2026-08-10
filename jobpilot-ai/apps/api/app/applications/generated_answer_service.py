"""Generate editable, job-specific written application answers.

The extension remains the only component that touches employer-page controls.
This service prepares a grounded draft using the configured OpenAI GPT model;
the extension inserts it and marks it for review, and never submits it.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.ai.provider import ai_provider


async def generate_written_application_answers(
    *,
    profile_payload: dict[str, Any],
    job_payload: dict[str, Any],
) -> list[dict[str, Any]]:
    company = _text(job_payload.get("company")) or "the company"
    title = _text(job_payload.get("title")) or "this role"
    payload = {
        "questions": [
            {
                "canonical_key": "custom_motivation",
                "question": f"Why are you interested in {company}?",
            }
        ],
        "job": {
            "company": company,
            "title": title,
            "description": _text(
                job_payload.get("description_clean")
                or job_payload.get("description_raw")
            )[:7000],
            "responsibilities": _string_list(job_payload.get("responsibilities"))[:10],
            "required_skills": _string_list(job_payload.get("required_skills"))[:15],
            "preferred_skills": _string_list(job_payload.get("preferred_skills"))[:12],
        },
        # Send only career facts needed to ground the response. Contact details,
        # work authorization, demographics, and other unrelated PII stay out.
        "candidate": _career_facts(profile_payload),
        "constraints": {
            "word_count": "200-260",
            "tone": "natural, specific, concise, first-person",
            "must_be_editable": True,
            "do_not_invent": True,
        },
    }
    payload["grounding_sources"] = _grounding_sources(payload)
    result = await ai_provider.json_task("application_answers.md", payload, smart=True)
    answer, claims, missing, unverified = _extract_grounded_answer(
        result.data, "custom_motivation", payload["grounding_sources"]
    )
    ai_accepted = bool(
        result.ai_used
        and answer
        and not unverified
        and not _contains_unsupported_specificity(answer, payload)
    )
    if not ai_accepted:
        answer, claims, missing = _local_motivation(payload)
        unverified = False
    if not answer:
        return []
    return [
        {
            "canonical_key": "custom_motivation",
            "value": answer,
            "display_value": answer,
            "source": (
                f"openai:{result.model_used}"
                if ai_accepted
                else "grounded_template"
            ),
            "confidence": 0.9 if result.ai_used else 0.82,
            "sensitive": False,
            # It is intentionally inserted into the page but remains an
            # editable review item; generated prose is never auto-submitted.
            "requires_review": True,
            "verified": False,
            "claims_used": claims,
            "missing_information": missing,
            "contains_unverified_claim": unverified,
        }
    ]


def _career_facts(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}
    return {
        "target_roles": _string_list(profile.get("target_roles"))[:8],
        "skills": _string_list(profile.get("skills"))[:24],
        "experience": [
            _only(item, "company", "title", "bullets", "technologies")
            for item in _dict_list(payload.get("experience"))[:5]
        ],
        "projects": [
            _only(item, "name", "bullets", "technologies")
            for item in _dict_list(payload.get("projects"))[:5]
        ],
        "education": [
            _only(item, "school", "degree", "major")
            for item in _dict_list(payload.get("education"))[:3]
        ],
    }


def _only(item: dict[str, Any], *keys: str) -> dict[str, Any]:
    return {
        key: value
        for key in keys
        if (value := item.get(key)) not in (None, "", [])
    }


def _extract_grounded_answer(
    data: dict[str, Any], key: str, sources: list[dict[str, str]]
) -> tuple[str, list[dict[str, str]], list[str], bool]:
    answers = data.get("answers")
    value: Any = None
    if isinstance(answers, dict):
        value = answers.get(key)
        if isinstance(value, dict):
            record = value
            value = record.get("answer") or record.get("value")
        else:
            record = None
    elif isinstance(answers, list):
        record = None
        for item in answers:
            if not isinstance(item, dict):
                continue
            if item.get("canonical_key") == key:
                value = item.get("answer") or item.get("value")
                record = item
                break
    else:
        record = None

    answer = _clean_generated_text(value)
    if not isinstance(record, dict):
        return answer, [], ["grounding_metadata"], True

    source_index = {item["sourceId"]: item for item in sources}
    claims: list[dict[str, str]] = []
    invalid = bool(record.get("containsUnverifiedClaim"))
    raw_claims = record.get("claimsUsed")
    if not isinstance(raw_claims, list) or not raw_claims:
        invalid = True
    else:
        for item in raw_claims:
            if not isinstance(item, dict):
                invalid = True
                continue
            source_id = _text(item.get("sourceId"))
            claim = _text(item.get("claim"))
            source = _text(item.get("source"))
            known = source_index.get(source_id)
            if (
                not known
                or source not in {"profile", "resume", "job_description", "company_context"}
                or known["source"] != source
                or not claim
                or _normalize_claim(claim) != _normalize_claim(known["claim"])
            ):
                invalid = True
                continue
            claims.append({"claim": claim, "source": source, "sourceId": source_id})
    missing = [_text(item) for item in record.get("missingInformation", []) if _text(item)] \
        if isinstance(record.get("missingInformation"), list) else []
    return answer, claims, missing, invalid


def _clean_generated_text(value: Any) -> str:
    text = _text(value)
    text = re.sub(r"^```(?:text|markdown)?\s*|\s*```$", "", text, flags=re.I)
    text = re.sub(r"^\s*(?:answer|response)\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:3000].strip()


def _local_motivation(
    payload: dict[str, Any]
) -> tuple[str, list[dict[str, str]], list[str]]:
    """Grounded fallback for development or a temporary provider outage."""
    job = payload.get("job") or {}
    company = _text(job.get("company")) or "the company"
    title = _text(job.get("title")) or "this role"
    sources = payload.get("grounding_sources") or []
    candidate_sources = [item for item in sources if item.get("source") in {"profile", "resume"}]
    job_sources = [
        item for item in sources
        if item.get("source") == "job_description"
        and str(item.get("sourceId", "")).startswith("job_description.requirement.")
    ]
    used = (candidate_sources[:2] + job_sources[:1])
    if not candidate_sources:
        return "", [], ["confirmed candidate experience"]
    candidate_fact = candidate_sources[0]["claim"]
    job_fact = job_sources[0]["claim"] if job_sources else f"the {title} role"
    answer = (
        f"The {title} role at {company} is relevant to my confirmed background: "
        f"{candidate_fact}. The role description highlights {job_fact}. "
        "I would use that documented experience to contribute to the work while "
        "learning the team's specific systems and priorities."
    )
    claims = [
        {"claim": item["claim"], "source": item["source"], "sourceId": item["sourceId"]}
        for item in used
    ]
    missing = [] if job_sources else ["specific job responsibilities"]
    return answer, claims, missing


def _grounding_sources(payload: dict[str, Any]) -> list[dict[str, str]]:
    candidate = payload.get("candidate") or {}
    job = payload.get("job") or {}
    sources: list[dict[str, str]] = []
    if company := _text(job.get("company")):
        sources.append({
            "sourceId": "company_context.company", "source": "company_context", "claim": company
        })
    if title := _text(job.get("title")):
        sources.append({
            "sourceId": "job_description.title", "source": "job_description", "claim": title
        })
    for index, skill in enumerate(_string_list(candidate.get("skills"))):
        sources.append({"sourceId": f"profile.skill.{index}", "source": "profile", "claim": skill})
    for index, item in enumerate(_dict_list(candidate.get("experience"))):
        title = _text(item.get("title"))
        company = _text(item.get("company"))
        if title or company:
            sources.append({
                "sourceId": f"resume.experience.{index}", "source": "resume",
                "claim": " at ".join(value for value in (title, company) if value),
            })
    for index, item in enumerate(_dict_list(candidate.get("projects"))):
        if name := _text(item.get("name")):
            sources.append(
                {"sourceId": f"resume.project.{index}", "source": "resume", "claim": name}
            )
    responsibilities = _string_list(job.get("responsibilities"))
    required = _string_list(job.get("required_skills"))
    for index, claim in enumerate((responsibilities + required)[:12]):
        sources.append({
            "sourceId": f"job_description.requirement.{index}",
            "source": "job_description",
            "claim": claim,
        })
    return sources


def _normalize_claim(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def _contains_unsupported_specificity(answer: str, payload: dict[str, Any]) -> bool:
    """Reject common high-risk hallucination shapes unless present in sources."""
    corpus = json.dumps(payload.get("grounding_sources") or [], ensure_ascii=False).lower()
    risky = (
        r"\b\d+\+?\s+years?\b",
        r"\b\d+(?:\.\d+)?%\b",
        r"\$\s?\d[\d,]*(?:\.\d+)?\b",
        r"\b(?:led|managed|supervised)\b",
        r"\b(?:bachelor'?s|master'?s|ph\.?d\.?|certified|certification)\b",
    )
    for pattern in risky:
        for match in re.finditer(pattern, answer, flags=re.IGNORECASE):
            if match.group(0).lower() not in corpus:
                return True
    # Proper-name/technology-shaped tokens must occur in a grounding source.
    # This intentionally fails closed; a false positive uses the grounded local
    # draft, while a false negative could put an invented technology on an
    # application.
    harmless = {"i", "the", "this", "that", "my", "our"}
    for token in re.findall(r"\b[A-Z][A-Za-z0-9+#.-]{2,}\b", answer):
        if token.lower() not in harmless and token.lower() not in corpus:
            return True
    return False


def _dict_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [_text(item) for item in value if _text(item)]


def _text(value: Any) -> str:
    return str(value or "").strip()
