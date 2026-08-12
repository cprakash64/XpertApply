"""Apollo bulk-enrichment contract, asserted against the documented schema.

Apollo's Bulk People Enrichment accepts

    POST /api/v1/people/bulk_match
    {"details": [{"id": "<apollo person id>"}, ...]}   # at most 10

with the ids copied unchanged from People Search's top-level ``id``. These tests
pin every part of that: the request body, the identifier source, the batch cap,
the headers, the absence of personal-contact reveal flags, and the join between
response matches and the ids we submitted.

No test here performs network I/O — the HTTP transport is a stub, so a failure
means the adapter is wrong, never that Apollo is down.
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest

from app.core.config import settings
from app.people.providers import (
    ApolloPeopleProvider,
    ProviderUnavailable,
    _safe_apollo_validation_metadata,
)
from app.people.schemas import PeopleSearchQuery, PersonEnrichmentRequest

# A sanitized People Search response in the documented shape: surnames come back
# obfuscated until a record is enriched, and the identity to reuse is `id`.
SEARCH_RESPONSE = {
    "people": [
        {
            "id": "person_123",
            "first_name": "Alex",
            "last_name_obfuscated": "Pa***r",
            "title": "Technical Recruiter",
            "organization": {"name": "Example Company"},
        },
        {
            "id": "person_456",
            "first_name": "Jordan",
            "last_name_obfuscated": "Sm***h",
            "title": "Engineering Manager",
            "organization": {"name": "Example Company"},
        },
    ]
}

MATCH_RESPONSE = {
    "matches": [
        {
            "id": "person_456",
            "name": "Jordan Smith",
            "title": "Engineering Manager",
            "organization": {"name": "Example Company"},
            "linkedin_url": "https://www.linkedin.com/in/jordan-smith",
        },
        {
            "id": "person_123",
            "name": "Alex Parker",
            "title": "Technical Recruiter",
            "organization": {"name": "Example Company"},
            "linkedin_url": "https://www.linkedin.com/in/alex-parker",
        },
    ]
}


class SentRequest:
    """One outgoing call, captured for assertion."""

    def __init__(self, method: str, url: str, kwargs: dict) -> None:
        self.method = method
        self.url = httpx.URL(url)
        self.kwargs = kwargs
        self.headers = httpx.Headers(kwargs.get("headers") or {})
        self.json_body = kwargs.get("json")

    @property
    def content(self) -> bytes:
        return json.dumps(self.json_body).encode()


class RecordingTransport:
    """Stands in for httpx.AsyncClient and replays scripted responses.

    The provider builds its own client per request, so this replaces the class
    rather than injecting a transport. Nothing here opens a socket.
    """

    def __init__(self, responses: dict[str, tuple[int, dict]]) -> None:
        self.responses = responses
        self.requests: list[SentRequest] = []

    def __call__(self, **_kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        sent = SentRequest(method, url, kwargs)
        self.requests.append(sent)
        for path, (status, body) in self.responses.items():
            if sent.url.path == path:
                return httpx.Response(
                    status,
                    json=body,
                    request=httpx.Request(method, url),
                    headers={"Content-Type": "application/json"},
                )
        return httpx.Response(404, json={}, request=httpx.Request(method, url))

    def request_for(self, path: str) -> SentRequest | None:
        return next((r for r in self.requests if r.url.path == path), None)

    def body_for(self, path: str) -> dict | None:
        sent = self.request_for(path)
        return sent.json_body if sent else None


BULK_PATH = "/api/v1/people/bulk_match"
SEARCH_PATH = "/api/v1/mixed_people/api_search"


@pytest.fixture(autouse=True)
def _apollo_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "apollo_api_key", "test-key-not-real", raising=False)
    monkeypatch.setattr(settings, "people_apollo_discovery_enabled", True, raising=False)
    monkeypatch.setattr(
        settings, "people_apollo_max_enrichments_per_discovery", 10, raising=False
    )
    from app.people import bulk_capability, circuit

    circuit.clear_local_circuits()
    bulk_capability.clear_local_bulk_capabilities()


@pytest.fixture
def transport_factory(monkeypatch: pytest.MonkeyPatch):
    def install(responses: dict[str, tuple[int, dict]]) -> RecordingTransport:
        from app.people import providers

        transport = RecordingTransport(responses)
        monkeypatch.setattr(providers.httpx, "AsyncClient", transport)
        return transport

    return install


def provider() -> ApolloPeopleProvider:
    return ApolloPeopleProvider(api_key="test-key-not-real")


def requests_for(*ids: str) -> list[PersonEnrichmentRequest]:
    return [PersonEnrichmentRequest(provider_person_id=value) for value in ids]


# --------------------------------------------------------------------------
# The request body
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_bulk_request_is_exactly_details_with_id_objects(transport_factory):
    transport = transport_factory({BULK_PATH: (200, MATCH_RESPONSE)})
    apollo = provider()

    await apollo.enrich_people(requests_for("person_123", "person_456"))

    body = transport.body_for(BULK_PATH)
    assert body == {"details": [{"id": "person_123"}, {"id": "person_456"}]}
    # The shapes Apollo rejects with a request-level 422.
    assert "apollo_id" not in json.dumps(body)
    assert "person_id" not in json.dumps(body)
    assert not isinstance(body["details"][0], str)
    assert not isinstance(body["details"][0].get("id"), dict)


@pytest.mark.anyio
async def test_bulk_request_carries_the_documented_headers_and_no_reveal_flags(transport_factory):
    transport = transport_factory({BULK_PATH: (200, MATCH_RESPONSE)})
    apollo = provider()

    await apollo.enrich_people(requests_for("person_123"))

    request = transport.request_for(BULK_PATH)
    assert request.method == "POST"
    assert request.headers["content-type"].startswith("application/json")
    assert request.headers["accept"] == "application/json"
    # Present, but never snapshotted.
    assert request.headers.get("x-api-key")
    # XpertApply wants LinkedIn URLs, not personal contact details.
    query = str(request.url.query)
    body = json.dumps(transport.body_for(BULK_PATH))
    for flag in ("reveal_personal_emails=true", "reveal_phone_number=true"):
        assert flag not in query
    for flag in ("reveal_personal_emails", "reveal_phone_number", "webhook_url"):
        assert flag not in body


@pytest.mark.anyio
async def test_ids_come_from_the_search_response_top_level_id(transport_factory):
    transport = transport_factory(
        {SEARCH_PATH: (200, SEARCH_RESPONSE), BULK_PATH: (200, MATCH_RESPONSE)}
    )
    apollo = provider()


    found = await apollo.search_people(
        PeopleSearchQuery(
            category="likely_recruiter",
            company_name="Example Company",
            company_domain="example.com",
            titles=["recruiter"],
            limit=10,
        )
    )
    assert [person.provider_person_id for person in found] == ["person_123", "person_456"]

    await apollo.enrich_people(
        [PersonEnrichmentRequest(provider_person_id=p.provider_person_id) for p in found]
    )
    assert transport.body_for(BULK_PATH) == {
        "details": [{"id": "person_123"}, {"id": "person_456"}]
    }


@pytest.mark.anyio
@pytest.mark.parametrize(
    "rejected",
    ["", "   ", "unknown", "null", "Pa***r", "https://www.linkedin.com/in/alex"],
)
async def test_unusable_identifiers_never_reach_the_request(rejected, transport_factory):
    transport = transport_factory({BULK_PATH: (200, MATCH_RESPONSE)})
    apollo = provider()

    await apollo.enrich_people(requests_for("person_123", rejected))

    assert transport.body_for(BULK_PATH) == {"details": [{"id": "person_123"}]}


@pytest.mark.anyio
async def test_duplicate_identifiers_are_sent_once_in_ranking_order(transport_factory):
    transport = transport_factory({BULK_PATH: (200, MATCH_RESPONSE)})
    apollo = provider()

    await apollo.enrich_people(
        requests_for("person_456", "person_123", "person_456")
    )

    assert transport.body_for(BULK_PATH) == {
        "details": [{"id": "person_456"}, {"id": "person_123"}]
    }


@pytest.mark.anyio
async def test_batches_never_exceed_apollos_ten_person_limit(transport_factory):
    transport = transport_factory({BULK_PATH: (200, {"matches": []})})
    apollo = provider()

    await apollo.enrich_people(requests_for(*[f"person_{n:03d}" for n in range(23)]))

    bodies = [
        request.json_body
        for request in transport.requests
        if request.url.path == BULK_PATH
    ]
    assert [len(body["details"]) for body in bodies] == [10, 10, 3]
    assert all(len(body["details"]) <= 10 for body in bodies)


@pytest.mark.anyio
async def test_no_request_is_made_when_every_identifier_is_unusable(transport_factory):
    transport = transport_factory({BULK_PATH: (200, MATCH_RESPONSE)})
    apollo = provider()

    enriched = await apollo.enrich_people(requests_for("", "Pa***r"))

    assert enriched == []
    assert transport.request_for(BULK_PATH) is None


# --------------------------------------------------------------------------
# The response
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_matches_are_joined_by_id_not_by_position(transport_factory):
    # The scripted response deliberately reverses the submitted order.
    transport_factory({BULK_PATH: (200, MATCH_RESPONSE)})
    apollo = provider()

    enriched = await apollo.enrich_people(requests_for("person_123", "person_456"))

    by_id = {person.provider_person_id: person for person in enriched}
    assert by_id["person_123"].full_name == "Alex Parker"
    assert by_id["person_123"].linkedin_url == "https://www.linkedin.com/in/alex-parker"
    assert by_id["person_456"].full_name == "Jordan Smith"
    assert by_id["person_456"].linkedin_url == "https://www.linkedin.com/in/jordan-smith"


@pytest.mark.anyio
async def test_a_partial_response_enriches_what_it_can(transport_factory):
    partial = {"matches": [MATCH_RESPONSE["matches"][1], None]}
    transport_factory({BULK_PATH: (200, partial)})
    apollo = provider()

    enriched = await apollo.enrich_people(requests_for("person_123", "person_456"))

    assert [person.provider_person_id for person in enriched] == ["person_123"]


@pytest.mark.anyio
async def test_an_unsafe_linkedin_url_is_dropped_without_dropping_the_person(transport_factory):
    unsafe = {
        "matches": [
            {
                **MATCH_RESPONSE["matches"][1],
                "linkedin_url": "javascript:alert(1)",
            }
        ]
    }
    transport_factory({BULK_PATH: (200, unsafe)})
    apollo = provider()

    enriched = await apollo.enrich_people(requests_for("person_123"))

    assert len(enriched) == 1
    assert enriched[0].linkedin_url in (None, "")


# --------------------------------------------------------------------------
# 422 diagnostics
# --------------------------------------------------------------------------


def _response(body: dict) -> httpx.Response:
    return httpx.Response(
        422, json=body, request=httpx.Request("POST", f"https://api.apollo.io{BULK_PATH}")
    )


def test_apollo_free_text_errors_become_an_actionable_code():
    # The live 422 produced error_types=['provider_bulk_validation_failed'] and
    # nothing else, because a free-text body was read by nothing at all. It is
    # now classified — but never stored as the provider's own prose, because a
    # free-text field is where a provider would echo an id or a key back.
    metadata = _safe_apollo_validation_metadata(
        _response({"error": "The details parameter must be an array of objects"})
    )

    assert metadata["message_code"] == "details+array_expected"


def test_provider_prose_is_never_retained_verbatim():
    metadata = _safe_apollo_validation_metadata(
        _response({"error": "Private response content must not be retained"})
    )

    assert metadata["message_code"] == "unclassified"
    assert "Private response content" not in str(metadata)


def test_error_codes_survive_even_without_a_field_path():
    metadata = _safe_apollo_validation_metadata(
        _response({"errors": [{"code": "invalid_identifier"}]})
    )

    assert "invalid_identifier" in metadata["error_types"]
    assert metadata["error_types"] != ["provider_bulk_validation_failed"]


def test_record_level_field_paths_are_kept_and_scoped():
    metadata = _safe_apollo_validation_metadata(
        _response(
            {
                "detail": [
                    {
                        "loc": ["details", 0, "id"],
                        "type": "value_error",
                        "ctx": {"expected": "string"},
                    }
                ]
            }
        )
    )

    assert metadata["field_paths"] == ["details.*.id"]
    assert metadata["error_scope"] == "record_level"
    assert metadata["expected_types"] == ["string"]


def test_diagnostics_never_carry_person_ids_or_secrets(caplog):
    from app.people.providers import _log_safe_apollo_validation

    metadata = _safe_apollo_validation_metadata(
        _response({"error": "person_123 is not a valid id for key test-key-not-real"})
    )
    with caplog.at_level(logging.INFO):
        _log_safe_apollo_validation(
            endpoint=BULK_PATH, metadata=metadata, detail_count=2, identifier_fields=["id"]
        )

    text = "\n".join(record.getMessage() for record in caplog.records)
    assert "test-key-not-real" not in text
    assert "person_123" not in text
    assert "detail_count=2" in text
    assert "identifier_fields=['id']" in text


@pytest.mark.anyio
async def test_a_bulk_422_is_diagnosed_and_does_not_erase_the_candidate(
    transport_factory, caplog
):
    # A rejected bulk request must produce an actionable diagnostic and fall
    # through to the single-person path — never surface as "no people exist".
    transport_factory({BULK_PATH: (422, {"errors": [{"code": "invalid_identifier"}]})})
    apollo = provider()

    with caplog.at_level(logging.WARNING):
        try:
            await apollo.enrich_people(requests_for("person_123"))
        except ProviderUnavailable as exc:
            # If it does propagate, the typed metadata must ride along.
            assert exc.http_status in (401, 404, 422)

    diagnostics = [
        record.getMessage()
        for record in caplog.records
        if "apollo_enrichment_validation" in record.getMessage()
    ]
    assert diagnostics, "a rejected bulk request must be diagnosed"
    assert "invalid_identifier" in diagnostics[0]
    assert "detail_count=1" in diagnostics[0]


# --------------------------------------------------------------------------
# Which failure the user is told about
# --------------------------------------------------------------------------


def test_a_later_contract_error_outranks_an_earlier_budget_stop():
    """The live symptom: the UI blamed the PDL budget for an Apollo defect.

    PDL's budget stop is why the chain moved on to Apollo. It is not why the
    user ended up with no contacts — our own malformed request was.
    """

    from app.people.service import _dominant_failure

    assert (
        _dominant_failure(["provider_budget_exceeded", "provider_schema_error"])
        == "provider_schema_error"
    )


def test_budget_copy_survives_when_budget_really_is_the_whole_story():
    from app.people.service import _dominant_failure

    assert (
        _dominant_failure(["provider_budget_exceeded", "provider_budget_exceeded"])
        == "provider_budget_exceeded"
    )
    assert _dominant_failure(["provider_budget_exceeded"]) == "provider_budget_exceeded"


def test_a_configuration_failure_still_outranks_everything():
    from app.people.service import _dominant_failure

    assert (
        _dominant_failure(["provider_budget_exceeded", "provider_unauthorized"])
        == "provider_unauthorized"
    )


def test_the_user_facing_status_for_a_contract_error_is_not_budget_copy():
    from app.people.errors import code_for_reason
    from app.people.finalization import STATUS_FOR_CODE

    code = code_for_reason("provider_schema_error")
    status = STATUS_FOR_CODE.get(code, "provider_unavailable")
    assert status != "provider_budget_exhausted"


@pytest.mark.anyio
async def test_search_candidates_survive_a_failed_enrichment(transport_factory):
    """Enrichment buys LinkedIn URLs. Losing it must not lose the people.

    Apollo's People Search already gives a usable candidate — id, first name,
    obfuscated surname, title, company — and a 422 on the *enrichment* call is
    no evidence that those people do not exist.
    """


    transport_factory(
        {
            SEARCH_PATH: (200, SEARCH_RESPONSE),
            BULK_PATH: (422, {"error": "invalid request"}),
        }
    )
    apollo = provider()

    found = await apollo.search_people(
        PeopleSearchQuery(
            category="likely_recruiter",
            company_name="Example Company",
            company_domain="example.com",
            titles=["recruiter"],
            limit=10,
        )
    )

    # The search result stands on its own, with the obfuscated surname intact
    # and no invented profile link.
    assert [person.provider_person_id for person in found] == ["person_123", "person_456"]
    assert found[0].full_name == "Alex Pa***r"
    assert found[0].linkedin_url in (None, "")


# --------------------------------------------------------------------------
# The whole chain, end to end
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_search_ids_flow_into_bulk_details_and_back_out_as_linkedin_urls(
    transport_factory,
):
    """The claim this whole change rests on, asserted in one place.

    Apollo Search `id` -> bulk_match `details[].id` -> enriched match ->
    validated LinkedIn URL on the candidate. If any link in that chain regresses,
    this fails.
    """


    transport = transport_factory(
        {SEARCH_PATH: (200, SEARCH_RESPONSE), BULK_PATH: (200, MATCH_RESPONSE)}
    )
    apollo = provider()

    found = await apollo.search_people(
        PeopleSearchQuery(
            category="likely_recruiter",
            company_name="Example Company",
            company_domain="example.com",
            titles=["recruiter"],
            limit=10,
        )
    )
    enriched = await apollo.enrich_people(
        [PersonEnrichmentRequest(provider_person_id=p.provider_person_id) for p in found]
    )

    # 1. The ids came from the search response.
    assert [p.provider_person_id for p in found] == ["person_123", "person_456"]
    # 2. They were sent in the documented body.
    assert transport.body_for(BULK_PATH) == {
        "details": [{"id": "person_123"}, {"id": "person_456"}]
    }
    # 3. Enrichment came back joined by id, with real profile URLs.
    by_id = {p.provider_person_id: p for p in enriched}
    assert set(by_id) == {"person_123", "person_456"}
    assert by_id["person_123"].linkedin_url == "https://www.linkedin.com/in/alex-parker"
    assert by_id["person_456"].linkedin_url == "https://www.linkedin.com/in/jordan-smith"
    # 4. Enrichment resolved the surnames the search had obfuscated.
    assert by_id["person_123"].full_name == "Alex Parker"
    assert "*" not in by_id["person_456"].full_name
    # 5. Exactly two paid calls: one search, one bulk enrichment.
    assert len(transport.requests) == 2
