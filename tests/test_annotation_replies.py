"""同一划线的人工备注作为 PDF 原生回复独立持久化。"""
import json
from pathlib import Path
import uuid

import pymupdf as fitz
import pytest
from dsh_paper_library.core import dispatch


def call(tmp_path, action, **values):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **values})


def setup(tmp_path):
    original = tmp_path / "synthetic-replies.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=500)
        page.insert_text((50, 80), "Synthetic source sentence for follow-up questions.")
        external = page.add_text_annot((20, 30), "External note remains")
        external.set_info(title="External reader")
        external.update()
        doc.save(original)
    before = original.read_bytes()
    paper = call(tmp_path, "import", path=str(original))["items"][0]["id"]
    root = call(tmp_path, "annotate", id=paper, page=1, type="underline", rects=[[50, 68, 300, 82]], text="Synthetic source sentence", comment="Remark 1")["annotation"]
    path = Path(call(tmp_path, "export_pdf", id=paper)["path"])
    return paper, root, path, original, before


def test_replies_share_root_native_irt_without_extra_underlines_and_keep_exact_references(tmp_path):
    paper, root, path, original, before = setup(tmp_path)
    second = call(tmp_path, "annotation_reply_create", id=paper, annotation_id=root["id"], reply_id=str(uuid.uuid4()), comment="Remark 2")["annotation"]
    third = call(tmp_path, "annotation_reply_create", id=paper, annotation_id=second["id"], reply_id=str(uuid.uuid4()), comment="Remark 3")["annotation"]
    for note in (second, third):
        assert note["kind"] == "reader-reply"
        assert note["parent_id"] == note["reply_to"] == root["id"]
        assert note["text"] == root["text"]
        assert note["rects"] == root["rects"]
        assert note["version"] and note["edit_version"]
        exact = call(tmp_path, "annotation_context_exact", id=paper, annotation_refs=[{"id": note["id"], "version": note["version"]}])
        assert exact["annotations"][0]["comment"] == note["comment"]
        assert exact["annotations"][0]["text"] == root["text"]
    with fitz.open(path) as doc:
        page = doc[0]
        native = list(page.annots())
        underline = next(a for a in native if a.type[0] == fitz.PDF_ANNOT_UNDERLINE)
        assert sum(a.type[0] == fitz.PDF_ANNOT_UNDERLINE for a in native) == 1
        assert sum(a.irt_xref == underline.xref for a in native) == 2
        assert any(a.info["content"] == "External note remains" for a in native)
    assert original.read_bytes() == before
    listed = call(tmp_path, "annotations", id=paper)["annotations"]
    assert len([a for a in listed if a.get("kind") == "reader-reply"]) == 2
    assert 'inreplyto="' + root["id"] + '"' in call(tmp_path, "export_annotations", id=paper)["text"]


def test_reply_retry_preserves_edit_and_rejects_identity_reuse(tmp_path):
    paper, root, path, _, _ = setup(tmp_path)
    body = dict(id=paper, annotation_id=root["id"], reply_id=str(uuid.uuid4()), comment="")
    reply = call(tmp_path, "annotation_reply_create", **body)["annotation"]
    edited = call(tmp_path, "annotation_update", id=paper, annotation_id=reply["id"], comment="Updated question", version=reply["edit_version"])["annotation"]
    before = path.read_bytes()
    repeated = call(tmp_path, "annotation_reply_create", **body)
    assert repeated["duplicate"] and repeated["annotation"]["comment"] == "Updated question"
    assert repeated["annotation"]["version"] == edited["version"]
    assert path.read_bytes() == before
    with pytest.raises(ValueError, match="different content"):
        call(tmp_path, "annotation_reply_create", **{**body, "comment": "Different"})
    with pytest.raises(ValueError, match="ANNOTATION_STALE"):
        call(tmp_path, "annotation_update", id=paper, annotation_id=reply["id"], comment="Stale question", version=reply["edit_version"])


def test_root_delete_preserves_human_reply_and_content_without_dangling_native_link(tmp_path):
    paper, root, path, _, _ = setup(tmp_path)
    reply = call(tmp_path, "annotation_reply_create", id=paper, annotation_id=root["id"], reply_id=str(uuid.uuid4()), comment="Preserve my question")["annotation"]
    call(tmp_path, "annotation_delete", id=paper, annotation_id=root["id"])
    notes = call(tmp_path, "annotations", id=paper)["annotations"]
    retained = next(n for n in notes if n["id"] == reply["id"])
    assert retained["comment"] == "Preserve my question"
    assert not retained.get("reply_to")
    with fitz.open(path) as doc:
        page = doc[0]
        native = next(a for a in page.annots() if a.info["id"] == reply["id"])
        assert native.irt_xref == 0


def test_reply_validation_and_bounded_scan_do_not_write(tmp_path, monkeypatch):
    paper, root, path, _, _ = setup(tmp_path)
    before = path.read_bytes()
    for values in ({"reply_id": "not-uuid"}, {"annotation_id": "missing"}, {"comment": "x" * 30001}):
        with pytest.raises(ValueError):
            call(tmp_path, "annotation_reply_create", **{ "id": paper, "annotation_id": root["id"], "reply_id": str(uuid.uuid4()), "comment": "question", **values})
    import dsh_paper_library.core as core
    monkeypatch.setattr(core, "MAX_ANNOTATIONS", 1)
    with pytest.raises(ValueError, match="bounded"):
        call(tmp_path, "annotation_reply_create", id=paper, annotation_id=root["id"], reply_id=str(uuid.uuid4()), comment="question")
    assert path.read_bytes() == before


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_reply_source_rectangles_stay_in_display_coordinates_on_cropped_rotated_pages(tmp_path, rotation):
    path = tmp_path / "rotated-synthetic.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=500, height=600)
        page.insert_text((100, 150), "Synthetic rotated source")
        page.set_cropbox(fitz.Rect(40, 50, 450, 550))
        page.set_rotation(rotation)
        doc.save(path)
    paper = call(tmp_path, "import", path=str(path))["items"][0]["id"]
    root = call(tmp_path, "annotate", id=paper, page=1, type="underline", rects=[[60, 80, 160, 100]], text="Synthetic rotated source")["annotation"]
    reply = call(tmp_path, "annotation_reply_create", id=paper, annotation_id=root["id"], reply_id=str(uuid.uuid4()), comment="Rotated question")["annotation"]
    assert reply["rects"] == root["rects"]
    listed = next(n for n in call(tmp_path, "annotations", id=paper)["annotations"] if n["id"] == reply["id"])
    assert listed["rects"] == root["rects"]
    assert listed["version"] == reply["version"]
