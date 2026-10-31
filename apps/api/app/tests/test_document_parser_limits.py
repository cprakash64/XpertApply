"""PDF page cap: parsing cost scales with page count, so an over-long PDF is refused before any extraction."""

import io
import time

import pytest
from pypdf import PdfWriter
from reportlab.pdfgen import canvas

from app.services import document_parser as dp


def _blank_pdf(pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(612, 792)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _resume_pdf(pages: int = 2) -> bytes:
    out = io.BytesIO()
    pdf = canvas.Canvas(out)
    for page in range(pages):
        y = 780
        for line in ["Synthetic Tester", "EXPERIENCE", "Senior Engineer, Example Corp 2019-2024", "Built Python services at scale and led a team of five.",
                     "EDUCATION", "BS Computer Science, Example University 2015", "SKILLS", "Python, FastAPI, PostgreSQL, Docker and more."]:
            pdf.drawString(60, y, f"{line} {page}" if line == "EXPERIENCE" else line)
            y -= 18
        pdf.showPage()
    pdf.save()
    return out.getvalue()


class _Upload:
    filename = "resume.pdf"
    content_type = "application/pdf"


def test_a_normal_multi_page_resume_still_parses():
    text = dp.extract_uploaded_file_text(_Upload(), _resume_pdf(3))
    assert "Synthetic Tester" in text and len(text) >= dp.MIN_EXTRACTED_TEXT_CHARS


def test_exactly_the_page_cap_is_accepted():
    # blank pages carry no text, so the "no text" refusal (not the page cap) is what applies at the limit
    with pytest.raises(dp.DocumentParserError) as caught:
        dp.extract_uploaded_file_text(_Upload(), _blank_pdf(dp.MAX_PDF_PAGES))
    assert "too many pages" not in str(caught.value)


def test_one_page_over_the_cap_is_refused_with_a_clear_message():
    with pytest.raises(dp.DocumentParserError) as caught:
        dp.extract_uploaded_file_text(_Upload(), _blank_pdf(dp.MAX_PDF_PAGES + 1))
    assert "too many pages" in str(caught.value)
    assert str(dp.MAX_PDF_PAGES) in str(caught.value)


def test_a_page_bomb_is_refused_quickly_without_extracting_pages():
    bomb = _blank_pdf(20000)
    assert len(bomb) < dp.MAX_UPLOAD_BYTES
    started = time.monotonic()
    with pytest.raises(dp.DocumentParserError):
        dp.extract_uploaded_file_text(_Upload(), bomb)
    # extraction of 20,000 pages took ~12 s on pypdf 6.x; an honest bomb is refused from the declared count alone
    assert time.monotonic() - started < 2.0


def test_a_pdf_that_understates_its_page_count_is_still_refused():
    from pypdf.generic import NameObject, NumberObject

    writer = PdfWriter()
    for _ in range(5000):
        writer.add_blank_page(612, 792)
    writer._root_object["/Pages"][NameObject("/Count")] = NumberObject(1)
    out = io.BytesIO()
    writer.write(out)
    with pytest.raises(dp.DocumentParserError) as caught:
        dp.extract_uploaded_file_text(_Upload(), out.getvalue())
    assert "too many pages" in str(caught.value)
