"""Professional, ATS-safe filenames for downloaded documents.

Root cause of "Tailored_Resume_-_Affirm_-_Software_Engineer_II,_Backend_(Test_
Infra).pdf": the download route used ``GeneratedDocument.title`` — an internal
display label built as ``f"Tailored Resume - {company} - {job.title}"`` — as
the literal filename stem, with only a single ``.replace(' ', '_')``. That
title is meant for internal UI display, not as a filename: it embeds the full
job title (which can contain commas/parens/slashes) and the word "Tailored".

This module is the one place a downloadable filename is built. It never uses
the internal title; it builds from the verified profile name.
"""

from __future__ import annotations

import re

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")
_REPEATED_UNDERSCORE = re.compile(r"_+")
MAX_STEM_LENGTH = 80


def _sanitize(part: str) -> str:
    part = part.strip().replace(" ", "_")
    part = _UNSAFE.sub("_", part)
    part = _REPEATED_UNDERSCORE.sub("_", part).strip("_")
    return part


def _name_stem(*, full_name: str | None, first_name: str | None, last_name: str | None) -> str:
    # First+last only — a middle name does not belong in a document filename.
    if first_name and last_name:
        stem = _sanitize(f"{first_name}_{last_name}")
    elif full_name:
        stem = _sanitize(full_name)
    else:
        stem = ""
    return stem or "Applicant"


def build_document_filename(
    *,
    kind: str,  # "resume" | "cover-letter" | "cover_letter"
    fmt: str,
    full_name: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
    company: str | None = None,
) -> str:
    """Build a short, sanitized, professional filename. Never includes the job
    title, "Tailored", internal IDs, or "undefined"/"null"."""
    name_stem = _name_stem(full_name=full_name, first_name=first_name, last_name=last_name)
    is_cover_letter = kind in ("cover-letter", "cover_letter")
    label = "Cover_Letter" if is_cover_letter else "Resume"

    stem = f"{name_stem}_{label}"
    if is_cover_letter and company:
        company_part = _sanitize(company)
        if company_part:
            candidate = f"{stem}_{company_part}"
            if len(candidate) <= MAX_STEM_LENGTH:
                stem = candidate

    stem = stem[:MAX_STEM_LENGTH].rstrip("_") or "Applicant_Document"
    extension = _sanitize(fmt).lower() or "pdf"
    return f"{stem}.{extension}"


def build_tracker_document_filename(*, kind: str, fmt: str, company: str | None, date: str | None) -> str:
    """``Plaid_Resume_2026-10-24.pdf``: company, document type and (when known) the application date.

    Built only from sanitized parts, so no path separator, quote, newline or header-injection character can reach a
    Content-Disposition value. Never the internal title, an id, or "undefined"."""
    label = "Cover_Letter" if kind in ("cover-letter", "cover_letter") else "Resume"
    parts = [_sanitize(company or "")[:40], label]
    if date and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        parts.append(date)
    stem = "_".join(part for part in parts if part)[:MAX_STEM_LENGTH].strip("_") or label
    ext = fmt if fmt in ("pdf", "docx") else "pdf"
    return f"{stem}.{ext}"
