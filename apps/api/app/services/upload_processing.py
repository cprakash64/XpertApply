"""Bounded spooled-file transfer and cancellable, isolated document parsing."""

import asyncio
import json
import os
import signal
import sys
import tempfile
from pathlib import Path

from fastapi import UploadFile

from app.core.config import settings
from app.core.resource_controls import limit_error
from app.services.document_parser import NO_TEXT_ERROR, DocumentLimitError, DocumentParserError


async def copy_upload(file: UploadFile, destination: Path):
    total = 0
    with destination.open("xb") as stream:
        os.chmod(destination, 0o600)
        while chunk := await file.read(65536):
            total += len(chunk)
            if total > settings.upload_max_bytes:
                raise limit_error("UPLOAD_TOO_LARGE", 413)
            stream.write(chunk)
    if total == 0:
        raise DocumentParserError("Uploaded file is empty.")


async def parse_upload(file: UploadFile) -> str:
    # Authentication and shared admission precede this function. No pending
    # parser queue exists: occupied user/global capacity responds 503 immediately.
    extension = Path(file.filename or "").suffix.lower()
    mime = (file.content_type or "").split(";", 1)[0].strip().lower()
    from app.services.document_parser import validate_uploaded_file

    validate_uploaded_file(file)
    process = None
    with tempfile.TemporaryDirectory(prefix="xa-document-") as directory:
        source = Path(directory) / "input"
        output = Path(directory) / "result"
        try:
            await copy_upload(file, source)
            # Pass only parser settings, never provider keys, database credentials,
            # uploaded names or user text as arguments/environment variables.
            env = {"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8"}
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
            for key in (
                "upload_max_bytes",
                "document_max_pages",
                "document_max_objects",
                "document_max_chars",
                "document_timeout_seconds",
                "document_memory_mb",
            ):
                env[key.upper()] = str(getattr(settings, key))
            spawn = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "app.services.document_worker",
                    str(source),
                    str(output),
                    extension,
                    mime,
                    env=env,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    start_new_session=True,
                )
            )
            try:
                process = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                process = await spawn
                raise
            try:
                await asyncio.wait_for(process.wait(), timeout=settings.document_timeout_seconds)
            except TimeoutError:
                raise limit_error("PARSER_TIMEOUT", 503) from None
            if process.returncode or not output.exists():
                raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: document could not be processed safely.")
            if output.stat().st_size > settings.document_max_chars * 8 + 4096:
                raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: parser output is too large.")
            with output.open("r", encoding="utf-8") as stream:
                result = json.loads(stream.read(settings.document_max_chars * 8 + 4097))
            if result.get("limit"):
                raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: document exceeds a processing limit.")
            if result.get("error") or not isinstance(result.get("text"), str):
                raise DocumentParserError(NO_TEXT_ERROR)
            if len(result["text"]) > settings.document_max_chars:
                raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: extracted text is too large.")
            return result["text"]
        finally:
            if process is not None and process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                # Reap despite cancellation before deleting the input/result.
                task = asyncio.create_task(process.wait())
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    await task
                    raise
            await file.close()
