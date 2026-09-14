"""Synthetic PDF contracts for complete, versioned conversation references."""
import json

import pymupdf as fitz
import pytest

import dsh_paper_library.core as core
from dsh_paper_library.core import Library, dispatch


def prepare(tmp_path, count=45, comment=None):
    source = tmp_path / "reference-source.pdf"
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((40, 40), "Synthetic source text for reference tests.")
        for index in range(count):
            note = page.add_text_annot((40, 70 + index % 20 * 20), comment or f"Reader note {index}")
            document.xref_set_key(note.xref, "NM", fitz.get_pdf_str(f"note-{index}"))
            note.update()
        ai = page.add_text_annot((80, 80), "Generated reply, excluded from source references")
        ai.set_info(subject="paper-library:" + json.dumps({"kind": "ai-feedback"}))
        ai.update()
        document.save(source)
    library = Library(tmp_path / "library")
    item = library.import_items(path=str(source))["items"][0]
    return library, item


def refs(catalog):
    return [{"id": value["id"], "version": value["version"]} for value in catalog["annotations"]]


def test_all_more_than_40_is_complete_and_excludes_generated_feedback(tmp_path):
    library, item = prepare(tmp_path)
    try:
        catalog = library.annotation_catalog(item["id"])
        assert catalog["total"] == catalog["returned"] == 45
        assert catalog["total_exact"] and not catalog["truncated"]
        assert all(value["identity_reliable"] for value in catalog["annotations"])
        context = library.annotation_context_exact(item["id"], refs(catalog))
        assert len(context["annotations"]) == 45
        assert context["coverage"] == {"requested": 45, "included": 45, "total": 45, "total_exact": True, "all": True}
        assert context["source_characters"] == sum(len(f"Reader note {i}") for i in range(45))
        assert "Generated reply" not in json.dumps(context)
    finally:
        library.close()


def test_long_whole_notes_are_not_trimmed_and_over_budget_is_explicit(tmp_path):
    text = "Long source comment. " * 180
    library, item = prepare(tmp_path, count=2, comment=text)
    try:
        catalog = library.annotation_catalog(item["id"])
        assert catalog["annotations"][0]["comment"] == text[:240]
        assert catalog["annotations"][0]["comment_characters"] == len(text)
        assert catalog["annotations"][0]["preview_truncated"]
        context = library.annotation_context_exact(item["id"], refs(catalog))
        assert all(note["comment"] == text for note in context["annotations"])
        with pytest.raises(ValueError, match="SOURCE_BUDGET_EXCEEDED"):
            library.annotation_context_exact(item["id"], refs(catalog), max_characters=len(text))
        with pytest.raises(ValueError, match="SOURCE_BUDGET_EXCEEDED"):
            library.annotation_context_exact(item["id"], [], selection={"page": 1, "text": "selection"}, max_characters=3)
    finally:
        library.close()


def test_note_above_send_budget_remains_in_catalog_and_rejects_before_hash(tmp_path, monkeypatch):
    library, item = prepare(tmp_path, count=1, comment="x" * 25000)
    try:
        catalog = library.annotation_catalog(item["id"])
        assert catalog["total"] == 1 and catalog["annotations"][0]["source_characters"] == 25000
        assert library.annotation_context_exact(item["id"], refs(catalog), max_characters=30000)["annotations"][0]["comment"] == "x" * 25000
        def unexpected_hash(*args):
            raise AssertionError("Over-budget text must be rejected before normalization/hash copies")
        monkeypatch.setattr(library, "_reference_annotation", unexpected_hash)
        with pytest.raises(ValueError, match="SOURCE_BUDGET_EXCEEDED"):
            library.annotation_context_exact(item["id"], refs(catalog))
    finally:
        library.close()


def test_edits_and_deletes_reject_frozen_versions_but_other_writes_do_not(tmp_path):
    library, item = prepare(tmp_path, count=2)
    try:
        original = refs(library.annotation_catalog(item["id"]))
        first = original[0]
        library.annotate(item["id"], page=1, type="note", comment="Unrelated new note")
        assert library.annotation_context_exact(item["id"], [first])["annotation_refs"] == [first]
        library.annotation_update(item["id"], first["id"], "Edited question")
        with pytest.raises(ValueError, match="ANNOTATION_STALE"):
            library.annotation_context_exact(item["id"], [first])
        current = refs(library.annotation_catalog(item["id"]))[0]
        assert current["version"] != first["version"]
        assert library.annotation_context_exact(item["id"], [current])["annotations"][0]["comment"] == "Edited question"
        library.annotation_delete(item["id"], original[1]["id"])
        with pytest.raises(ValueError, match="ANNOTATION_MISSING"):
            library.annotation_context_exact(item["id"], [original[1]])
        with pytest.raises(ValueError, match="Duplicate annotation"):
            library.annotation_context_exact(item["id"], [current, current])
    finally:
        library.close()


def test_catalog_reports_omission_and_scan_uncertainty(tmp_path, monkeypatch):
    library, item = prepare(tmp_path, count=4)
    try:
        monkeypatch.setattr(core, "REFERENCE_CATALOG_LIMIT", 2)
        catalog = library.annotation_catalog(item["id"])
        assert catalog["total"] == 4 and catalog["returned"] == 2
        assert catalog["truncated"] and catalog["total_exact"]
        assert catalog["source_characters"] == sum(len(f"Reader note {i}") for i in range(4))
        monkeypatch.setattr(core, "REFERENCE_SCAN_LIMIT", 2)
        catalog = library.annotation_catalog(item["id"])
        assert catalog["truncated"] and not catalog["total_exact"]
        assert not catalog["source_characters_exact"]
        with pytest.raises(ValueError, match="ANNOTATION_SCAN_LIMIT"):
            library.annotation_context_exact(item["id"], refs(catalog))
    finally:
        library.close()


def test_missing_and_duplicate_pdf_identity_are_visible(tmp_path):
    library, item = prepare(tmp_path, count=3)
    try:
        def mutate(document):
            page = document[0]
            notes = list(page.annots())
            document.xref_set_key(notes[0].xref, "NM", "null")
            document.xref_set_key(notes[1].xref, "NM", fitz.get_pdf_str("duplicated"))
            document.xref_set_key(notes[2].xref, "NM", fitz.get_pdf_str("duplicated"))
            return {}
        library._write_pdf(item["id"], mutate)
        catalog = library.annotation_catalog(item["id"])
        assert catalog["annotations"][0]["identity_source"] == "page-xref"
        assert not catalog["annotations"][0]["identity_reliable"]
        assert catalog["ambiguous_ids"] == ["duplicated"]
        assert catalog["annotations"][1]["identity_source"] == "duplicate-pdf-nm"
        with pytest.raises(ValueError, match="ANNOTATION_AMBIGUOUS"):
            library.annotation_context_exact(item["id"], refs(catalog)[1:2])
    finally:
        library.close()


def test_revision_ignores_timestamp_color_and_normalizes_line_endings():
    value = {"id": "note", "page": 1, "type": "note", "text": "Cafe\u0301\r\nsource", "comment": "Question", "rects": [[1, 2, 3, 4]]}
    first = Library._reference_annotation(value, True)
    other = Library._reference_annotation({**value, "text": "Café\nsource", "created": "later", "modified": "later", "color": {"stroke": [1, 0, 0]}}, True)
    assert first["version"] == other["version"]
    assert Library._reference_annotation({**value, "rects": [[1, 2, 3, 5]]}, True)["version"] != first["version"]


def test_external_annotation_hash_copies_are_bounded(monkeypatch):
    monkeypatch.setattr(core, "REFERENCE_ANNOTATION_BYTES", 10)
    value = {"id": "note", "page": 1, "type": "note", "text": "", "comment": "x" * 11, "rects": [[1, 2, 3, 4]]}
    with pytest.raises(ValueError, match="ANNOTATION_TEXT_LIMIT"):
        Library._reference_annotation(value, True)
    with pytest.raises(ValueError, match="ANNOTATION_TEXT_LIMIT"):
        Library._reference_annotation({**value, "comment": "汉" * 4}, True)


def test_worker_dispatch_and_selection_validation(tmp_path):
    library, item = prepare(tmp_path, count=1)
    library.close()
    catalog = dispatch({"library": str(tmp_path / "library"), "action": "annotation_catalog", "id": item["id"]})
    args = {"library": str(tmp_path / "library"), "action": "annotation_context_exact", "id": item["id"], "annotation_refs": refs(catalog)}
    result = dispatch({**args, "selection": {"page": 1, "text": "Synthetic source text"}})
    assert result["selection"]["page"] == 1 and len(result["annotations"]) == 1
    for selection in ({"page": 2, "text": "bad page"}, {"page": True, "text": "boolean"}, {"page": 1, "text": "x" * 8001}):
        with pytest.raises(ValueError, match="Selection"):
            dispatch({**args, "selection": selection})
    for budget in (0, True, core.REFERENCE_MAX_CHARACTERS + 1):
        with pytest.raises(ValueError, match="Source character budget"):
            dispatch({**args, "max_characters": budget})
