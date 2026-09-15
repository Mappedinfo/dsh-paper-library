"""Selected-paper worker scope, fixed PDF sources and sourced fill-only writes."""
import hashlib

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, PaperConflictError
from dsh_paper_library import library_knowledge as knowledge
from dsh_paper_library import paper_analysis
from dsh_paper_library.worker import dispatch_request


@pytest.fixture
def catalog(tmp_path):
    path = tmp_path / "synthetic-source.pdf"
    with fitz.open() as doc:
        for index in range(12):
            page = doc.new_page()
            if index != 5:
                page.insert_text((40, 60), f"Synthetic page {index + 1}. Synthetic Journal. Accepted 2026-09-10.")
        doc.save(path)
    library = Library(tmp_path / "library")
    item = library.create({"title": "Synthetic selected paper", "citekey": "SyntheticSelected",
                           "DOI": "10.0000/synthetic-selected", "author": [{"family": "Existing"}],
                           "publication_dates": {"published": "2025"}})
    item = library.attach(item["id"], str(path))
    yield library, item, path
    library.close()


def call(library, action, **values):
    return dispatch_request({"library": str(library.root), "action": action, **values})


def prepare(library, item, **values):
    return call(library, "paper_analysis_sources", id=item["id"], **values)


def apply(library, item, source, metadata, **values):
    return call(library, "paper_analysis_apply_metadata", **{
        "id": item["id"], "expected_modified": item["modified"], "metadata": metadata,
        "field_sources": {field: [{"source_id": source["id"], "quote": "Synthetic Journal"}] for field in metadata},
        **values,
    })


def test_default_reads_only_three_pages_without_raster_or_pdf_mutation(catalog, monkeypatch):
    library, item, original = catalog
    managed = library.pdf_path(item["id"])
    before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in [original, managed]}
    loaded = []
    original_load = fitz.Document.load_page
    def load(doc, page):
        loaded.append(page)
        return original_load(doc, page)
    def forbidden(*args, **kwargs):
        pytest.fail("Source preparation must not render, iterate the document, or extract images")
    monkeypatch.setattr(fitz.Document, "load_page", load)
    monkeypatch.setattr(fitz.Document, "__iter__", forbidden, raising=False)
    monkeypatch.setattr(fitz.Page, "get_pixmap", forbidden)
    monkeypatch.setattr(fitz.Page, "get_images", forbidden)
    result = prepare(library, item)
    assert loaded == [0, 1, 2]
    assert result["expected_modified"] == item["modified"]
    assert result["coverage"]["read_pages"] == [1, 2, 3]
    assert result["coverage"]["page_count"] == 12
    assert result["coverage"]["full_document"] is False
    assert len(result["sources"]) == 3
    for page, source in enumerate(result["sources"], 1):
        assert source["locator"]["page"] == page
        assert source["kind"] == "source-note" and source["verification"] == "source-note"
        assert source["pdf_snapshot"]["scope"] == "selected-pages"
        assert source["pdf_snapshot"]["full_document"] is False
        assert "Synthetic page 12" not in source["text"]
        assert source["content_hash"] == knowledge.digest(source["text"])
    assert all(hashlib.sha256(path.read_bytes()).hexdigest() == value for path, value in before.items())
    assert library.get(item["id"])["modified"] == item["modified"]


def test_explicit_pages_preserve_actual_location_blank_coverage_and_snapshot(catalog):
    library, item, _ = catalog
    result = prepare(library, item, pages=[10, 6, 2])
    assert result["coverage"]["requested_pages"] == [10, 6, 2]
    assert result["coverage"]["read_pages"] == [10, 6, 2]
    assert result["coverage"]["blank_pages"] == [6]
    assert [source["locator"]["page"] for source in result["sources"]] == [10, 2]
    first = result["sources"][0]
    assert "Synthetic page 10" in first["text"]
    again = prepare(library, item, pages=[10])
    assert again["source_ids"] == [first["id"]]
    library.annotate(item["id"], page=10, type="note", comment="Later saved note")
    saved = call(library, "knowledge_source_get", id=first["id"])
    assert saved == first
    changed_file = prepare(library, item, pages=[10])
    assert changed_file["sources"][0]["text"] == first["text"]
    assert changed_file["source_ids"] != [first["id"]]


def test_text_budget_stops_before_loading_omitted_pages(catalog, monkeypatch):
    library, item, _ = catalog
    read = []
    def extract(page, mode, **kwargs):
        read.append(page.number)
        return f"Page {page.number + 1}: " + "a" * 10000
    monkeypatch.setattr(fitz.Page, "get_text", extract)
    result = prepare(library, item, pages=[2, 4, 6, 8, 10, 12])
    assert read == [1, 3, 5]
    assert result["coverage"]["characters"] == 24000
    assert result["coverage"]["truncated_pages"] == [2, 4, 6]
    assert result["coverage"]["omitted_pages"] == [8, 10, 12]
    assert all(len(source["text"]) == 8000 and source["pdf_snapshot"]["truncated"] for source in result["sources"])


@pytest.mark.parametrize("pages", [[], list(range(1, 10)), [1, 1], [0], [True], [1.5], "1", [2001]])
def test_invalid_selection_is_rejected_before_pdf_open(catalog, monkeypatch, pages):
    library, item, _ = catalog
    monkeypatch.setattr(Library, "_open_pdf", lambda *args, **kwargs: pytest.fail("Invalid selection opened a PDF"))
    with pytest.raises(ValueError, match="PAPER_ANALYSIS_INVALID"):
        prepare(library, item, pages=pages)


def test_nonexistent_page_is_rejected_without_partial_sources(catalog):
    library, item, _ = catalog
    with pytest.raises(ValueError, match="does not exist"):
        prepare(library, item, pages=[1, 13])
    assert not library.db.execute("SELECT 1 FROM sqlite_master WHERE name='knowledge_sources'").fetchone()


def test_metadata_only_does_not_open_pdf_and_explicit_pages_fail(catalog, monkeypatch):
    library, _, _ = catalog
    item = library.create({"title": "Synthetic metadata-only item"})
    monkeypatch.setattr(Library, "_open_pdf", lambda *args, **kwargs: pytest.fail("No PDF should be opened"))
    result = prepare(library, item)
    assert result["sources"] == [] and result["coverage"]["scope"] == "metadata-only"
    with pytest.raises(ValueError, match="without an attached PDF"):
        prepare(library, item, pages=[1])


def test_fill_retains_existing_metadata_and_uses_pdf_backup_path(catalog):
    library, item, _ = catalog
    source = prepare(library, item)["sources"][0]
    managed = library.pdf_path(item["id"])
    before = hashlib.sha256(managed.read_bytes()).hexdigest()
    result = apply(library, item, source, {
        "title": "Attempt to replace existing title", "author": [{"family": "Replacement"}],
        "container-title": "Synthetic Journal", "language": "en",
        "publication_dates": {"published": "2026", "accepted": "2026-09-10"},
    })
    saved = result["paper"]
    assert saved["title"] == item["title"] and saved["author"] == item["author"]
    assert saved["DOI"] == item["DOI"] and saved["citekey"] == item["citekey"]
    assert saved["publication_dates"] == {"published": "2025", "accepted": "2026-09-10"}
    assert saved["container-title"] == "Synthetic Journal"
    assert set(result["applied_fields"]) == {"container-title", "language", "publication_dates.accepted"}
    assert set(result["skipped_fields"]) == {"title", "author", "publication_dates.published"}
    provenance = saved["analysis_metadata_sources"]["container-title"]
    assert provenance["origin"] == "llm" and provenance["review_status"] == "needs-review"
    assert "reviewed_by" not in provenance
    assert provenance["sources"][0]["source_id"] == source["id"]
    backup = library.root / "backups" / (item["id"] + ".pdf.bak")
    assert hashlib.sha256(backup.read_bytes()).hexdigest() == before
    with fitz.open(library.pdf_path(item["id"])) as doc:
        assert b'Synthetic Journal' in doc.embfile_get("paper-library.csl.json")


def test_noop_does_not_rewrite_pdf_or_stamp(catalog, monkeypatch):
    library, item, _ = catalog
    source = prepare(library, item)["sources"][0]
    monkeypatch.setattr(Library, "_update_pdf_metadata", lambda *args, **kwargs: pytest.fail("No-op rewrote PDF"))
    result = apply(library, item, source, {"title": "Different proposal"})
    assert result["applied_fields"] == [] and result["skipped_fields"] == ["title"]
    assert result["paper"]["modified"] == item["modified"]


def test_stale_metadata_and_update_race_fail_with_current_record(catalog, monkeypatch):
    library, item, _ = catalog
    source = prepare(library, item)["sources"][0]
    new = library.update(item["id"], {"language": "en"})
    with pytest.raises(PaperConflictError) as caught:
        apply(library, item, source, {"container-title": "Synthetic Journal"})
    assert caught.value.current["modified"] == new["modified"]
    original_update = Library.update
    def racing_update(instance, id, metadata, expected_modified=None):
        original_update(instance, id, {"abstract": "Manual concurrent edit"})
        return original_update(instance, id, metadata, expected_modified=expected_modified)
    monkeypatch.setattr(Library, "update", racing_update)
    with pytest.raises(PaperConflictError):
        apply(library, new, source, {"container-title": "Synthetic Journal"})
    assert "container-title" not in library.get(item["id"])
    assert library.get(item["id"])["abstract"] == "Manual concurrent edit"


@pytest.mark.parametrize("metadata", [{"DOI": "10.0000/different"}, {"citekey": "different"}, {"type": "book"}, {"provenance": {"verified": True}}, {"issued": 2026}, {"publication_dates": {"accepted": "2026-02-30"}}])
def test_protected_identity_or_malformed_metadata_never_applies(catalog, metadata):
    library, item, _ = catalog
    source = prepare(library, item)["sources"][0]
    with pytest.raises(ValueError):
        apply(library, item, source, metadata)
    assert library.get(item["id"])["modified"] == item["modified"]


def test_metadata_sources_must_be_exact_and_owned_by_same_paper(catalog):
    library, item, _ = catalog
    source = prepare(library, item)["sources"][0]
    with pytest.raises(ValueError, match="exact saved excerpt"):
        apply(library, item, source, {"language": "en"}, field_sources={"language": [{"source_id": source["id"], "quote": "Fabricated evidence"}]})
    other = library.create({"title": "Other synthetic item"})
    with pytest.raises(ValueError, match="another item"):
        apply(library, other, source, {"language": "en"})
    with pytest.raises(ValueError, match="cover exactly"):
        apply(library, item, source, {"language": "en"}, field_sources={})
    assert library.get(item["id"])["modified"] == item["modified"]


def test_client_cannot_forge_pdf_extractor_provenance(catalog):
    library, item, _ = catalog
    value = call(library, "knowledge_source_put", entity={"kind": "paper", "id": item["id"]},
                 kind="source-note", text="User-provided note", pdf_snapshot={"full_document": True})
    assert "pdf_snapshot" not in value
    assert value["verification"] == "source-note"
