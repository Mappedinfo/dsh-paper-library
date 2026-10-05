import json
import os
import subprocess
import sys
from pathlib import Path

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from pdf_metadata_probe import probe


def make_pdf(path, *, info=None, text="", csl=None):
    with fitz.open() as doc:
        page = doc.new_page()
        if text:
            page.insert_textbox(fitz.Rect(72, 72, 520, 760), text)
        if info:
            doc.set_metadata(info)
        if csl is not None:
            doc.embfile_add("paper-library.csl.json", json.dumps(csl).encode(), filename="paper-library.csl.json")
        doc.save(path)


def test_reads_pdf_info_and_embedded_csl_without_modifying_file(tmp_path):
    path = tmp_path / "metadata.pdf"
    csl = {"title": "Portable title", "type": "article-journal", "author": [{"family": "Example"}]}
    make_pdf(path, info={"title": "Info title", "author": "A. Writer", "subject": "Study", "keywords": "one; two"}, csl=csl)
    before = path.read_bytes()
    result = probe(path)
    assert result["status"] == "ok"
    assert result["info"] == {"title": "Info title", "author": "A. Writer", "subject": "Study", "keywords": "one; two"}
    assert result["embedded_csl"] == csl
    assert {"dev", "ino", "ctime_ns"}.issubset(result["stat"])
    assert path.read_bytes() == before


def test_dates_are_not_inferred_from_pdf_info(tmp_path):
    path = tmp_path / "dated.pdf"
    make_pdf(path, info={"creationDate": "D:20200101000000Z", "modDate": "D:20250101000000Z"})
    result = probe(path)
    assert result["status"] == "ok"
    assert result["embedded_csl"] is None
    assert "issued" not in result["info"]


def test_doi_candidates_come_from_first_page_only_and_are_bounded(tmp_path):
    path = tmp_path / "doi.pdf"
    text = "\n".join(f"doi 10.1234/example.{i}" for i in range(12))
    make_pdf(path, text=text)
    result = probe(path)
    assert len(result["doi_candidates"]) == 8
    assert result["doi_candidates"][0] == "10.1234/example.0"


def test_rejects_symlink_and_non_pdf_safely(tmp_path):
    target = tmp_path / "target.pdf"
    target.write_bytes(b"not a pdf")
    link = tmp_path / "link.pdf"
    link.symlink_to(target)
    linked = probe(link)
    assert linked["status"] == "error"
    assert linked["warnings"] == ["not_regular_file"]
    broken = probe(target)
    assert broken["status"] == "unreadable_pdf"
    assert "pdf_parse_failed" in broken["warnings"]
    assert all("not a pdf" not in warning for warning in broken["warnings"])


def test_empty_pdf_metadata_is_not_reported_as_failure(tmp_path):
    path = tmp_path / "empty.pdf"
    make_pdf(path)
    result = probe(path)
    assert result["status"] == "ok"
    assert result["info"] == {"title": "", "author": "", "subject": "", "keywords": ""}
    assert not result["warnings"]


def test_invalid_embedded_csl_does_not_hide_info_or_doi(tmp_path):
    path = tmp_path / "bad-csl.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((72, 72), "DOI 10.1234/kept")
        doc.embfile_add("paper-library.csl.json", b"{invalid", filename="paper-library.csl.json")
        doc.set_metadata({"title": "Still readable"})
        doc.save(path)
    result = probe(path)
    assert result["status"] == "ok"
    assert result["info"]["title"] == "Still readable"
    assert result["doi_candidates"] == ["10.1234/kept"]
    assert result["embedded_csl"] is None
    assert "embedded_csl_invalid" in result["warnings"]


def test_cli_stdout_is_safe_json_without_source_path(tmp_path):
    path = tmp_path / "private-name.pdf"
    make_pdf(path, info={"title": "Example"})
    result = subprocess.run([sys.executable, "scripts/pdf_metadata_probe.py", "--path", str(path)], capture_output=True, text=True, check=True)
    value = json.loads(result.stdout)
    assert value["status"] == "ok"
    assert str(path) not in result.stdout
    assert result.stderr == ""
