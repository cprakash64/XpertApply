"""Request-level guards for the authenticated multipart file upload.

Everything in this module runs AFTER authentication and BEFORE any Starlette /
python-multipart form parser is entered. That ordering is the whole point.

Why it exists
-------------
Declaring ``file: UploadFile = File(...)`` in a route signature makes the request
body part of FastAPI's dependency graph, and FastAPI resolves the body alongside
the security dependencies rather than after them. The practical consequence was
that ``MultiPartParser.parse`` — and, for a URL-encoded body, python-multipart's
``QuerystringParser`` — ran on **unauthenticated** input. A quadratic parsing
defect in python-multipart (GHSA-5rvq-cxj2-64vf) was therefore reachable with no
credentials at all.

The fix is structural, not a version bump: the route takes a bare ``Request``,
resolves the user through a normal dependency, and only then decides whether to
hand the body to a parser. Upgrading the dependencies closes the known defects;
this module makes the *class* of defect unreachable pre-auth.

Layers, outermost first
-----------------------
1. media-type gate      — a body that is not ``multipart/form-data`` is never parsed
2. raw request-body cap — bounds bytes read from the transport, without Content-Length
3. parser structure caps— one file, one field, small non-file parts
4. file stream cap      — bounded chunked read of the uploaded part itself

Layer 2 matters independently of the production edge: the deployed reverse-proxy
configuration is not in version control, so it cannot be treated as the only
boundary, and a chunked request carries no Content-Length to reject up front.
"""

from __future__ import annotations

from typing import Any

from starlette.datastructures import FormData, Headers, UploadFile
from starlette.requests import Request

from app.services.document_parser import MAX_UPLOAD_BYTES

#: Multipart framing (boundaries, part headers, the ``source_type`` field) around
#: a maximum-size file. Generous — real overhead is well under 1KB — but bounded,
#: so the raw-body cap can never reject a legitimately sized upload.
BODY_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024

#: Ceiling on bytes read from the transport for one upload request.
MAX_REQUEST_BODY_BYTES = MAX_UPLOAD_BYTES + BODY_OVERHEAD_ALLOWANCE_BYTES

#: Chunk size for the bounded read of the uploaded file.
UPLOAD_CHUNK_BYTES = 64 * 1024

#: The endpoint's documented multipart shape: exactly one file, and at most the
#: one ``source_type`` field the API defines. Anything beyond that is parser work
#: an attacker asked for and the product never needs.
MAX_UPLOAD_FILES = 1
MAX_UPLOAD_FIELDS = 1

#: Non-file parts carry short enum-ish values ("resume", "linkedin_pdf", "auto").
#: NOTE: Starlette's ``max_part_size`` bounds NON-FILE parts only — a file part is
#: streamed to a SpooledTemporaryFile with no size check of its own. The uploaded
#: file is bounded by layers 2 and 4 instead, never by this value.
MAX_NON_FILE_PART_BYTES = 16 * 1024

MULTIPART_MEDIA_TYPE = "multipart/form-data"

#: The multipart field names this endpoint reads. Kept next to the limits above
#: so the declared shape and the enforced shape cannot drift apart.
FILE_FIELD = "file"
SOURCE_TYPE_FIELD = "source_type"


class UploadRejected(Exception):
    """A request refused before, or instead of, doing parser work.

    Carries the HTTP status the route should return. The message is a
    user-facing sentence; parser internals are never forwarded to the client.
    """

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _content_type_parts(headers: Headers) -> tuple[str, dict[str, str]]:
    """Split a Content-Type header into its media type and parameters.

    Deliberately hand-rolled rather than routed through the form parser's own
    header parsing: this runs *before* any parser is entered, which is the
    property the whole module exists to preserve.
    """
    raw = headers.get("content-type") or ""
    media_type, _, remainder = raw.partition(";")
    params: dict[str, str] = {}
    for item in remainder.split(";"):
        key, sep, value = item.partition("=")
        if not sep:
            continue
        params[key.strip().lower()] = value.strip().strip('"')
    return media_type.strip().lower(), params


def require_multipart_upload(request: Request) -> None:
    """Refuse anything that is not a well-formed multipart upload.

    Raises before the caller touches ``request.form()``, so a URL-encoded or
    JSON body never reaches python-multipart's querystring parser and a
    boundary-less multipart body never reaches the multipart parser.

    415 for a media type this endpoint does not accept; 400 for the right media
    type sent malformed.
    """
    media_type, params = _content_type_parts(request.headers)

    if not media_type:
        raise UploadRejected(415, "A Content-Type of multipart/form-data is required to upload a file.")
    if media_type != MULTIPART_MEDIA_TYPE:
        raise UploadRejected(
            415,
            "Unsupported Content-Type. Upload the file as multipart/form-data.",
        )
    if not params.get("boundary"):
        raise UploadRejected(400, "Malformed multipart request: the Content-Type is missing a boundary.")


def _declared_content_length(headers: Headers) -> int | None:
    raw = headers.get("content-length")
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


def enforce_declared_body_size(request: Request, *, limit: int = MAX_REQUEST_BODY_BYTES) -> None:
    """Reject an over-large body on its Content-Length alone, reading nothing.

    An honest client is refused before a single byte is transferred. A client
    that lies, omits the header, or uses chunked transfer is caught by
    ``body_capped_request`` instead — this is an optimisation, never the control.
    """
    declared = _declared_content_length(request.headers)
    if declared is not None and declared > limit:
        raise UploadRejected(413, _too_large_message())


def body_capped_request(request: Request, *, limit: int = MAX_REQUEST_BODY_BYTES) -> Request:
    """A view of ``request`` whose body cannot exceed ``limit`` bytes.

    Wraps the ASGI ``receive`` callable and counts what actually arrives, so it
    works for chunked requests and for a client that understates
    Content-Length. Nothing is buffered here: each message is inspected and
    passed straight through, and the cap trips on the message that crosses the
    line rather than at the end of the body.

    Returning a new ``Request`` over the same scope is what makes this local to
    one endpoint — no middleware, no effect on any other route.
    """
    received = 0
    inner_receive = request.receive

    async def capped_receive() -> Any:
        nonlocal received
        message = await inner_receive()
        if message.get("type") == "http.request":
            received += len(message.get("body", b""))
            if received > limit:
                raise UploadRejected(413, _too_large_message())
        return message

    return Request(request.scope, capped_receive)


async def parse_single_file_form(request: Request) -> FormData:
    """Parse the multipart body under explicit structural limits.

    The caller is responsible for closing the returned ``FormData``; it owns
    spooled temporary files.
    """
    from starlette.formparsers import MultiPartException

    try:
        return await request.form(
            max_files=MAX_UPLOAD_FILES,
            max_fields=MAX_UPLOAD_FIELDS,
            max_part_size=MAX_NON_FILE_PART_BYTES,
        )
    except MultiPartException as exc:
        # The parser's own message names internal limits ("Too many files.
        # Maximum number of files is 1."). Report the shape violation without
        # echoing parser internals back to the caller.
        raise UploadRejected(400, "Malformed or unsupported multipart upload.") from exc


def _too_large_message() -> str:
    return f"Uploaded file is too large. The limit is {MAX_UPLOAD_BYTES // (1024 * 1024)}MB."


async def read_upload_capped(
    upload: UploadFile,
    *,
    limit: int = MAX_UPLOAD_BYTES,
    chunk_size: int = UPLOAD_CHUNK_BYTES,
) -> bytes:
    """Read an uploaded file in chunks, stopping the moment it exceeds ``limit``.

    Replaces an unbounded ``await file.read()`` that materialised the entire
    user-controlled file before the size limit was consulted. Peak memory here
    is the accumulated allowed bytes plus one chunk, and an over-limit upload
    stops at the first chunk that crosses the boundary rather than after the
    whole file has been copied.

    Exactly ``limit`` bytes is accepted; ``limit + 1`` is not.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise UploadRejected(413, _too_large_message())
        chunks.append(chunk)
    return b"".join(chunks)
