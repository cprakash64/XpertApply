"""Synthetic document parity for the RB01 parser security update."""
from io import BytesIO

import pytest
from docx import Document
from fastapi import UploadFile
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError
from reportlab.pdfgen import canvas
from starlette.datastructures import Headers

from app.services import document_parser as parser

TEXT = "Synthetic engineer experience in Python, testing, education and system design. " * 3


def pdf_bytes(pages=1):
    output = BytesIO()
    pdf = canvas.Canvas(output, invariant=1)
    for index in range(pages):
        pdf.drawString(30, 750, f"Synthetic page {index + 1}")
        pdf.drawString(30, 730, TEXT)
        pdf.showPage()
    pdf.save()
    return output.getvalue()


def upload(name, mime):
    return UploadFile(filename=name, file=BytesIO(), headers=Headers({"content-type": mime}))


@pytest.mark.parametrize("pages", [1, 3])
def test_valid_pdf_text_and_page_order(pages):
    content = pdf_bytes(pages)
    result = parser.extract_uploaded_file_text(upload("synthetic.pdf", "application/pdf"), content)
    assert result.count(TEXT.strip()) == pages
    assert [result.index(f"Synthetic page {i + 1}") for i in range(pages)] == sorted(
        result.index(f"Synthetic page {i + 1}") for i in range(pages)
    )
    assert PdfReader(BytesIO(content)).metadata.title == "untitled"


@pytest.mark.parametrize("content", [b"not a pdf", b"%PDF-1.4\n1 0 obj\n<<", pdf_bytes()[:80]])
def test_malformed_and_truncated_pdf(content):
    with pytest.raises(parser.DocumentParserError, match="could not extract text"):
        parser.extract_uploaded_file_text(upload("broken.pdf", "application/pdf"), content)


def test_password_protected_pdf_keeps_public_error_contract():
    writer = PdfWriter()
    writer.append(PdfReader(BytesIO(pdf_bytes())))
    writer.encrypt("synthetic-test-password")
    output = BytesIO()
    writer.write(output)
    with pytest.raises(parser.DocumentParserError, match="could not extract text"):
        parser.extract_uploaded_file_text(upload("locked.pdf", "application/pdf"), output.getvalue())


def test_zero_byte_rejected():
    with pytest.raises(parser.DocumentParserError, match="empty"):
        parser.extract_uploaded_file_text(upload("empty.pdf", "application/pdf"), b"")


def test_docx_paragraph_and_table_parity():
    doc = Document()
    doc.add_paragraph(TEXT)
    doc.add_table(rows=1, cols=1).cell(0, 0).text = "Synthetic table skills"
    output = BytesIO()
    doc.save(output)
    result = parser.extract_uploaded_file_text(
        upload("synthetic.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        output.getvalue(),
    )
    assert TEXT.strip() in result
    assert result.endswith("Synthetic table skills")


@pytest.mark.parametrize("content", [b"broken zip", b"PK\x03\x04broken"])
def test_corrupted_docx_error(content):
    with pytest.raises(parser.DocumentParserError, match="could not extract text"):
        parser.extract_uploaded_file_text(
            upload("broken.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), content
        )


def test_renamed_pdf_cannot_be_read_as_docx():
    with pytest.raises(parser.DocumentParserError, match="could not extract text"):
        parser.extract_uploaded_file_text(
            upload("renamed.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            pdf_bytes(),
        )


def test_unsupported_extension():
    with pytest.raises(parser.DocumentParserError, match="Unsupported file extension"):
        parser.extract_uploaded_file_text(upload("unsupported.exe", "application/pdf"), pdf_bytes())


def test_pdf_parser_failure_has_deterministic_public_error(monkeypatch):
    def fail(_):
        raise PdfReadError("synthetic parser failure")
    monkeypatch.setattr(parser, "PdfReader", fail)
    with pytest.raises(parser.DocumentParserError, match="could not extract text") as error:
        parser.extract_text_from_pdf(pdf_bytes())
    assert isinstance(error.value.__cause__, PdfReadError)
