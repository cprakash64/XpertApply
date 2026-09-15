"""B-01 dynamic authorization-coverage instrumentation.

Why this module exists
----------------------
Stage 2G-D claimed 51/51 dynamic cross-user coverage. The claim was prose, and
it was wrong: an independent replay of the suite measured 27/51. Prose cannot
be regression-tested, so the count now comes from the requests the suite
actually issues.

Every request the matrix makes is recorded with its resolved OpenAPI template,
the authenticated JWT subject, and the *typed* ownership of any identifier it
carried. An operation is only ever marked covered because a request proved it.

Type-correct ownership
----------------------
Identifier collisions across resource types produce false coverage. In this
fixture A's ``cover_letter_document_id`` and B's ``session_id`` are both ``2``,
so a flat "did the path contain one of A's ids" test reports a foreign-session
attack that never happened. Ownership is therefore tracked as
``(kind, id) -> user_id`` and a path parameter only counts when the *kind* the
route expects matches the kind that was registered.

Redaction
---------
Only the JWT subject claim, the resolved template, extracted integer ids and
the status code are retained. Passwords, whole tokens, résumé and cover-letter
text and answer values are never recorded.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, field
from typing import Any

from starlette.testclient import TestClient

from app.main import app

# --------------------------------------------------------------------------- #
# Live OpenAPI inventory
# --------------------------------------------------------------------------- #
_HTTP_METHODS = ("get", "post", "put", "patch", "delete")

#: Shared catalogue data. Both users may legitimately read a JobPosting and a
#: company logo, so neither is a BOLA surface. What must not travel with them is
#: the per-user state hanging off them, which the matrix asserts separately.
SHARED_PUBLIC_OPERATIONS = frozenset(
    {
        ("GET", "/jobs/{job_id}"),
        ("GET", "/jobs/companies/{normalized_key}/logo"),
    }
)

#: Path parameters that name an owned object, and the ownership kind each one
#: refers to. Anything absent from this map (``job_id``, ``canonical_key``,
#: ``fmt``, ``doc_type``, ``normalized_key``) is shared data or vocabulary and
#: carries no ownership.
PARAM_KIND = {
    "session_id": "session",
    "tracker_id": "tracker",
    "snapshot_id": "snapshot",
    "document_id": "document",
    "recommendation_id": "recommendation",
}

#: Body/query fields that reference an owned object.
BODY_REF_KIND = {
    "session_id": "session",
    "tracker_id": "tracker",
    "snapshot_id": "snapshot",
    "document_id": "document",
    "resume_document_id": "document",
    "cover_letter_document_id": "document",
    "recommendation_id": "recommendation",
}


def openapi_operations() -> set[tuple[str, str]]:
    spec = app.openapi()
    return {
        (method.upper(), path)
        for path, item in spec["paths"].items()
        for method in item
        if method.lower() in _HTTP_METHODS
    }


def id_bearing_operations() -> set[tuple[str, str]]:
    return {op for op in openapi_operations() if "{" in op[1]}


def private_operations() -> set[tuple[str, str]]:
    """Owner-private operations that require authorization coverage."""
    return id_bearing_operations() - SHARED_PUBLIC_OPERATIONS


# --------------------------------------------------------------------------- #
# Path -> OpenAPI template resolution
# --------------------------------------------------------------------------- #
def _segments(path: str) -> list[str]:
    return path.strip("/").split("/")


def _template_matches(raw: str, template: str) -> bool:
    raw_parts, tmpl_parts = _segments(raw), _segments(template)
    if len(raw_parts) != len(tmpl_parts):
        return False
    for value, part in zip(raw_parts, tmpl_parts, strict=True):
        if part.startswith("{") and part.endswith("}"):
            if not value:
                return False
        elif value != part:
            return False
    return True


def _static_segment_count(template: str) -> int:
    return sum(0 if part.startswith("{") else 1 for part in _segments(template))


class _Resolver:
    """Resolves a concrete request path to its OpenAPI template.

    The app mounts its routers through a wrapper that hides ``path_format``, so
    matching goes through the published schema instead — which is also the
    artefact the coverage claim is made against.
    """

    def __init__(self) -> None:
        self._templates = sorted({path for _, path in openapi_operations()})

    def resolve(self, raw: str) -> str | None:
        candidates = [t for t in self._templates if _template_matches(raw, t)]
        if not candidates:
            return None
        # A static segment always beats a placeholder: /jobs/tracker/all is not
        # /jobs/{job_id}/... and /jobs/documents/{id} is not /jobs/{job_id}/...
        return max(candidates, key=_static_segment_count)

    def path_params(self, raw: str, template: str) -> dict[str, str]:
        return {
            part[1:-1]: value
            for value, part in zip(_segments(raw), _segments(template), strict=True)
            if part.startswith("{") and part.endswith("}")
        }


RESOLVER = _Resolver()


# --------------------------------------------------------------------------- #
# Ownership registry
# --------------------------------------------------------------------------- #
class Ownership:
    """``(kind, id) -> owning user id``, so coverage is type-correct."""

    def __init__(self) -> None:
        self._owners: dict[tuple[str, str], int] = {}

    def register(self, kind: str, identifier: Any, user_id: int) -> None:
        self._owners[(kind, str(identifier))] = int(user_id)

    def owner_of(self, kind: str, identifier: Any) -> int | None:
        return self._owners.get((kind, str(identifier)))

    def clear(self) -> None:
        self._owners.clear()


# --------------------------------------------------------------------------- #
# Request recording
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Recorded:
    method: str
    template: str | None
    caller: int | None
    status: int
    #: kinds/ids the request referenced, with the user who owns each.
    refs: tuple[tuple[str, str, int | None], ...]
    test: str

    @property
    def operation(self) -> tuple[str, str] | None:
        return (self.method, self.template) if self.template else None

    def foreign_refs(self) -> list[tuple[str, str, int]]:
        """Type-correct references to a resource the caller does not own."""
        if self.caller is None:
            return []
        return [
            (kind, identifier, owner)
            for kind, identifier, owner in self.refs
            if owner is not None and owner != self.caller
        ]


def _subject_of(authorization: str | None) -> int | None:
    """The ``sub`` claim only. The token itself is never retained."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        subject = json.loads(base64.urlsafe_b64decode(payload)).get("sub")
        return int(subject)
    except Exception:
        return None


@dataclass
class Recorder:
    ownership: Ownership = field(default_factory=Ownership)
    records: list[Recorded] = field(default_factory=list)
    current_test: str = ""

    def observe(
        self,
        method: str,
        url: str,
        headers: dict[str, str] | None,
        body: Any,
        status: int,
    ) -> None:
        raw = str(url).split("?", 1)[0]
        if "://" in raw:
            raw = "/" + raw.split("://", 1)[1].split("/", 1)[-1]
        template = RESOLVER.resolve(raw)
        headers = headers or {}
        caller = _subject_of(headers.get("Authorization") or headers.get("authorization"))

        refs: list[tuple[str, str, int | None]] = []
        if template:
            for name, value in RESOLVER.path_params(raw, template).items():
                kind = PARAM_KIND.get(name)
                if kind:
                    refs.append((kind, value, self.ownership.owner_of(kind, value)))
        for name, value in _body_refs(body):
            kind = BODY_REF_KIND.get(name)
            if kind:
                refs.append((kind, value, self.ownership.owner_of(kind, value)))

        self.records.append(
            Recorded(
                method=method.upper(),
                template=template,
                caller=caller,
                status=status,
                refs=tuple(refs),
                test=self.current_test,
            )
        )

    # -- queries used by the coverage assertions ---------------------------- #
    def for_operation(self, operation: tuple[str, str]) -> list[Recorded]:
        return [r for r in self.records if r.operation == operation]

    def cross_user_attacks(self, operation: tuple[str, str]) -> list[Recorded]:
        return [r for r in self.for_operation(operation) if r.foreign_refs()]

    def calls_by(self, operation: tuple[str, str], user_id: int) -> list[Recorded]:
        return [r for r in self.for_operation(operation) if r.caller == user_id]

    def unauthorized_successes(self, exclude_tests: frozenset[str] = frozenset()) -> list[Recorded]:
        """Every 2xx a caller received on a resource it does not own.

        `exclude_tests` names the negative controls, which breach ownership on
        purpose: they patch a guard out and require the breach to appear. A
        breach from anywhere else is a real failure.
        """
        return [
            r
            for r in self.records
            if r.foreign_refs() and 200 <= r.status < 300 and r.test not in exclude_tests
        ]


def _body_refs(body: Any) -> list[tuple[str, str]]:
    """Integer-valued id fields in a request body. Values only, never text."""
    out: list[tuple[str, str]] = []
    if isinstance(body, dict):
        for key, value in body.items():
            if isinstance(value, int) and not isinstance(value, bool):
                out.append((key, str(value)))
            elif isinstance(value, str) and re.fullmatch(r"\d+", value):
                out.append((key, value))
            elif isinstance(value, dict | list):
                out.extend(_body_refs(value))
    elif isinstance(body, list):
        for item in body:
            out.extend(_body_refs(item))
    return out


# --------------------------------------------------------------------------- #
# TestClient interception
# --------------------------------------------------------------------------- #
_ACTIVE: Recorder | None = None
_ORIGINAL_REQUEST = TestClient.request


def _patched_request(self: TestClient, method: str, url: Any, *args: Any, **kwargs: Any):
    response = _ORIGINAL_REQUEST(self, method, url, *args, **kwargs)
    recorder = _ACTIVE
    if recorder is not None:
        try:
            recorder.observe(
                method=method,
                url=url,
                headers=kwargs.get("headers"),
                body=kwargs.get("json"),
                status=response.status_code,
            )
        except Exception:  # pragma: no cover - instrumentation must never fail a run
            pass
    return response


TestClient.request = _patched_request  # type: ignore[method-assign]


def activate(recorder: Recorder) -> None:
    global _ACTIVE
    _ACTIVE = recorder


def deactivate() -> None:
    global _ACTIVE
    _ACTIVE = None


# --------------------------------------------------------------------------- #
# Coverage ledger
# --------------------------------------------------------------------------- #
#: How an operation earns coverage.
CROSS_USER = "cross-user foreign identifier"
SHARED_EFFECT = "shared identifier, private per-user effect"
CALLER_SCOPED = "caller-scoped key, no foreign object id"


@dataclass
class CoverageEntry:
    operation: tuple[str, str]
    kind: str
    case: str
    owner_control: bool
    foreign_attack: bool
    isolation_asserted: bool
    side_effect_checked: bool


class Ledger:
    """Accumulates coverage across the module's tests.

    A declaration alone never counts: :meth:`verify` re-checks each claim
    against what the recorder actually saw.
    """

    def __init__(self) -> None:
        self.entries: dict[tuple[str, str], CoverageEntry] = {}

    def declare(
        self,
        operation: tuple[str, str],
        *,
        kind: str,
        case: str,
        owner_control: bool = False,
        foreign_attack: bool = False,
        isolation_asserted: bool = False,
        side_effect_checked: bool = False,
    ) -> None:
        existing = self.entries.get(operation)
        if existing is None:
            self.entries[operation] = CoverageEntry(
                operation, kind, case, owner_control, foreign_attack,
                isolation_asserted, side_effect_checked,
            )
            return
        self.entries[operation] = CoverageEntry(
            operation,
            existing.kind,
            existing.case if case in existing.case else f"{existing.case}, {case}",
            existing.owner_control or owner_control,
            existing.foreign_attack or foreign_attack,
            existing.isolation_asserted or isolation_asserted,
            existing.side_effect_checked or side_effect_checked,
        )

    def verify(self, recorder: Recorder, a_id: int, b_id: int) -> tuple[set, dict]:
        """Return (covered operations, per-operation rejection reasons)."""
        covered: set[tuple[str, str]] = set()
        rejected: dict[tuple[str, str], str] = {}
        for operation, entry in self.entries.items():
            attacks = recorder.cross_user_attacks(operation)
            b_calls = recorder.calls_by(operation, b_id)
            a_calls = recorder.calls_by(operation, a_id)
            if entry.kind == CROSS_USER:
                if not attacks:
                    rejected[operation] = (
                        "declared cross-user but no request carried a type-correct "
                        "identifier owned by another user"
                    )
                    continue
            elif entry.kind == SHARED_EFFECT:
                if not (a_calls and b_calls and entry.isolation_asserted):
                    rejected[operation] = (
                        "declared shared-effect but lacks an A call, a B call, or an "
                        "isolation assertion"
                    )
                    continue
            elif entry.kind == CALLER_SCOPED:
                if not (b_calls and entry.isolation_asserted):
                    rejected[operation] = (
                        "declared caller-scoped but lacks a B call or an isolation "
                        "assertion"
                    )
                    continue
            else:  # pragma: no cover - defensive
                rejected[operation] = f"unknown coverage kind {entry.kind!r}"
                continue
            covered.add(operation)
        return covered, rejected


LEDGER = Ledger()

#: Both singletons live here rather than in the test module so that everything
#: reading them — the coverage gate, and any out-of-band reporting — sees the
#: same accumulated run.
RECORDER = Recorder()
