"""Security regression tests for POST /profile/import/file (SUP-DEP-001).

Every test here fails against the pre-fix implementation, where the route
declared ``file: UploadFile = File(...)``. That put the request body into
FastAPI's dependency graph, so Starlette and python-multipart parsed
**unauthenticated** input — which is what made python-multipart's quadratic
form-parsing defect (GHSA-5rvq-cxj2-64vf) reachable with no credentials.

The assertions are deliberately structural rather than timed. "Did the parser
run at all?" is a stable property; "did it finish within N milliseconds?" is a
CI flake. A separate local benchmark demonstrated the throughput improvement.
"""

from __future__ import annotations

import inspect
import zipfile
from collections.abc import Generator
from io import BytesIO

import pytest
from docx import Document
from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from starlette import formparsers

from app.api.deps import get_db
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401 - registers mappers
from app.services.document_parser import (
    MAX_DOCX_COMPRESSION_RATIO,
    MAX_DOCX_MEMBERS,
    MAX_PDF_PAGES,
    MAX_UPLOAD_BYTES,
    DocumentParserError,
    extract_text_from_docx,
    extract_text_from_pdf,
)
from app.services.upload_guard import (
    MAX_REQUEST_BODY_BYTES,
    MAX_UPLOAD_FIELDS,
    MAX_UPLOAD_FILES,
    UploadRejected,
    read_upload_capped,
)

PDF_TYPE = "application/pdf"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TXT_TYPE = "text/plain"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def auth(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/auth/signup",
        json={"email": "upload-security@example.com", "password": "password123"},
    )
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture()
def parser_spy(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Count entries into each Starlette form parser.

    ``MultiPartParser`` handles multipart bodies; ``FormParser`` handles
    ``application/x-www-form-urlencoded`` and is the one that drives
    python-multipart's ``QuerystringParser``, the component carrying the
    quadratic defect.
    """
    calls = {"multipart": 0, "urlencoded": 0}

    original_multipart = formparsers.MultiPartParser.parse
    original_form = formparsers.FormParser.parse

    async def counting_multipart(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        calls["multipart"] += 1
        return await original_multipart(self, *args, **kwargs)

    async def counting_form(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        calls["urlencoded"] += 1
        return await original_form(self, *args, **kwargs)

    monkeypatch.setattr(formparsers.MultiPartParser, "parse", counting_multipart)
    monkeypatch.setattr(formparsers.FormParser, "parse", counting_form)
    return calls


def resume_text() -> str:
    return "\n".join(
        [
            "Demo Student",
            "demo@example.com",
            "555-123-4567",
            "Experience",
            "Engineer at Example Corp, 2020-2024",
            "Built services in Python and FastAPI.",
            "Education",
            "BS Computer Science, Example University, 2020",
            "Skills",
            "Python, FastAPI, PostgreSQL, Docker",
        ]
    )


def make_pdf(text: str) -> bytes:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer)
    y = 800
    for line in text.splitlines():
        pdf.drawString(72, y, line)
        y -= 14
    pdf.save()
    return buffer.getvalue()


def make_docx(text: str) -> bytes:
    buffer = BytesIO()
    document = Document()
    for line in text.splitlines():
        document.add_paragraph(line)
    document.save(buffer)
    return buffer.getvalue()


def make_zip(entries: list[tuple[str, bytes]]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return buffer.getvalue()


def multipart_body(
    *,
    fields: dict[str, str] | None = None,
    files: list[tuple[str, str, bytes, str | None]] | None = None,
    boundary: str = "xpertapplyqaboundary",
) -> tuple[bytes, str]:
    """Build a multipart body by hand.

    httpx is helpful in ways these tests need to switch off: it infers a part
    Content-Type from the filename, and it silently downgrades a file-less post
    to ``application/x-www-form-urlencoded``. Both make it impossible to express
    the exact malformed shapes under test.

    Returns ``(body, content_type_header)``.
    """
    parts: list[bytes] = []
    for name, value in (fields or {}).items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    for name, filename, payload, content_type in files or []:
        header = f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        if content_type is not None:
            header += f"Content-Type: {content_type}\r\n"
        parts.append(header.encode() + b"\r\n" + payload + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# --------------------------------------------------------------------------- #
# 1. Pre-auth parser isolation — the core of SUP-DEP-001
# --------------------------------------------------------------------------- #
def test_unauthenticated_multipart_upload_never_enters_the_multipart_parser(
    client: TestClient, parser_spy: dict[str, int]
) -> None:
    response = client.post(
        "/profile/import/file",
        data={"source_type": "resume"},
        files={"file": ("resume.pdf", make_pdf(resume_text()), PDF_TYPE)},
    )

    assert response.status_code == 401
    assert parser_spy["multipart"] == 0, "multipart body was parsed before authentication"


def test_unauthenticated_urlencoded_body_never_enters_the_querystring_parser(
    client: TestClient, parser_spy: dict[str, int]
) -> None:
    """The exact shape Stage 2A used to reproduce the quadratic CPU defect.

    Pre-fix this returned 401 *after* python-multipart had already parsed the
    body; 1.25MB of ``a=1;`` cost ~12.8s of CPU with no credentials.
    """
    response = client.post(
        "/profile/import/file",
        content=b"a=1;" * 20_000,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    assert response.status_code == 401
    assert parser_spy["urlencoded"] == 0, "URL-encoded body was parsed before authentication"
    assert parser_spy["multipart"] == 0


def test_upload_route_declares_no_request_body_parameter() -> None:
    """The architectural invariant, asserted directly.

    A body/form/file parameter in the signature is what put parsing ahead of
    authentication. This fails the moment someone reintroduces one.
    """
    import app.routes.profile as profile_routes

    route = next(r for r in profile_routes.router.routes if r.path == "/profile/import/file")

    assert route.body_field is None
    assert route.dependant.body_params == []
    assert list(inspect.signature(route.endpoint).parameters) == ["request", "user"]


# --------------------------------------------------------------------------- #
# 2. Media-type gate — authenticated, still before the parser
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("content_type", "expected_status"),
    [
        (None, 415),
        ("application/x-www-form-urlencoded", 415),
        ("application/json", 415),
        ("text/plain", 415),
        ("application/octet-stream", 415),
        ("multipart/form-data", 400),  # right media type, no boundary
    ],
)
def test_unsupported_media_types_are_rejected_without_parsing(
    client: TestClient,
    auth: dict[str, str],
    parser_spy: dict[str, int],
    content_type: str | None,
    expected_status: int,
) -> None:
    headers = dict(auth)
    if content_type is not None:
        headers["Content-Type"] = content_type

    response = client.post("/profile/import/file", content=b"a=1;" * 1000, headers=headers)

    assert response.status_code == expected_status
    assert parser_spy["multipart"] == 0
    assert parser_spy["urlencoded"] == 0, "a rejected media type still reached a form parser"


def test_rejected_media_type_does_not_leak_parser_internals(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/profile/import/file",
        content=b"{}",
        headers={**auth, "Content-Type": "application/json"},
    )

    assert response.status_code == 415
    detail = response.json()["detail"]
    assert "multipart/form-data" in detail
    for leak in ("Traceback", "python_multipart", "MultiPartParser", "boundary=", "starlette"):
        assert leak not in detail


# --------------------------------------------------------------------------- #
# 3. File size bounds
# --------------------------------------------------------------------------- #
class _FakeUpload:
    """Minimal UploadFile stand-in that streams a fixed body in chunks."""

    def __init__(self, payload: bytes) -> None:
        self._buffer = BytesIO(payload)

    async def read(self, size: int = -1) -> bytes:
        return self._buffer.read(size)


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [0, 1, 4096, MAX_UPLOAD_BYTES - 1, MAX_UPLOAD_BYTES])
async def test_read_upload_capped_accepts_everything_up_to_the_limit(size: int) -> None:
    payload = b"x" * size
    assert await read_upload_capped(_FakeUpload(payload)) == payload


@pytest.mark.asyncio
@pytest.mark.parametrize("excess", [1, 1024, 10 * 1024 * 1024])
async def test_read_upload_capped_rejects_one_byte_over_the_limit(excess: int) -> None:
    """The off-by-one boundary: exactly the limit passes, limit+1 does not."""
    with pytest.raises(UploadRejected) as raised:
        await read_upload_capped(_FakeUpload(b"x" * (MAX_UPLOAD_BYTES + excess)))

    assert raised.value.status_code == 413


@pytest.mark.asyncio
async def test_read_upload_capped_stops_early_instead_of_consuming_the_whole_file() -> None:
    """Proves the unbounded ``await file.read()`` is gone.

    The old code materialised the entire user-controlled file and only then
    checked its length. This counts how much of an oversized upload is actually
    consumed before the limit trips.
    """
    consumed = 0

    class CountingUpload:
        def __init__(self) -> None:
            self._remaining = 64 * 1024 * 1024  # 64MB of attacker-supplied bytes

        async def read(self, size: int = -1) -> bytes:
            nonlocal consumed
            take = min(size, self._remaining)
            self._remaining -= take
            consumed += take
            return b"x" * take

    with pytest.raises(UploadRejected):
        await read_upload_capped(CountingUpload())

    assert consumed <= MAX_UPLOAD_BYTES + 64 * 1024, "read past the limit before rejecting"


def test_oversized_upload_is_rejected_with_413(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/profile/import/file",
        headers=auth,
        data={"source_type": "resume"},
        files={"file": ("resume.pdf", b"x" * (MAX_UPLOAD_BYTES + 1), PDF_TYPE)},
    )

    assert response.status_code == 413
    assert "too large" in response.json()["detail"]


def test_body_far_above_the_request_cap_is_rejected_on_content_length(
    client: TestClient, auth: dict[str, str], parser_spy: dict[str, int]
) -> None:
    """A declared over-large body is refused before any parsing happens."""
    boundary = "qaboundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="resume.pdf"\r\n'
        f"Content-Type: {PDF_TYPE}\r\n\r\n"
    ).encode() + b"x" * (MAX_REQUEST_BODY_BYTES + 1) + f"\r\n--{boundary}--\r\n".encode()

    response = client.post(
        "/profile/import/file",
        content=body,
        headers={**auth, "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )

    assert response.status_code == 413
    assert parser_spy["multipart"] == 0, "Content-Length gate did not run before the parser"


def test_oversized_chunked_body_without_content_length_is_still_capped(
    client: TestClient, auth: dict[str, str]
) -> None:
    """The raw-body cap must not depend on a Content-Length header.

    httpx sends a generator body with chunked transfer encoding, so no
    Content-Length is present and only the streaming cap can stop it.
    """
    boundary = "qaboundary"

    def chunks():
        yield (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="resume.pdf"\r\n'
            f"Content-Type: {PDF_TYPE}\r\n\r\n"
        ).encode()
        for _ in range((MAX_REQUEST_BODY_BYTES // (64 * 1024)) + 4):
            yield b"x" * (64 * 1024)
        yield f"\r\n--{boundary}--\r\n".encode()

    response = client.post(
        "/profile/import/file",
        content=chunks(),
        headers={**auth, "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )

    assert response.status_code == 413


# --------------------------------------------------------------------------- #
# 4. Multipart structure limits
# --------------------------------------------------------------------------- #
def test_missing_file_field_is_rejected(client: TestClient, auth: dict[str, str]) -> None:
    # Built by hand: httpx downgrades a file-less ``data=`` post to
    # x-www-form-urlencoded, which this endpoint now refuses at the media-type
    # gate — that would test the wrong thing.
    body, content_type = multipart_body(fields={"source_type": "resume"})
    response = client.post(
        "/profile/import/file", headers={**auth, "Content-Type": content_type}, content=body
    )

    assert response.status_code == 422


def test_more_than_one_file_is_rejected(client: TestClient, auth: dict[str, str]) -> None:
    pdf = make_pdf(resume_text())
    response = client.post(
        "/profile/import/file",
        headers=auth,
        files=[
            ("file", ("resume.pdf", pdf, PDF_TYPE)),
            ("file", ("resume2.pdf", pdf, PDF_TYPE)),
        ],
    )

    assert response.status_code == 400
    assert MAX_UPLOAD_FILES == 1


def test_extra_form_fields_are_rejected(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/profile/import/file",
        headers=auth,
        data={"source_type": "resume", "unexpected": "x", "also_unexpected": "y"},
        files={"file": ("resume.pdf", make_pdf(resume_text()), PDF_TYPE)},
    )

    assert response.status_code == 400
    assert MAX_UPLOAD_FIELDS == 1


def test_oversized_non_file_field_is_rejected(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/profile/import/file",
        headers=auth,
        data={"source_type": "r" * (1024 * 1024)},
        files={"file": ("resume.pdf", make_pdf(resume_text()), PDF_TYPE)},
    )

    assert response.status_code == 400


def test_invalid_source_type_is_rejected(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/profile/import/file",
        headers=auth,
        data={"source_type": "not-a-real-source"},
        files={"file": ("resume.pdf", make_pdf(resume_text()), PDF_TYPE)},
    )

    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# 5. Per-part media-type hardening
# --------------------------------------------------------------------------- #
def test_file_part_without_a_content_type_is_rejected(client: TestClient, auth: dict[str, str]) -> None:
    """The allow-list used to be opt-out: omitting the part's Content-Type
    skipped the media-type check entirely and the file was judged on its
    filename alone.

    The body is hand-built because httpx infers a part Content-Type from the
    filename, so it cannot express "no Content-Type at all".
    """
    body, content_type = multipart_body(
        fields={"source_type": "resume"},
        files=[("file", "resume.pdf", make_pdf(resume_text()), None)],
    )
    response = client.post(
        "/profile/import/file", headers={**auth, "Content-Type": content_type}, content=body
    )

    assert response.status_code == 400
    assert "content type" in response.json()["detail"].lower()


def test_content_type_disagreeing_with_extension_is_rejected(client: TestClient, auth: dict[str, str]) -> None:
    """Both values are individually allow-listed, but the extension picks the
    parser, so a ``.pdf`` announced as ``text/plain`` is a contradiction."""
    response = client.post(
        "/profile/import/file",
        headers=auth,
        data={"source_type": "resume"},
        files={"file": ("resume.pdf", make_pdf(resume_text()), TXT_TYPE)},
    )

    assert response.status_code == 400
    assert "does not match its extension" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# 6. Supported formats still work, malformed documents fail cleanly
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("filename", "payload_factory", "content_type"),
    [
        ("resume.pdf", lambda: make_pdf(resume_text()), PDF_TYPE),
        ("resume.docx", lambda: make_docx(resume_text()), DOCX_TYPE),
        ("resume.txt", lambda: resume_text().encode("utf-8"), TXT_TYPE),
    ],
)
def test_supported_uploads_still_import(
    client: TestClient,
    auth: dict[str, str],
    filename: str,
    payload_factory,  # noqa: ANN001 - parametrized factory
    content_type: str,
) -> None:
    response = client.post(
        "/profile/import/file",
        headers=auth,
        data={"source_type": "resume"},
        files={"file": (filename, payload_factory(), content_type)},
    )

    assert response.status_code == 200, response.text
    draft = response.json()["draft"]
    assert draft["source_type"] == "resume"
    assert draft["basic_info"]["email"] == "demo@example.com"


def test_malformed_pdf_fails_cleanly_without_a_server_error(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/profile/import/file",
        headers=auth,
        data={"source_type": "resume"},
        files={"file": ("resume.pdf", b"%PDF-1.4\nnot really a pdf at all\n" + b"\x00" * 512, PDF_TYPE)},
    )

    assert response.status_code == 400
    assert response.status_code != 500
    assert "Traceback" not in response.text


def test_pdf_named_docx_and_docx_named_pdf_are_rejected_by_actual_structure() -> None:
    with pytest.raises(DocumentParserError):
        extract_text_from_docx(make_pdf(resume_text()))
    with pytest.raises(DocumentParserError):
        extract_text_from_pdf(make_docx(resume_text()))


def test_pdf_page_count_is_bounded_before_text_extraction() -> None:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer)
    for _ in range(MAX_PDF_PAGES + 1):
        pdf.drawString(72, 800, "bounded resume page")
        pdf.showPage()
    pdf.save()

    with pytest.raises(DocumentParserError, match="too complex"):
        extract_text_from_pdf(buffer.getvalue())


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"PK not a zip",
        make_zip([("unrelated.txt", b"not an office document")]),
        make_zip(
            [
                ("[Content_Types].xml", b"<Types/>"),
                ("word/document.xml", b"<broken"),
            ]
        ),
        make_zip(
            [
                ("[Content_Types].xml", b"<Types/>"),
                ("word/document.xml", b"<document/>"),
                ("../outside.xml", b"no extraction allowed"),
            ]
        ),
    ],
)
def test_malformed_or_non_docx_archives_fail_safely(payload: bytes) -> None:
    with pytest.raises(DocumentParserError):
        extract_text_from_docx(payload)


def test_docx_archive_member_count_is_bounded() -> None:
    entries = [
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", b"<document/>"),
        *[(f"word/item-{index}.xml", b"<x/>") for index in range(MAX_DOCX_MEMBERS)],
    ]
    with pytest.raises(DocumentParserError, match="too complex"):
        extract_text_from_docx(make_zip(entries))


def test_docx_decompression_ratio_is_bounded() -> None:
    amplification = b"A" * (MAX_DOCX_COMPRESSION_RATIO * 4096)
    payload = make_zip(
        [
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", amplification),
        ]
    )
    with pytest.raises(DocumentParserError, match="too complex"):
        extract_text_from_docx(payload)


# --------------------------------------------------------------------------- #
# 7. Patched dependency floors
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("package", "minimum", "advisory"),
    [
        ("python-multipart", (0, 0, 30), "GHSA-5rvq-cxj2-64vf quadratic querystring parsing"),
        ("python-multipart", (0, 0, 27), "GHSA-pp6c-gr5w-3c5g unbounded multipart part headers"),
        ("python-multipart", (0, 0, 18), "GHSA-59g5-xgcq-4qw3 deformed boundary DoS"),
        ("starlette", (0, 40, 0), "GHSA-f96h-pmfr-66vw multipart/form-data DoS"),
        ("starlette", (1, 3, 1), "GHSA-82w8-qh3p-5jfq request.form() limits ignored"),
        ("pypdf", (6, 14, 2), "GHSA-5xf7/g867 unterminated inline image infinite loop"),
    ],
)
def test_installed_dependency_meets_security_floor(
    package: str, minimum: tuple[int, ...], advisory: str
) -> None:
    """Fails if an environment regresses below a version that fixes a known,
    reachable form-parsing or document-parsing advisory."""
    from importlib.metadata import version

    installed = tuple(int(part) for part in version(package).split(".")[:3])
    assert installed >= minimum, f"{package}=={version(package)} is below the floor for {advisory}"
