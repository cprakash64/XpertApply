"""Bright Data adapter: professional-profile verification, and (gated) discovery.

Contract verified against Bright Data's official documentation, not assumed:

* Auth — ``Authorization: Bearer <token>``.
* **Verify a known profile** — ``POST /datasets/v3/scrape?dataset_id=…&format=json``
  with a JSON array of ``{"url": …}``. Synchronous, documented at up to 20 URLs
  and 10–30 s. This is the path JobPilot uses on the request path.
* **Discover profiles** — ``POST /datasets/v3/trigger?dataset_id=…&type=discover_new
  &discover_by=…`` returns ``{"snapshot_id": "s_…"}``; poll
  ``GET /datasets/v3/progress/{snapshot_id}`` for ``starting|running|ready|failed``;
  download ``GET /datasets/v3/snapshot/{snapshot_id}?format=json``.

**Why discovery is gated off.** The lifecycle above is documented; the *input
schema for LinkedIn people discovery by company + title + location is not*. The
published ``discover_by`` vocabulary is ``keyword | location | category_url |
best_sellers_url``, and no official page documents the input field names for a
people search, nor the discovery dataset id, nor the per-record charge for a
discovery job. Rather than invent an adapter against a guessed contract, the
discovery step reports :class:`SkipReason.INVALID_CONFIGURATION` with a message
naming exactly what an operator must supply. The lifecycle code below is real,
tested against mocks, and becomes live the moment a discovery dataset id is
configured.

Nothing in this module scrapes anything itself, holds a LinkedIn credential, or
retains a raw provider record.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.core.config import settings
from app.people.actionable import company_key
from app.people.errors import PeopleErrorCode
from app.people.observability import metric
from app.people.schemas import PeopleCategory, ProviderPerson
from app.people.security import safe_profile_url

logger = logging.getLogger("jobpilot.people.brightdata")

PROVIDER_NAME = "brightdata"
BRIGHTDATA_PROFILE_STRATEGY_VERSION = "brightdata-profile-discovery-v1"

_API_ROOT = "https://api.brightdata.com/datasets/v3"
# Documented ceiling for the synchronous /scrape endpoint.
_MAX_SYNC_URLS = 20

# Snapshot states. Bright Data documents starting/running/ready/failed; the
# scrapers surface also reports collecting/digesting, so both vocabularies are
# accepted rather than treated as an unknown response.
_PENDING_STATES = frozenset({"starting", "running", "collecting", "digesting", "pending"})
_READY_STATES = frozenset({"ready"})
_FAILED_STATES = frozenset({"failed", "canceled", "cancelled", "error"})


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


def configured_for_discovery() -> bool:
    return bool(
        configured_for_verification()
        and (settings.people_brightdata_discovery_dataset_id or "").strip()
    )


def discovery_configuration_gap() -> str | None:
    """What an operator must still supply before discovery can run at all.

    Returned verbatim as the typed skip detail, so "why did Bright Data not
    run?" is answerable from one log line rather than from this docstring.
    """

    if not (settings.brightdata_api_token or "").strip():
        return "BRIGHTDATA_API_TOKEN is not set"
    if not (settings.people_brightdata_dataset_id or "").strip():
        return "PEOPLE_BRIGHTDATA_DATASET_ID is not set"
    if not (settings.people_brightdata_discovery_dataset_id or "").strip():
        return (
            "PEOPLE_BRIGHTDATA_DISCOVERY_DATASET_ID is not set. Bright Data's "
            "people-discovery input schema is account-specific and is not "
            "published; supply the discovery dataset id and confirm the query "
            "shape before enabling discovery"
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

    # ------------------------------------------------------------------
    # Discovery: real lifecycle, gated until the input contract is known
    # ------------------------------------------------------------------

    async def discover(
        self,
        inputs: list[dict[str, object]],
        *,
        discover_by: str,
        company_name: str,
        company_aliases: tuple[str, ...] = (),
        company_domain: str | None = None,
        categories: tuple[PeopleCategory, ...] = (),
    ) -> BrightDataOutcome:
        """Trigger an async discovery snapshot, poll it, and normalize results.

        Bounded on both axes: ``limit_per_input`` caps records (and therefore
        cost), and ``people_brightdata_max_poll_seconds`` caps the wait. A user
        request never waits on an unbounded collection job.
        """

        outcome = BrightDataOutcome()
        gap = discovery_configuration_gap()
        if gap is not None:
            outcome.failure_reason = "provider_not_configured"
            outcome.warnings.append("discovery_not_configured")
            return outcome
        if not inputs:
            return outcome

        max_records = max(1, int(settings.people_brightdata_max_records_per_discovery))
        try:
            triggered = await self._request(
                "POST",
                f"{_API_ROOT}/trigger",
                params={
                    "dataset_id": (
                        settings.people_brightdata_discovery_dataset_id or ""
                    ).strip(),
                    "type": "discover_new",
                    "discover_by": discover_by,
                    "limit_per_input": max_records,
                    "format": "json",
                },
                json_body=inputs,
            )
        except BrightDataUnavailable as exc:
            outcome.failure_reason = exc.reason
            _log_failure(exc, operation="discover_trigger")
            return outcome
        outcome.calls = 1

        snapshot_id = (
            str(triggered.get("snapshot_id") or "").strip()
            if isinstance(triggered, dict)
            else ""
        )
        if not snapshot_id:
            outcome.failure_reason = "provider_response_invalid"
            return outcome

        try:
            rows = await self._await_snapshot(snapshot_id)
        except BrightDataUnavailable as exc:
            outcome.failure_reason = exc.reason
            _log_failure(exc, operation="discover_snapshot")
            return outcome
        outcome.calls += 1

        rows = rows[:max_records]
        outcome.records_returned = len(rows)
        self.last_records_returned = len(rows)
        metric(
            "people_brightdata_records_returned",
            len(rows),
            provider=PROVIDER_NAME,
            stage="discover",
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

    async def _await_snapshot(self, snapshot_id: str) -> list[dict]:
        """Poll until ready, failed, or the wall clock says stop."""

        # Only guards against a zero/negative setting; startup validation
        # already requires a positive one. A 1.0s floor here would have
        # silently overridden every configured ceiling below a second.
        ceiling = max(0.001, float(settings.people_brightdata_max_poll_seconds))
        deadline = time.monotonic() + ceiling
        interval = max(0.001, float(settings.people_brightdata_poll_interval_seconds))
        # Two independent bounds. The wall clock protects the user's request;
        # the count protects against a provider that answers instantly and
        # forever, where a time-only bound would spin.
        max_polls = max(1, int(ceiling / interval) + 1)
        polls = 0
        while True:
            progress = await self._request(
                "GET", f"{_API_ROOT}/progress/{snapshot_id}"
            )
            polls += 1
            status = (
                str(progress.get("status") or "").strip().lower()
                if isinstance(progress, dict)
                else ""
            )
            if status in _READY_STATES:
                break
            if status in _FAILED_STATES:
                raise BrightDataUnavailable(
                    "provider_unavailable", code=PeopleErrorCode.PROVIDER_SERVER_ERROR
                )
            if status not in _PENDING_STATES:
                raise BrightDataUnavailable(
                    "provider_response_invalid", code=PeopleErrorCode.INVALID_INPUT
                )
            if polls >= max_polls or time.monotonic() + interval >= deadline:
                # A collection that outlives the request budget is abandoned,
                # not waited on. The snapshot keeps running on Bright Data's
                # side; JobPilot simply does not hold a user request open for it.
                logger.info(
                    "brightdata_snapshot_abandoned polls=%s reason=poll_deadline",
                    polls,
                )
                raise BrightDataUnavailable(
                    "provider_timeout", code=PeopleErrorCode.PROVIDER_TIMEOUT
                )
            await asyncio.sleep(interval)

        payload = await self._request(
            "GET",
            f"{_API_ROOT}/snapshot/{snapshot_id}",
            params={"format": "json"},
        )
        return _rows_from(payload)


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
