"""Public-web people discovery via the OpenAI Responses API web-search tool.

This is **not** a people database and must never be presented as one. It is a
bounded, off-by-default last resort for companies that PDL and Apollo cannot
answer, and every candidate it produces is:

* required to cite a public source URL that the model actually retrieved,
* required to carry current-employment evidence at the exact hiring company,
* rejected outright if its LinkedIn URL is not a real, cited, HTTPS
  ``linkedin.com/in/`` profile — a URL is never constructed from a name,
* never given an email address, inferred or otherwise,
* marked ``public_web_discovered`` so downstream employment validation treats it
  as unverified.

The model is asked to *report what it found*, never to reason about who probably
works somewhere. Anything it asserts without a citation is dropped here.

Nothing in this module fetches a web page itself: the OpenAI hosted tool does
the retrieval, so XpertApply never touches authenticated pages, robots-restricted
paths, or anything behind a login or CAPTCHA.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlparse

from app.core.config import settings
from app.people.observability import metric
from app.people.schemas import PeopleCategory, ProviderPerson

logger = logging.getLogger("jobpilot.people.openai_web")

PROVIDER_NAME = "openai_web"
OPENAI_WEB_ADAPTER_VERSION = "openai-web-discovery-v1"
# Identity-resolution contract. v2 adds resolution *from hints* — a masked
# surname plus a title and a company become search terms, and the public source
# must supply the complete identity. The model is never asked to fill in the
# hidden letters.
OPENAI_IDENTITY_VERSION = "openai-public-identity-v2"

# Public professional-profile hosts we will accept as a candidate's profile URL.
_LINKEDIN_HOSTS = ("linkedin.com",)

# Source URLs that can never count as evidence: authenticated surfaces, local
# addresses, and anything that is not plain public HTTPS.
_BLOCKED_SOURCE_HOSTS = frozenset(
    {
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "example.com",
        "example.org",
    }
)

_CATEGORY_TITLE_HINTS: dict[PeopleCategory, tuple[str, ...]] = {
    "likely_recruiter": (
        "recruiter",
        "technical recruiter",
        "talent acquisition",
        "talent partner",
        "university recruiter",
        "early careers recruiter",
    ),
    "potential_hiring_manager": (
        "engineering manager",
        "software engineering manager",
        "director of engineering",
        "engineering director",
        "head of engineering",
    ),
    "potential_referrer": (
        "engineer",
        "scientist",
        "developer",
        "analyst",
    ),
}

_REJECTION_REASONS = (
    "missing_source_url",
    "non_public_source",
    "unsupported_claim",
    "manufactured_linkedin_url",
    "uncorroborated_linkedin_url",
    "past_employment_only",
    "company_mismatch",
    "ambiguous_identity",
    "low_confidence",
    "missing_required_field",
    "email_supplied",
)


@dataclass
class WebDiscoveryOutcome:
    """What one public-web attempt produced, including why rows were dropped."""

    candidates: list[ProviderPerson] = field(default_factory=list)
    searches_used: int = 0
    rejected: dict[str, int] = field(default_factory=dict)
    failure_reason: str | None = None

    def reject(self, reason: str) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + 1
        metric(
            "people_openai_web_candidates_rejected_total",
            provider=PROVIDER_NAME,
            reason=reason,
        )


def _normalized(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _company_key(value: str) -> str:
    """Comparison form: lowercase alphanumerics, legal suffixes removed."""

    text = re.sub(r"[^a-z0-9 ]+", " ", _normalized(value).lower())
    text = re.sub(
        r"\b(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|sa|nv|ag|holdings|group)\b",
        " ",
        text,
    )
    return re.sub(r"\s+", "", text)


def safe_public_linkedin_url(value: object) -> str | None:
    """A real, cited LinkedIn profile URL, or nothing.

    Rejects every non-HTTPS scheme, every host outside LinkedIn, embedded
    credentials, and anything that is not an ``/in/`` profile path. A slug that
    is merely the person's name with no citation cannot reach this function —
    callers must confirm the URL appeared in a retrieved source first.
    """

    text = _normalized(value)
    if not text:
        return None
    try:
        parsed = urlparse(text)
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return None
    host = (parsed.hostname or "").lower().rstrip(".")
    if not any(
        host == candidate or host.endswith(f".{candidate}")
        for candidate in _LINKEDIN_HOSTS
    ):
        return None
    path = parsed.path.rstrip("/")
    if not path.lower().startswith("/in/") or len(path) <= len("/in/"):
        return None
    return f"https://{host}{path}"


def is_public_source_url(value: object) -> bool:
    """Whether a citation points at an ordinary public page."""

    text = _normalized(value)
    if not text:
        return False
    try:
        parsed = urlparse(text)
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host or host in _BLOCKED_SOURCE_HOSTS or host.endswith(".local"):
        return False
    # Authenticated LinkedIn surfaces are never a citation. Public profile and
    # public company pages are.
    lowered = text.lower()
    return not any(
        marker in lowered
        for marker in (
            "/feed/",
            "/messaging/",
            "linkedin.com/login",
            "/checkpoint/",
            "?authwall",
        )
    )


def _slugified_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _normalized(name).lower())


def _is_corroborated(linkedin_url: str, citations: set[str], evidence: str) -> bool:
    """Whether a retrieved source actually contained this profile URL.

    An LLM's easiest invention is to hyphenate a name into
    ``linkedin.com/in/first-last``. Real profile URLs also contain the person's
    name, so name-shape proves nothing either way — the only usable signal is
    whether the URL appeared in something the tool actually retrieved. An
    uncorroborated URL is dropped; the person, whose identity rests on the cited
    page rather than on the link, is kept without one.
    """

    slug = linkedin_url.rsplit("/in/", 1)[-1].strip("/").lower()
    if not slug:
        return False
    for citation in citations:
        lowered = citation.lower()
        if slug in lowered and "/in/" in lowered:
            return True
    return slug in (evidence or "").lower()


def _evidence_mentions_company(text: str, company: str, aliases: tuple[str, ...]) -> bool:
    haystack = _company_key(text)
    if not haystack:
        return False
    keys = [_company_key(company), *[_company_key(alias) for alias in aliases]]
    return any(key and key in haystack for key in keys)


_PAST_EMPLOYMENT_MARKERS = (
    "former",
    "formerly",
    "ex-",
    "previously",
    "until 20",
    "left the company",
    "alumni",
    "past employee",
)


def _describes_past_employment(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _PAST_EMPLOYMENT_MARKERS)


def build_search_plan(
    *,
    company_name: str,
    categories: tuple[PeopleCategory, ...],
    max_searches: int,
) -> list[str]:
    """Focused public-web queries, capped by configuration.

    Only the categories the earlier providers left empty are searched, so the
    fallback fills gaps rather than repeating work that already succeeded.
    """

    quoted = f'"{company_name}"'
    plan: list[str] = []
    for category in categories:
        if category == "likely_recruiter":
            plan.append(f"site:linkedin.com/in {quoted} recruiter OR \"talent acquisition\"")
        elif category == "potential_hiring_manager":
            plan.append(
                f"site:linkedin.com/in {quoted} "
                '"engineering manager" OR "director of engineering"'
            )
        else:
            plan.append(f"site:linkedin.com/in {quoted} engineer OR scientist")
    return plan[: max(0, max_searches)]


_INSTRUCTIONS = """\
You are a retrieval reporter for a job-search product. Use the web_search tool to \
find PUBLIC professional profiles of people who CURRENTLY work at the named company.

Absolute rules:
- Report only what a retrieved page actually says. Never infer, guess, or complete \
a fact from your own knowledge.
- Every candidate MUST include the exact source URL you retrieved it from, and a \
short verbatim excerpt from that page supporting the current employment.
- Include a linkedin_url ONLY if that exact URL appeared in a retrieved result. \
Never construct one from a person's name. If you did not see the URL, use null.
- Never include an email address, phone number, or home location. Omit them entirely.
- Reject anyone whose evidence shows they only worked there in the past.
- Reject anyone whose current employer is a different company, including parents \
and subsidiaries, unless the page states the exact company named below.
- Reject a name so common that the page does not clearly identify one individual.
- confidence is your calibrated 0-1 certainty that this specific person currently \
holds this title at this exact company, based only on the cited page.
- If you find nobody who satisfies these rules, return an empty candidates list. \
An empty result is correct and expected; an invented one is a serious failure.

Return JSON only, shaped as:
{"candidates": [{"full_name": str, "current_title": str, "current_company": str, \
"category": "likely_recruiter"|"potential_hiring_manager"|"potential_referrer", \
"linkedin_url": str|null, "source_url": str, "source_title": str, \
"evidence_excerpt": str, "confidence": number}]}
"""


class OpenAIWebPeopleProvider:
    """Bounded public-web discovery. Disabled unless explicitly configured."""

    provider_name = PROVIDER_NAME

    def __init__(self, client: object | None = None) -> None:
        self._client = client
        self.last_search_raw_count = 0
        self.last_search_normalized_count = 0

    @staticmethod
    def configured() -> bool:
        return bool(
            settings.people_openai_web_discovery_enabled
            and (settings.openai_api_key or "").strip()
        )

    async def _respond(self, prompt: str) -> str:
        """One Responses API call with the hosted web-search tool.

        The client is injected in tests; nothing here runs without an API key,
        so an unconfigured deployment can never make a paid call.
        """

        client = self._client
        if client is None:  # pragma: no cover - exercised only with real creds
            from openai import AsyncOpenAI

            client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                timeout=settings.people_openai_web_timeout_seconds,
            )
        response = await client.responses.create(  # type: ignore[union-attr]
            model=settings.people_openai_web_model,
            tools=[{"type": "web_search"}],
            instructions=_INSTRUCTIONS,
            input=prompt,
        )
        return _response_text(response)

    async def discover(
        self,
        *,
        company_name: str,
        company_aliases: tuple[str, ...] = (),
        company_domain: str | None = None,
        categories: tuple[PeopleCategory, ...],
        allow_related_company: bool = False,
    ) -> WebDiscoveryOutcome:
        outcome = WebDiscoveryOutcome()
        if not self.configured() or not categories:
            outcome.failure_reason = "provider_not_configured"
            return outcome

        plan = build_search_plan(
            company_name=company_name,
            categories=categories,
            max_searches=settings.people_openai_web_max_searches_per_discovery,
        )
        if not plan:
            outcome.failure_reason = "provider_not_configured"
            return outcome

        prompt = json.dumps(
            {
                "company_name": company_name,
                "company_domain": company_domain,
                "categories": list(categories),
                "suggested_queries": plan,
                "max_candidates": settings.people_openai_web_max_candidates,
            }
        )
        try:
            raw = await self._respond(prompt)
        except Exception as exc:  # noqa: BLE001 - classified, never re-raised
            # The message may echo request content, so only the type is logged.
            logger.warning(
                "people_openai_web call failed error_type=%s", type(exc).__name__
            )
            outcome.failure_reason = "provider_unavailable"
            return outcome

        outcome.searches_used = len(plan)
        rows = _parse_candidates(raw)
        self.last_search_raw_count = len(rows)
        outcome.candidates = self._validate_rows(
            rows,
            company_name=company_name,
            company_aliases=company_aliases,
            company_domain=company_domain,
            categories=categories,
            allow_related_company=allow_related_company,
            outcome=outcome,
        )
        self.last_search_normalized_count = len(outcome.candidates)
        return outcome

    def _validate_rows(
        self,
        rows: list[dict],
        *,
        company_name: str,
        company_aliases: tuple[str, ...],
        company_domain: str | None,
        categories: tuple[PeopleCategory, ...],
        allow_related_company: bool,
        outcome: WebDiscoveryOutcome,
    ) -> list[ProviderPerson]:
        accepted: list[ProviderPerson] = []
        citations = {
            _normalized(row.get("source_url"))
            for row in rows
            if is_public_source_url(row.get("source_url"))
        }
        seen: set[str] = set()
        threshold = float(settings.people_openai_web_min_confidence)

        for row in rows:
            if len(accepted) >= int(settings.people_openai_web_max_candidates):
                break
            if not isinstance(row, dict):
                outcome.reject("missing_required_field")
                continue

            full_name = _normalized(row.get("full_name"))
            title = _normalized(row.get("current_title"))
            company = _normalized(row.get("current_company"))
            category = _normalized(row.get("category"))
            source_url = _normalized(row.get("source_url"))
            source_title = _normalized(row.get("source_title"))
            excerpt = _normalized(row.get("evidence_excerpt"))

            if not (full_name and title and company and excerpt):
                outcome.reject("missing_required_field")
                continue
            if category not in categories:
                outcome.reject("company_mismatch" if category else "missing_required_field")
                continue
            # An address the model volunteered is discarded outright: this
            # provider is never a source of contact details.
            if any(key in row for key in ("email", "professional_email", "phone")):
                outcome.reject("email_supplied")
                continue
            if not source_url:
                outcome.reject("missing_source_url")
                continue
            if not is_public_source_url(source_url):
                outcome.reject("non_public_source")
                continue

            try:
                confidence = float(row.get("confidence"))
            except (TypeError, ValueError):
                outcome.reject("low_confidence")
                continue
            if confidence < threshold:
                outcome.reject("low_confidence")
                continue

            # The excerpt is the whole basis for the claim. It must name the
            # company, and it must not describe a job the person used to hold.
            if not _evidence_mentions_company(excerpt, company_name, company_aliases):
                outcome.reject("unsupported_claim")
                continue
            if _describes_past_employment(excerpt):
                outcome.reject("past_employment_only")
                continue
            exact_company = _evidence_mentions_company(company, company_name, company_aliases)
            if not exact_company and not allow_related_company:
                outcome.reject("company_mismatch")
                continue

            # A structurally unsafe URL is a fabrication attempt and costs the
            # whole row; a merely uncorroborated one costs only the link.
            linkedin_url = safe_public_linkedin_url(row.get("linkedin_url"))
            if row.get("linkedin_url") and not linkedin_url:
                outcome.reject("manufactured_linkedin_url")
                continue
            if linkedin_url and not _is_corroborated(linkedin_url, citations, excerpt):
                outcome.reject("uncorroborated_linkedin_url")
                linkedin_url = None

            identity = f"{_slugified_name(full_name)}|{_company_key(company)}"
            if identity in seen:
                outcome.reject("ambiguous_identity")
                continue
            # Two different people sharing a name in one result set means the
            # page did not identify an individual.
            same_name = sum(
                1
                for other in rows
                if _slugified_name(_normalized(other.get("full_name")))
                == _slugified_name(full_name)
            )
            if same_name > 1:
                outcome.reject("ambiguous_identity")
                continue
            seen.add(identity)

            observed = datetime.now(UTC)
            accepted.append(
                ProviderPerson(
                    provider=PROVIDER_NAME,
                    # Stable within a company so repeat runs converge on one row.
                    provider_person_id=f"web:{identity}",
                    full_name=full_name,
                    current_company_name=company,
                    current_company_domain=company_domain,
                    current_title=title,
                    linkedin_url=linkedin_url,
                    source_profile_url=source_url,
                    provider_record_observed_at=observed,
                    # Deliberately NOT employment_verified_at: a public page is
                    # not an employment verification.
                    employment_source="public_web_discovered",
                    exact_company_match=exact_company,
                    current_role_indicator=True,
                    evidence={
                        "discovery_source": "public_web_discovered",
                        "source_title": source_title,
                        "source_url": source_url,
                        "evidence_excerpt": excerpt[:400],
                        "confidence": round(confidence, 3),
                        "independently_verified": False,
                        "retrieved_at": observed.isoformat(),
                    },
                    field_provenance={
                        "full_name": "public_web",
                        "current_title": "public_web",
                        "current_company_name": "public_web",
                        **({"linkedin_url": "public_web_cited"} if linkedin_url else {}),
                    },
                    discovery_strategy=OPENAI_WEB_ADAPTER_VERSION,
                )
            )

        return accepted


def _response_text(response: object) -> str:
    """Pull the model's text out of a Responses API result.

    Tolerant of both the ``output_text`` convenience field and the structured
    output list, so a client stub in a test does not have to imitate the whole
    SDK object graph.
    """

    text = getattr(response, "output_text", None)
    if isinstance(text, str) and text.strip():
        return text
    chunks: list[str] = []
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            value = getattr(content, "text", None)
            if isinstance(value, str):
                chunks.append(value)
    return "\n".join(chunks)


def _parse_candidates(raw: str) -> list[dict]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1]
    try:
        data = json.loads(text or "{}")
    except json.JSONDecodeError:
        logger.warning("people_openai_web returned unparseable output")
        return []
    rows = data.get("candidates") if isinstance(data, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
