import asyncio
import io
import zipfile

import pytest
from fastapi import HTTPException, UploadFile
from pypdf import PdfWriter
from starlette.datastructures import Headers

from app.core.config import settings
from app.core.resource_middleware import ResourceMiddleware
from app.services import document_parser as parser
from app.services import upload_processing as processing


@pytest.mark.parametrize("delta", [-1, 0, 1])
def test_bounded_copy(delta, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "upload_max_bytes", 1024)
    file = UploadFile(io.BytesIO(b"x" * (1024 + delta)), filename="../../resume.txt")
    if delta > 0:
        with pytest.raises(HTTPException) as e:
            asyncio.run(processing.copy_upload(file, tmp_path / "input"))
        assert e.value.status_code == 413
    else:
        asyncio.run(processing.copy_upload(file, tmp_path / "input"))
        assert (tmp_path / "input").stat().st_size == 1024 + delta


@pytest.mark.parametrize("header", [None, b"1", b"999999999"])
def test_actual_received_body_boundary(header, monkeypatch):
    monkeypatch.setattr(settings, "upload_max_bytes", 1024)
    reads = []
    messages = []

    async def inner(scope, receive, send):
        try:
            while (await receive()).get("more_body"):
                pass
        except Exception:
            pass
        await send({"type": "http.response.start", "status": 400, "headers": []})
        await send({"type": "http.response.body", "body": b"rejected"})

    async def receive():
        reads.append(1)
        return {"type": "http.request", "body": b"x" * 40000, "more_body": True}

    async def send(msg):
        messages.append(msg)

    headers = [] if header is None else [(b"content-length", header)]
    asyncio.run(
        ResourceMiddleware(inner)(
            {"type": "http", "path": "/profile/import/file", "method": "POST", "headers": headers}, receive, send
        )
    )
    assert len(reads) == 2
    assert messages[0]["status"] == 413


def test_pdf_pages_and_output(monkeypatch):
    writer = PdfWriter()
    for _ in range(3):
        writer.add_blank_page(width=10, height=10)
    b = io.BytesIO()
    writer.write(b)
    monkeypatch.setattr(settings, "document_max_pages", 2)
    with pytest.raises(parser.DocumentLimitError):
        parser.extract_text_from_pdf(b.getvalue())
    monkeypatch.setattr(settings, "document_max_chars", 100)
    with pytest.raises(parser.DocumentLimitError):
        parser.bounded_text(["x" * 101])


@pytest.mark.parametrize("case", ["entries", "ratio", "traversal", "absolute", "duplicate", "malformed"])
def test_docx_container_security(case):
    b = io.BytesIO()
    if case == "malformed":
        content = b"PKnot a zip"
    else:
        with zipfile.ZipFile(b, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("[Content_Types].xml", "x")
            z.writestr("word/document.xml", "x")
            if case == "entries":
                for i in range(256):
                    z.writestr(str(i), "x")
            if case == "ratio":
                z.writestr("bomb.xml", "a" * 100000)
            if case == "traversal":
                z.writestr("../outside", "x")
            if case == "absolute":
                z.writestr("/outside", "x")
            if case == "duplicate":
                z.writestr("word/document.xml", "x")
        content = b.getvalue()
    with pytest.raises(parser.DocumentParserError):
        parser.validate_docx_container(content)


@pytest.mark.parametrize(
    "extension,mime,content",
    [
        (".txt", "application/pdf", b"x" * 100),
        (".txt", "text/plain", b"%PDF-" + b"x" * 100),
        (".pdf", "application/pdf", b"x" * 100),
        (".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", b"x" * 100),
    ],
)
def test_type_mismatch(extension, mime, content):
    file = UploadFile(io.BytesIO(content), filename="file" + extension, headers=Headers({"content-type": mime}))
    with pytest.raises(parser.DocumentParserError):
        parser.extract_uploaded_file_text(file, content)


def test_isolated_parser_and_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(processing.tempfile, "tempdir", str(tmp_path))
    file = UploadFile(
        io.BytesIO(b"Experience Python Engineer " * 20),
        filename="../../resume.txt",
        headers=Headers({"content-type": "text/plain"}),
    )
    result = asyncio.run(processing.parse_upload(file))
    assert "Experience" in result and file.file.closed
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("outcome", ["timeout", "cancel", "error"])
def test_parser_kills_reaps_and_cleans(outcome, tmp_path, monkeypatch):
    monkeypatch.setattr(processing.tempfile, "tempdir", str(tmp_path))
    killed = []

    class Process:
        returncode = None
        pid = 87654321

        async def wait(self):
            if killed:
                self.returncode = -9
                return -9
            if outcome == "error":
                self.returncode = 1
                return 1
            if outcome == "cancel":
                raise asyncio.CancelledError()
            await asyncio.Future()

    async def spawn(*args, **kwargs):
        return Process()

    monkeypatch.setattr(processing.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(processing.os, "killpg", lambda *args: killed.append(args))
    monkeypatch.setattr(settings, "document_timeout_seconds", 0.01)
    file = UploadFile(io.BytesIO(b"text" * 40), filename="file.txt", headers=Headers({"content-type": "text/plain"}))
    error = (
        asyncio.CancelledError
        if outcome == "cancel"
        else (HTTPException if outcome == "timeout" else parser.DocumentLimitError)
    )
    with pytest.raises(error):
        asyncio.run(processing.parse_upload(file))
    assert file.file.closed and not list(tmp_path.iterdir())
    if outcome != "error":
        assert killed


def test_real_child_timeout_is_killed_and_reaped(tmp_path, monkeypatch):
    import sys

    original = asyncio.create_subprocess_exec
    children = []

    async def spawn(*args, **kwargs):
        process = await original(sys.executable, "-c", "import time; time.sleep(60)", **kwargs)
        children.append(process)
        return process

    monkeypatch.setattr(processing.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(processing.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(settings, "document_timeout_seconds", 0.05)
    file = UploadFile(
        io.BytesIO(b"Experience " * 20), filename="file.txt", headers=Headers({"content-type": "text/plain"})
    )
    with pytest.raises(HTTPException) as e:
        asyncio.run(processing.parse_upload(file))
    assert e.value.headers["X-Error-Code"] == "PARSER_TIMEOUT"
    assert len(children) == 1 and children[0].returncode == -9
    assert file.file.closed and not list(tmp_path.iterdir())
