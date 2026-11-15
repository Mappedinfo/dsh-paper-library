import pymupdf as fitz
import pytest

from dsh_paper_library.annotation_tags import AnnotationTagsConflict
from dsh_paper_library.core import Library, dispatch


@pytest.fixture
def library(tmp_path):
    catalog = Library(tmp_path / "library")
    yield catalog
    catalog.close()


def local_pdf(library, title):
    original = library.root.parent / f"{title}.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 60), "Synthetic evidence")
        note = page.add_text_annot((50, 100), "External comment")
        note.set_info(title="Synthetic author", subject="External subject")
        doc.save(original)
    item = library.create({"title": title})
    library.attach(item["id"], str(original))
    return item["id"], original, library.annotations(item["id"])["annotations"][0]


def call(library, action, **payload):
    return dispatch({"library": str(library.root), "action": action, **payload})


def update(library, paper, note, tags, expected=()):
    return call(library, "annotation_tags_update", id=paper, annotation_id=note["id"], page=note["page"],
                tags=tags, expected_tags=list(expected))


def test_tags_live_on_the_pdf_annotation_and_history_matches_other_papers(library, tmp_path):
    paper, original, note = local_pdf(library, "First synthetic paper")
    other, _, other_note = local_pdf(library, "Second synthetic paper")
    before_original, before_managed = original.read_bytes(), library.pdf_path(paper).read_bytes()
    saved = update(library, paper, note, ["＃城市感知", "Urban Sensing", "urban sensing"])
    assert saved["tags"] == ["城市感知", "Urban Sensing"]
    assert (library.root / "backups" / f"{paper}.pdf.bak").read_bytes() == before_managed
    assert original.read_bytes() == before_original
    readback = library.annotations(paper)["annotations"][0]
    assert readback["tags"] == saved["tags"]
    for field in ("id", "author", "comment", "subject", "edit_version"):
        assert readback[field] == note[field]
    library.annotation_update(paper, note["id"], "Edited comment", version=readback["edit_version"])
    assert library.annotations(paper)["annotations"][0]["tags"] == saved["tags"]
    assert "tags" not in library.annotations(other)["annotations"][0]
    assert call(library, "annotation_tag_suggestions", query="sEnSi") == {"tags": ["Urban Sensing"]}
    assert call(library, "annotation_tag_suggestions", query="城市") == {"tags": ["城市感知"]}
    update(library, other, other_note, ["城市感知"])

    # A fresh catalog recovers the label from the PDF without any history rows.
    fresh = Library(tmp_path / "fresh")
    try:
        imported = fresh.create({"title": "Imported tagged PDF"})["id"]
        fresh.attach(imported, str(library.pdf_path(paper)))
        assert fresh.annotations(imported)["annotations"][0]["tags"] == saved["tags"]
        assert call(fresh, "annotation_tag_suggestions", query="城市") == {"tags": []}
    finally:
        fresh.close()
    update(library, paper, note, [], expected=saved["tags"])
    assert "tags" not in library.annotations(paper)["annotations"][0]
    assert call(library, "annotation_tag_suggestions", query="urban") == {"tags": ["Urban Sensing"]}


def test_conflicting_and_failed_writes_preserve_pdf_and_suggestion_history(library, monkeypatch):
    paper, _, note = local_pdf(library, "Synthetic updates")
    update(library, paper, note, ["Original"])
    before = library.pdf_path(paper).read_bytes()
    with pytest.raises(AnnotationTagsConflict) as failure:
        update(library, paper, note, ["Stale"])
    assert failure.value.current == {"tags": ["Original"]}
    assert update(library, paper, note, ["Original"])["tags"] == ["Original"]
    assert library.pdf_path(paper).read_bytes() == before
    assert call(library, "annotation_tag_suggestions", query="Stale") == {"tags": []}

    def fail(*args, **kwargs):
        raise OSError("synthetic serialization failure")

    monkeypatch.setattr(Library, "_atomic_save", fail)
    with pytest.raises(OSError, match="serialization"):
        update(library, paper, note, ["Unsaved"], expected=["Original"])
    assert library.pdf_path(paper).read_bytes() == before
    assert call(library, "annotation_tag_suggestions", query="Unsaved") == {"tags": []}
    with pytest.raises(ValueError, match="单行"):
        update(library, paper, note, ["Illegal\nlabel"], expected=["Original"])
