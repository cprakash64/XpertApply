"""Bright Data: profile **verification**, on its documented collect-by-URL API.

Contract verified against Bright Data's official documentation:

* Auth — ``Authorization: Bearer <token>``.
* Verify — ``POST /datasets/v3/scrape?dataset_id=…&format=json`` with a JSON
  array of ``{"url": …}``. Synchronous, documented at up to 20 URLs and 10–30 s.
* Returned fields — ``name, url, position, current_company{name,link}, city,
  country_code, experience, education``.

**There is no discovery here, deliberately.** An earlier revision built a
``type=discover_new&discover_by=keyword`` request whose input shape was guessed:
Bright Data publishes ``keyword|location|category_url|best_sellers_url`` as the
discovery vocabulary but does not document the input field names for a people
search by company and title, nor the discovery dataset id, nor the per-record
charge. That guessed request has been removed rather than left dormant — an
unverified request to a paid provider is not something to keep lying around.

Discovery is OpenAI's job now (public web search, citation-required), and Bright
Data's job is to confirm what OpenAI found against the real profile before any
of it reaches a user. Company/title discovery stays unavailable until either an
official contract for it or an Employee Data API integration exists.

Nothing in this module scrapes anything itself, holds a LinkedIn credential, or
retains a raw provider record.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.core.config import settings
from app.people.actionable import company_key
from app.people.errors import PeopleErrorCode
from app.people.observability import metric
from app.people.schemas import ProviderPerson
from app.people.security import safe_profile_url

logger = logging.getLogger("jobpilot.people.brightdata")

PROVIDER_NAME = "brightdata"
BRIGHTDATA_PROFILE_STRATEGY_VERSION = "brightdata-profile-discovery-v1"

_API_ROOT = "https://api.brightdata.com/datasets/v3"
# Documented ceiling for the synchronous /scrape endpoint.
_MAX_SYNC_URLS = 20

@dataclass
class BrightDataOutcome:
    """One Bright Data attempt, in the shape the waterfall consumes."""

    candidates: list[ProviderPerson] = field(default_factory=list)
    records_returned: int = 0
    calls: int = 0
    failure_reason: str | None = None
    warnings: list[str] = field(default_factory=list)
    rejected: dict[str, int] = field(default_factory=dict)

    def reject(self, reason: str) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + 1


def configured_for_verification() -> bool:
    return bool(
        (settings.brightdata_api_token or "").strip()
        and (settings.people_brightdata_dataset_id or "").strip()
    )


def verification_configuration_gap() -> str | None:
    """What an operator must still supply before verification can run.

    Returned verbatim as the typed skip detail, so "why was nothing verified?"
    is answerable from one log line.
    """

    if not settings.people_brightdata_verification_enabled:
        return "PEOPLE_BRIGHTDATA_VERIFICATION_ENABLED is false"
    if not (settings.brightdata_api_token or "").strip():
        return "BRIGHTDATA_API_TOKEN is not set"
    if not (settings.people_brightdata_dataset_id or "").strip():
        return (
            "PEOPLE_BRIGHTDATA_DATASET_ID is not set. This is the LinkedIn "
            "people-profiles collect-by-URL dataset used to verify a profile."
        )
    if int(settings.people_brightdata_max_records_per_discovery) <= 0:
        return "PEOPLE_BRIGHTDATA_MAX_RECORDS_PER_DISCOVERY is 0"
    return None


class BrightDataPeopleProvider:
    """Thin, typed client. Circuits, budgets and usage stay with the caller.

    Deliberately does not subclass the PDL/Apollo HTTP base: Bright Data's unit
    of cost is a *record*, not a request, and its async snapshot lifecycle has
    no analogue in the request/response providers. Sharing the base class would
    have meant mis-metering every call.
    """

    provider_name = PROVIDER_NAME

    def __init__(self, client: object | None = None) -> None:
        self._client = client
        self.last_records_returned = 0
        self.last_http_status: int | None = None

    def _headers(self) -> dict[str, str]:
        token = (settings.brightdata_api_token or "").strip()
        if not token:
            raise BrightDataUnavailable(
                "provider_not_configured", code=PeopleErrorCode.AUTHENTICATION_FAILED
            )
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, object] | None = None,
        json_body: object | None = None,
        timeout: float | None = None,
    ) -> object:
        import httpx

        headers = self._headers()
        limit = float(
            timeout
            if timeout is not None
            else settings.people_brightdata_timeout_seconds
        )
        client = self._client
        started = time.monotonic()
        try:
            if client is None:  # pragma: no cover - needs real credentials
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(limit), follow_redirects=False
                ) as owned:
                    response = await owned.request(
                        method, url, params=params, json=json_body, headers=headers
                    )
            else:
                response = await client.request(  # type: ignore[union-attr]
                    method, url, params=params, json=json_body, headers=headers
                )
        except httpx.TimeoutException as exc:
            raise BrightDataUnavailable(
                "provider_timeout", code=PeopleErrorCode.PROVIDER_TIMEOUT
            ) from exc
        except httpx.NetworkError as exc:
            raise BrightDataUnavailable(
                "provider_network_error", code=PeopleErrorCode.NETWORK_ERROR
            ) from exc
        duration_ms = (time.monotonic() - started) * 1000
        self.last_http_status = response.status_code
        _raise_for_status(response.status_code, duration_ms=duration_ms)
        if len(response.content) > settings.people_provider_response_max_bytes:
            raise BrightDataUnavailable(
                "provider_response_invalid", code=PeopleErrorCode.INVALID_INPUT
            )
        try:
            return response.json()
        except ValueError as exc:
            raise BrightDataUnavailable(
                "provider_response_invalid", code=PeopleErrorCode.INVALID_INPUT
            ) from exc

    # ------------------------------------------------------------------
    # Verification: the documented, synchronous path
    # ------------------------------------------------------------------

    async def verify_profiles(
        self,
        linkedin_urls: list[str],
        *,
        company_name: str,
        company_aliases: tuple[str, ...] = (),
        company_domain: str | None = None,
    ) -> BrightDataOutcome:
        """Fetch known LinkedIn profiles and normalize the ones we can trust.

        Only URLs that already passed :func:`safe_profile_url` are sent, so a
        constructed or malformed slug can never reach the provider — and never
        costs a record.
        """

        outcome = BrightDataOutcome()
        safe_urls: list[str] = []
        for value in linkedin_urls:
            url = safe_profile_url(value)
            if url is None:
                outcome.reject("invalid_linkedin_url")
                continue
            if url not in safe_urls:
                safe_urls.append(url)
        safe_urls = safe_urls[:_MAX_SYNC_URLS]
        if not safe_urls:
            return outcome
        if not configured_for_verification():
            outcome.failure_reason = "provider_not_configured"
            return outcome

        try:
            payload = await self._request(
                "POST",
                f"{_API_ROOT}/scrape",
                params={
                    "dataset_id": (settings.people_brightdata_dataset_id or "").strip(),
                    "format": "json",
                },
                json_body=[{"url": url} for url in safe_urls],
            )
        except BrightDataUnavailable as exc:
            outcome.failure_reason = exc.reason
            _log_failure(exc, operation="verify_profiles")
            return outcome
        outcome.calls = 1

        rows = _rows_from(payload)
        outcome.records_returned = len(rows)
        self.last_records_returned = len(rows)
        metric(
            "people_brightdata_records_returned",
            len(rows),
            provider=PROVIDER_NAME,
            stage="verify",
        )
        for row in rows:
            person = normalize_brightdata_profile(
                row,
                company_name=company_name,
                company_aliases=company_aliases,
                company_domain=company_domain,
                outcome=outcome,
            )
            if person is not None:
                outcome.candidates.append(person)
        return outcome

@dataclass
class VerificationResult:
    """What Bright Data could confirm about one candidate, and what it could not."""

    confirmed: list[ProviderPerson] = field(default_factory=list)
    rejected: dict[str, int] = field(default_factory=dict)
    failure_reason: str | None = None
    records_returned: int = 0
    calls: int = 0

    def reject(self, reason: str) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + 1


async def verify_candidates(
    candidates: list[ProviderPerson],
    *,
    company_name: str,
    company_aliases: tuple[str, ...] = (),
    company_domain: str | None = None,
    provider: BrightDataPeopleProvider | None = None,
) -> VerificationResult:
    """Confirm discovered profiles against the real LinkedIn record.

    OpenAI's public-web step finds a *cited* profile URL; it cannot confirm that
    the person still works there today, and it is not a data contract. This is
    the step that turns a sighting into evidence: Bright Data fetches each URL
    and the fields it returns — name, current employer, current title — replace
    whatever the discovering provider claimed.

    A candidate survives only when Bright Data confirms it. Anything the fetch
    does not cover is dropped with a typed reason, because "we could not check"
    and "we checked and it is true" must never look the same to a user.
    """

    result = VerificationResult()
    if not candidates:
        return result
    gap = verification_configuration_gap()
    if gap is not None:
        result.failure_reason = "provider_not_configured"
        return result

    client = provider or BrightDataPeopleProvider()
    by_url: dict[str, ProviderPerson] = {}
    for candidate in candidates:
        url = safe_profile_url(candidate.linkedin_url)
        if url is None:
            # Never verifiable, and never displayable: a discovered candidate
            # with no valid profile URL is dropped before a record is spent.
            result.reject("unverifiable_missing_linkedin_url")
            continue
        by_url.setdefault(url, candidate)

    outcome = await client.verify_profiles(
        list(by_url),
        company_name=company_name,
        company_aliases=company_aliases,
        company_domain=company_domain,
    )
    result.calls = outcome.calls
    result.records_returned = outcome.records_returned
    for reason, count in outcome.rejected.items():
        result.rejected[reason] = result.rejected.get(reason, 0) + count
    if outcome.failure_reason:
        result.failure_reason = outcome.failure_reason
        return result

    verified_by_url = {
        safe_profile_url(person.linkedin_url): person
        for person in outcome.candidates
        if person.linkedin_url
    }
    for url, discovered in by_url.items():
        confirmed = verified_by_url.get(url)
        if confirmed is None:
            # Bright Data returned nothing usable for this URL. The profile may
            # be gone, private, or never have matched — either way it is not
            # confirmed, so it is not shown.
            result.reject("verification_no_record")
            continue
        if not confirmed.current_company_domain:
            # normalize_brightdata_profile only attaches the verified domain on
            # an exact employer-name match, so an empty domain means the real
            # profile does not say what the discovering provider said.
            result.reject("verification_company_mismatch")
            continue
        result.confirmed.append(_merged(discovered, confirmed))
    return result


def _merged(discovered: ProviderPerson, confirmed: ProviderPerson) -> ProviderPerson:
    """Bright Data's record wins on every field it actually returned.

    The discovering provider keeps only its provenance — which sources it cited
    — because that is the one thing Bright Data cannot tell us and the one thing
    an operator needs to audit a public-web sighting.
    """

    merged = confirmed.model_copy(deep=True)
    citations = discovered.evidence.get("supporting_sources")
    merged.evidence = {
        **merged.evidence,
        "discovered_by": discovered.provider,
        "verified_by": PROVIDER_NAME,
        "verification_strategy": BRIGHTDATA_PROFILE_STRATEGY_VERSION,
        **({"supporting_sources": citations} if citations else {}),
    }
    merged.field_provenance = {
        **merged.field_provenance,
        "linkedin_url": f"{discovered.provider}->{PROVIDER_NAME}",
    }
    return merged


class BrightDataUnavailable(RuntimeError):
    """A typed Bright Data failure, in the project's shared reason vocabulary."""

    def __init__(
        self,
        reason: str,
        *,
        code: PeopleErrorCode,
        http_status: int | None = None,
        duration_ms: float | None = None,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code
        self.http_status = http_status
        self.duration_ms = duration_ms


def _raise_for_status(status_code: int, *, duration_ms: float) -> None:
    if status_code < 400:
        return
    reason, code = {
        400: ("provider_request_invalid", PeopleErrorCode.INVALID_INPUT),
        401: ("provider_unauthorized", PeopleErrorCode.AUTHENTICATION_FAILED),
        402: ("provider_budget_exceeded", PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED),
        403: ("provider_forbidden", PeopleErrorCode.AUTHORIZATION_FAILED),
        404: ("provider_route_invalid", PeopleErrorCode.INVALID_INPUT),
        422: ("provider_schema_error", PeopleErrorCode.INVALID_INPUT),
        429: ("provider_rate_limited", PeopleErrorCode.RATE_LIMITED),
    }.get(
        status_code,
        (
            ("provider_unavailable", PeopleErrorCode.PROVIDER_SERVER_ERROR)
            if status_code >= 500
            else ("provider_request_invalid", PeopleErrorCode.INVALID_INPUT)
        ),
    )
    raise BrightDataUnavailable(
        reason, code=code, http_status=status_code, duration_ms=duration_ms
    )


def _log_failure(exc: BrightDataUnavailable, *, operation: str) -> None:
    """One line per failure. Never a URL, a name, a record, or the token."""

    logger.warning(
        "people_provider_failure provider=%s operation=%s reason=%s error_code=%s "
        "http_status=%s strategy_version=%s",
        PROVIDER_NAME,
        operation,
        exc.reason,
        exc.code,
        exc.http_status if exc.http_status is not None else "none",
        BRIGHTDATA_PROFILE_STRATEGY_VERSION,
    )
    metric(
        "people_provider_requests_total",
        provider=PROVIDER_NAME,
        status="error",
        error_code=str(exc.code),
    )


def _rows_from(payload: object) -> list[dict]:
    """Bright Data returns a bare array for ``format=json``; be tolerant anyway."""

    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("data", "results", "records"):
            value = payload.get(key)
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
    return []


def _text(value: object) -> str:
    return " ".join(str(value or "").split())


def normalize_brightdata_profile(
    row: object,
    *,
    company_name: str,
    company_aliases: tuple[str, ...] = (),
    company_domain: str | None = None,
    outcome: BrightDataOutcome | None = None,
) -> ProviderPerson | None:
    """Map one Bright Data profile record onto the shared candidate shape.

    Two decisions worth stating, because both are places a looser adapter would
    manufacture confidence:

    **The company domain is not invented.** Bright Data returns a company
    *name* and a LinkedIn company *link*, never a website domain. The job's
    verified domain is attached only when the returned employer name matches the
    canonical name or a known alias exactly under :func:`company_key`. Anything
    weaker leaves the domain unset, and the actionable-contact policy then
    rejects the record as ``company_mismatch`` — which is the correct answer.

    **Only returned fields are mapped.** Nothing is derived from a name, and no
    field is defaulted to something plausible.
    """

    def _reject(reason: str) -> None:
        if outcome is not None:
            outcome.reject(reason)

    if not isinstance(row, dict):
        _reject("malformed_record")
        return None

    full_name = _text(row.get("name"))
    linkedin_url = safe_profile_url(_text(row.get("url")) or None)
    company_block = row.get("current_company")
    company_block = company_block if isinstance(company_block, dict) else {}
    employer = _text(company_block.get("name")) or _text(row.get("current_company_name"))
    title = (
        _text(row.get("position"))
        or _text(company_block.get("title"))
        or _text(row.get("current_company_title"))
    )

    if not full_name:
        _reject("missing_name")
        return None
    if linkedin_url is None:
        # Bright Data's own record for a profile always carries its URL; a row
        # without one is a malformed record, not a person without a profile.
        _reject("missing_linkedin_url")
        return None
    if not employer:
        _reject("missing_company")
        return None
    if not title:
        _reject("missing_title")
        return None

    canonical = company_key(company_name)
    alias_keys = {company_key(alias) for alias in company_aliases if alias}
    alias_keys.discard("")
    employer_key = company_key(employer)
    exact_employer = bool(employer_key) and (
        employer_key == canonical or employer_key in alias_keys
    )
    resolved_domain = company_domain if (exact_employer and company_domain) else None
    if not exact_employer:
        _reject("company_mismatch")

    location = _text(row.get("city")) or _text(row.get("location"))
    country = _text(row.get("country_code"))
    existing = {token.strip(",").lower() for token in location.split()}
    if location and country and country.lower() not in existing:
        location = f"{location}, {country}"

    observed_at = datetime.now(UTC)
    previous_employers = [
        _text(item.get("company"))
        for item in (row.get("experience") if isinstance(row.get("experience"), list) else [])
        if isinstance(item, dict)
        and _text(item.get("company"))
        and company_key(_text(item.get("company"))) != employer_key
    ]

    return ProviderPerson(
        provider=PROVIDER_NAME,
        # The profile URL is the stable identity Bright Data guarantees; the
        # numeric ids in its payloads are dataset-internal and not durable.
        provider_person_id=linkedin_url,
        full_name=full_name,
        current_company_name=employer,
        current_company_domain=resolved_domain,
        current_title=title,
        location=location or None,
        linkedin_url=linkedin_url,
        source_profile_url=linkedin_url,
        provider_record_observed_at=observed_at,
        provider_employment_updated_at=observed_at,
        # Bright Data reports what a public profile says today. That is credible
        # current employment, but it is not an independent verification, so no
        # employment_verified_at is claimed.
        employment_source="brightdata_public_profile",
        current_role_indicator=True,
        previous_employers=[value for value in previous_employers if value][:10],
        education=[
            _text(item.get("title"))
            for item in (
                row.get("education") if isinstance(row.get("education"), list) else []
            )
            if isinstance(item, dict) and _text(item.get("title"))
        ][:10],
        evidence={
            "employment_source": "brightdata_public_profile",
            "current_company_name": employer,
            "current_title": title,
            "exact_employer_name_match": exact_employer,
            "company_domain_evidence": (
                "job_verified_domain_on_exact_name_match" if resolved_domain else "none"
            ),
            "provider_record_observed_at": observed_at.isoformat(),
            "linkedin_url_source": "provider_record",
            "strategy_version": BRIGHTDATA_PROFILE_STRATEGY_VERSION,
        },
        field_provenance={
            "name": PROVIDER_NAME,
            "title": PROVIDER_NAME,
            "company": PROVIDER_NAME,
            "linkedin_url": PROVIDER_NAME,
        },
    )
