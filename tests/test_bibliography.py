"""Canonical bibliography audit and atomic export writes (synthetic records only)."""
import json

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library
from dsh_paper_library.worker import dispatch_request


@pytest.fixture
def library(tmp_path):
    instance = Library(tmp_path / "library")
    yield instance
    instance.close()


def call(library, action, **values):
    return dispatch_request({"library": str(library.root), "action": action, **values})


def add_pdf(library, item, tmp_path, name):
    path = tmp_path / name
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 60), f"Synthetic body for {name}.")
        doc.save(path)
    return library.attach(item["id"], str(path))


def test_audit_reports_identity_facts_without_inventing_values(library, tmp_path):
    complete = library.create({"title": "Complete record", "citekey": "complete2026", "DOI": "10.0000/COMPLETE",
                               "author": [{"family": "Existing"}], "issued": {"date-parts": [[2026]]}})
    add_pdf(library, complete, tmp_path, "complete.pdf")
    sparse = library.create({"title": "Sparse record", "citekey": "sparse2026"})
    empty = library.create({"title": "Metadata only", "citekey": "empty2026", "DOI": "10.0000/empty"})
    audit = call(library, "bibliography_audit")
    assert audit["schema"] == "paper-library-bibliography-audit.v1"
    assert audit["totals"] == {"records": 3, "with_pdf": 1, "pdf_files_present": 1, "pdf_files_missing": 0}
    assert audit["missing"]["doi"]["ids"] == [sparse["id"]]
    assert set(audit["missing"]["author"]["ids"]) == {sparse["id"], empty["id"]}
    assert audit["missing"]["year"]["count"] == 2
    assert audit["citekey_conflicts"] == [] and audit["doi_duplicates"] == []
    record = next(item for item in audit["records"] if item["id"] == complete["id"])
    assert record["doi"] == "10.0000/complete" and record["pdf_file_present"] is True and record["year"] == 2026


def test_audit_flags_duplicate_doi_and_missing_managed_file(library, tmp_path):
    first = library.create({"title": "First", "citekey": "first2026", "DOI": "10.0000/shared"})
    second = library.create({"title": "Second", "citekey": "second2026"})
    # Catalog writes reject duplicate DOIs today; model a legacy/externally
    # damaged catalog row to prove the audit still reports the collision.
    with library.lock():
        library.db.execute("UPDATE papers SET doi=? WHERE id=?", ("10.0000/shared", second["id"]))
        library.db.execute("UPDATE papers SET metadata=json_set(metadata,'$.DOI','10.0000/shared') WHERE id=?", (second["id"],))
    attached = add_pdf(library, first, tmp_path, "first.pdf")
    library.pdf_path(attached["id"]).unlink()  # A managed file removed outside the plugin.
    audit = call(library, "bibliography_audit")
    assert audit["doi_duplicate_count"] == 1
    assert audit["doi_duplicates"][0]["doi"] == "10.0000/shared"
    assert set(audit["doi_duplicates"][0]["ids"]) == {first["id"], second["id"]}
    assert audit["totals"]["pdf_files_missing"] == 1
    assert audit["pdf_missing"]["ids"] == [attached["id"]]


def test_archived_records_are_excluded(library):
    item = library.create({"title": "Trashed", "citekey": "trashed2026", "DOI": "10.0000/trashed"})
    library.archive(item["id"])
    audit = call(library, "bibliography_audit")
    assert audit["totals"]["records"] == 0 and audit["records"] == []


def test_write_export_replaces_atomically_and_stays_inside_exports(library):
    library.create({"title": "Recorded", "citekey": "recorded2026"})
    audit = call(library, "bibliography_audit")
    result = call(library, "bibliography_write", bib_text="@article{recorded2026, title={Recorded}}\n", audit=audit)
    bib_path = library.root / "exports" / "references.bib"
    audit_path = library.root / "exports" / "bibliography.audit.json"
    assert result["bib_path"] == str(bib_path) and bib_path.read_text().startswith("@article")
    saved = json.loads(audit_path.read_text())
    assert saved["schema"] == "paper-library-bibliography-audit.v1" and saved["totals"]["records"] == 1
    again = call(library, "bibliography_write", bib_text="@article{recorded2026, title={Recorded}, year={2026}}\n", audit=audit)
    assert bib_path.read_text().count("year") == 1
    assert not list((library.root / "exports").glob("*.tmp-*"))


def test_write_export_validates_shape_and_budgets(library):
    audit = call(library, "bibliography_audit")
    with pytest.raises(ValueError, match="bib_text"):
        call(library, "bibliography_write", bib_text="", audit=audit)
    with pytest.raises(ValueError, match="audit"):
        call(library, "bibliography_write", bib_text="@article{x}", audit={"schema": "other"})
    with pytest.raises(ValueError, match="24 MiB"):
        call(library, "bibliography_write", bib_text="x" * (24 * 1024 * 1024 + 1), audit=audit)
