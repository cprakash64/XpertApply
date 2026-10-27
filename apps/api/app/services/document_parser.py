import re
import stat
import zipfile
from io import BytesIO
from pathlib import Path, PurePosixPath

from docx import Document
from fastapi import UploadFile
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.core.config import settings

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MIN_EXTRACTED_TEXT_CHARS = 100
NO_TEXT_ERROR = (
    "We could not extract text from this file. Please upload a text-based PDF/DOCX " "or paste your resume text."
)

ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
}
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}


class DocumentParserError(ValueError):
    pass


class DocumentLimitError(DocumentParserError):
    pass


def bounded_text(parts) -> str:
    result = []
    total = 0
    for part in parts:
        total += len(part) + (1 if result else 0)
        if total > settings.document_max_chars:
            raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: extracted text is too large.")
        result.append(part)
    return normalize_extracted_text("\n".join(result))


def validate_docx_container(content: bytes) -> None:
    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 256:
                raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: too many document parts.")
            total = 0
            names = set()
            for entry in entries:
                name = entry.filename
                parts = PurePosixPath(name).parts
                if (
                    not name
                    or name.startswith("/")
                    or "\\" in name
                    or ".." in parts
                    or ":" in name
                    or name in names
                    or stat.S_ISLNK(entry.external_attr >> 16)
                ):
                    raise DocumentParserError("Unsafe document container.")
                names.add(name)
                if entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise DocumentParserError("Unsupported document compression.")
                if entry.flag_bits & 1:
                    raise DocumentParserError("Encrypted document containers are unsupported.")
                if entry.file_size > 4 * 1024 * 1024 or entry.file_size > 200 * max(1, entry.compress_size):
                    raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: document expansion is too large.")
                total += entry.file_size
                if total > 20 * 1024 * 1024:
                    raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: document expansion is too large.")
                actual = 0
                carry = b""
                with archive.open(entry) as part:
                    while chunk := part.read(65536):
                        actual += len(chunk)
                        if actual > min(entry.file_size, 4 * 1024 * 1024):
                            raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: document expansion is too large.")
                        if name.endswith(".xml") and (
                            b"<!DOCTYPE" in (carry + chunk).replace(b"\x00", b"")
                            or b"<!ENTITY" in (carry + chunk).replace(b"\x00", b"")
                        ):
                            raise DocumentParserError("Unsafe document XML.")
                        carry = chunk[-64:]
                if actual != entry.file_size:
                    raise DocumentParserError("Malformed document container.")
            if not {"[Content_Types].xml", "word/document.xml"}.issubset(names):
                raise DocumentParserError("This file is not a DOCX document.")
    except (zipfile.BadZipFile, RuntimeError, OSError, KeyError) as exc:
        raise DocumentParserError(NO_TEXT_ERROR) from exc


def validate_uploaded_file(file: UploadFile, content: bytes | None = None) -> None:
    filename = file.filename or ""
    extension = Path(filename).suffix.lower()
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()

    if extension not in ALLOWED_EXTENSIONS:
        raise DocumentParserError("Unsupported file extension. Upload a PDF, DOCX, or TXT file.")
    if content_type and content_type not in ALLOWED_CONTENT_TYPES:
        raise DocumentParserError("Unsupported file type. Upload a PDF, DOCX, or TXT file.")
    if content is not None:
        if not content:
            raise DocumentParserError("Uploaded file is empty.")
        if len(content) > settings.upload_max_bytes:
            raise DocumentLimitError("Uploaded file is too large. The limit is 5MB.")
        expected = {
            ".pdf": "application/pdf",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".txt": "text/plain",
        }[extension]
        if content_type and content_type != expected:
            raise DocumentParserError("File extension and type do not match.")
        if extension == ".pdf" and not content.startswith(b"%PDF-"):
            raise DocumentParserError(NO_TEXT_ERROR)
        if extension == ".docx" and not content.startswith(b"PK\x03\x04"):
            raise DocumentParserError(NO_TEXT_ERROR)
        if extension == ".txt" and (content.startswith((b"%PDF-", b"PK\x03\x04")) or b"\x00" in content):
            raise DocumentParserError("File content and extension do not match.")


def extract_text_from_pdf(content: bytes) -> str:
    try:
        reader = PdfReader(BytesIO(content))
        objects = sum(len(v) for v in reader.xref.values()) + len(reader.xref_objStm)
        if objects > settings.document_max_objects:
            raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: too many PDF objects.")
        if len(reader.pages) > settings.document_max_pages:
            raise DocumentLimitError("DOCUMENT_LIMIT_EXCEEDED: too many PDF pages.")
        text = bounded_text(page.extract_text() or "" for page in reader.pages)
    except DocumentLimitError:
        raise
    except (PdfReadError, OSError, ValueError, RecursionError) as exc:
        raise DocumentParserError(NO_TEXT_ERROR) from exc
    return normalize_extracted_text(text)


def extract_text_from_docx(content: bytes) -> str:
    validate_docx_container(content)
    try:
        document = Document(BytesIO(content))
        paragraphs = [paragraph.text for paragraph in document.paragraphs]
        table_cells = [cell.text for table in document.tables for row in table.rows for cell in row.cells if cell.text]
    except (ValueError, zipfile.BadZipFile, KeyError) as exc:
        raise DocumentParserError(NO_TEXT_ERROR) from exc
    return bounded_text([*paragraphs, *table_cells])


# Characters that PDF extraction commonly mangles, mapped to clean equivalents.
_CHAR_REPLACEMENTS = {
    "‣": "•",  # normalize assorted bullet glyphs to one form
    "▪": "•",
    "◦": "•",
    "⁃": "•",
    "": "•",  # Symbol-font bullet from Word/PDF
    "‘": "'",  # smart quotes
    "’": "'",
    "“": '"',
    "”": '"',
    "–": "-",  # en dash
    "—": "-",  # em dash
    "−": "-",  # minus sign
    " ": " ",  # non-breaking space
    "​": "",  # zero-width space
    "‌": "",  # zero-width non-joiner
    "‍": "",  # zero-width joiner
    "﻿": "",  # BOM
    "�": "",  # replacement character (hidden artifacts)
    "ﬁ": "fi",  # ligatures
    "ﬂ": "fl",
}

# Standalone page-number / artifact lines like "Page 1 of 2" or a bare "2".
_PAGE_ARTIFACT_RE = re.compile(r"^(page\s+\d+(\s+of\s+\d+)?|\d{1,3})$", re.IGNORECASE)


def normalize_extracted_text(text: str) -> str:
    for source, target in _CHAR_REPLACEMENTS.items():
        text = text.replace(source, target)
    # Re-join words broken across line boundaries by hyphenation ("infer-\nence").
    text = re.sub(r"([A-Za-z])-\n([a-z])", r"\1\2", text)

    normalized_lines: list[str] = []
    for line in text.splitlines():
        collapsed = re.sub(r"[ \t]+", " ", line).strip()
        if not collapsed:
            normalized_lines.append("")
            continue
        if _PAGE_ARTIFACT_RE.match(collapsed):
            continue  # drop page-number artifacts
        normalized_lines.append(collapsed)

    normalized = "\n".join(normalized_lines)
    return re.sub(r"\n{3,}", "\n\n", normalized).strip()


def detect_document_kind(text: str, filename: str | None = None) -> str:
    lower_text = text.lower()
    lower_name = (filename or "").lower()
    if "linkedin.com/in/" in lower_text or "contact info" in lower_text and "linkedin" in lower_text:
        return "linkedin_pdf"
    if "linkedin" in lower_name:
        return "linkedin_pdf"
    if any(marker in lower_text for marker in ["experience", "education", "skills"]):
        return "resume"
    return "unknown"


def extract_uploaded_file_text(file: UploadFile, content: bytes) -> str:
    validate_uploaded_file(file, content)
    extension = Path(file.filename or "").suffix.lower()
    if extension == ".pdf":
        text = extract_text_from_pdf(content)
    elif extension == ".docx":
        text = extract_text_from_docx(content)
    elif extension == ".txt":
        try:
            text = bounded_text([content.decode("utf-8")])
        except UnicodeDecodeError as exc:
            raise DocumentParserError("Text files must use UTF-8 encoding.") from exc
    else:
        raise DocumentParserError("Unsupported file extension. Upload a PDF, DOCX, or TXT file.")
    if len(text) < MIN_EXTRACTED_TEXT_CHARS:
        raise DocumentParserError(NO_TEXT_ERROR)
    return text
