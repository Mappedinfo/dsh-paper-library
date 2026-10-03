"""Synthetic portable handwritten notes and transcript provenance."""
import hashlib
import json
import shutil
import uuid
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.handwriting import HandwritingConflict, HEADERS, SVG_NAMESPACE


def call(tmp_path, action, **kwargs):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **kwargs})


def board():
    return {"width": 640, "height": 360, "strokes": [
        {"points": [[20, 30], [35.5, 60], [50, 20]], "color": "#203090", "width": 2},
        {"points": [[80, 30], [80, 30]], "color": "#ee1020", "width": 4}]}


def fixture(tmp_path, rotation=0, parent_type="highlight"):
    source = tmp_path / "source.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=500, height=700)
        page.insert_text((60, 100), "Synthetic evidence for a handwriting note.")
        page.add_text_annot((200, 200), "Unrelated external note")
        page.set_cropbox(fitz.Rect(30, 40, 450, 640))
        page.set_rotation(rotation)
        doc.save(source)
    item = call(tmp_path, "import", path=str(source))["items"][0]
    page = call(tmp_path, "page", id=item["id"], page=1)
    parent = call(tmp_path, "annotate", id=item["id"], page=1, type=parent_type,
                  **({"rects": [page["words"][0][:4]], "text": page["words"][0][4]} if parent_type != "note" else {}))["annotation"]
    return item, parent, source


def save(tmp_path, item, parent, **kwargs):
    return call(tmp_path, "handwriting_save", id=item["id"], annotation_id=parent["id"],
                **{"board": board(), "request_id": str(uuid.uuid4()), **kwargs})


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("parent_type", ["highlight", "underline", "note"])
def test_handwriting_is_native_portable_attachment_with_original_strokes(tmp_path, rotation, parent_type):
    item, parent, source = fixture(tmp_path, rotation, parent_type)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    assert call(tmp_path, "handwriting_get", id=item["id"], annotation_id=parent["id"])["note"] is None
    saved = save(tmp_path, item, parent, transcript="这个论据是否充分？", transcription_source="model")
    assert saved["note"]["board"] == board()
    assert saved["annotation"]["handwriting"]["version"] == saved["note"]["version"]
    assert "board" not in saved["annotation"]["handwriting"]
    assert saved["annotation"]["rects"] == parent["rects"]
    recovered = call(tmp_path, "handwriting_get", id=item["id"], annotation_id=parent["id"])
    assert recovered == saved
    portable = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(portable) as doc:
        page = doc[0]
        native = next(annot for annot in page.annots() if annot.info["id"] == saved["note"]["id"])
        assert native.type == (17, "FileAttachment")
        assert page.load_annot(native.irt_xref).info["id"] == parent["id"]
        assert native.info["content"] == HEADERS["model"] + "这个论据是否充分？"
        svg = ET.fromstring(native.get_file())
        assert svg.tag == f"{{{SVG_NAMESPACE}}}svg"
        assert len(svg.findall(f"{{{SVG_NAMESPACE}}}polyline")) == 2
        assert json.loads(svg.find(f"{{{SVG_NAMESPACE}}}metadata").text)["board"] == board()
    copied = tmp_path / "standalone.pdf"
    shutil.copy2(portable, copied)
    other = str(tmp_path / "fresh-library")
    imported = dispatch({"library": other, "action": "import", "path": str(copied)})["items"][0]
    reread = dispatch({"library": other, "action": "handwriting_get", "id": imported["id"], "annotation_id": parent["id"]})
    assert reread["note"] == saved["note"]
    values = call(tmp_path, "annotations", id=item["id"])["annotations"]
    attachment = next(value for value in values if value.get("kind") == "handwriting-note")
    assert attachment["type"] == "fileattachment" and attachment["parent_id"] == parent["id"]
    assert attachment["handwriting_version"] == saved["note"]["version"]
    assert "board" not in attachment
    assert any(value["comment"] == "Unrelated external note" for value in values)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    assert len(list((tmp_path / "library" / "backups").iterdir())) == 1


def test_cas_idempotency_updates_and_erasing_original_board(tmp_path):
    item, parent, _ = fixture(tmp_path)
    request_id = str(uuid.uuid4())
    first = save(tmp_path, item, parent, request_id=request_id)
    library = Library(tmp_path / "library")
    try:
        path = library.pdf_path(item["id"])
        before = path.read_bytes()
        retry = save(tmp_path, item, parent, request_id=request_id)
        assert retry["duplicate"] is True and retry["note"] == first["note"]
        assert path.read_bytes() == before
        with pytest.raises(ValueError, match="reused"):
            save(tmp_path, item, parent, request_id=request_id, transcript="Changed", transcription_source="edited")
        with pytest.raises(HandwritingConflict) as error:
            save(tmp_path, item, parent)
        assert error.value.current["version"] == first["note"]["version"]
        changed = save(tmp_path, item, parent, expected_version=first["note"]["version"], transcript="已核对的原意", transcription_source="edited")
        assert changed["note"]["id"] == first["note"]["id"]
        assert changed["note"]["version"] != first["note"]["version"]
        assert changed["note"]["board"] == first["note"]["board"]
        with pytest.raises(HandwritingConflict):
            save(tmp_path, item, parent, expected_version=first["note"]["version"])
        erased = save(tmp_path, item, parent, expected_version=changed["note"]["version"],
                       board={"width": 640, "height": 360, "strokes": []}, transcript="保留文字", transcription_source="edited")
        assert erased["note"]["board"]["strokes"] == [] and erased["note"]["transcript"] == "保留文字"
        with fitz.open(path) as doc:
            page = doc[0]
            assert len([annot for annot in page.annots() if annot.type[0] == 17]) == 1
    finally:
        library.close()


def test_parent_reference_tracks_strokes_transcript_and_counts_source_budget(tmp_path):
    item, parent, _ = fixture(tmp_path)
    def reference():
        values = call(tmp_path, "annotation_catalog", id=item["id"])
        assert values["total"] == 2  # external note and original parent only
        return next(value for value in values["annotations"] if value["id"] == parent["id"])
    initial = reference()
    first = save(tmp_path, item, parent, transcript="有待核对", transcription_source="model")
    current = reference()
    assert initial["version"] != current["version"]
    assert current["source_characters"] == len(parent["text"]) + len("有待核对")
    exact = call(tmp_path, "annotation_context_exact", id=item["id"], annotation_refs=[{"id": parent["id"], "version": current["version"]}])
    assert exact["annotations"][0]["handwriting"]["transcript"] == "有待核对"
    assert "board" not in exact["annotations"][0]["handwriting"]
    with pytest.raises(ValueError, match="SOURCE_BUDGET_EXCEEDED"):
        call(tmp_path, "annotation_context_exact", id=item["id"], annotation_refs=[{"id": parent["id"], "version": current["version"]}], max_characters=len(parent["text"]))
    changed_board = board()
    changed_board["strokes"][0]["points"][1][0] += 1
    changed = save(tmp_path, item, parent, expected_version=first["note"]["version"], board=changed_board, transcript="有待核对", transcription_source="model")
    assert reference()["version"] != current["version"]
    with pytest.raises(ValueError, match="ANNOTATION_STALE"):
        call(tmp_path, "annotation_context_exact", id=item["id"], annotation_refs=[{"id": parent["id"], "version": current["version"]}])
    previous = reference()
    save(tmp_path, item, parent, expected_version=changed["note"]["version"], board=changed_board, transcript="更正后的原意", transcription_source="edited")
    assert previous["version"] != reference()["version"]
    context = call(tmp_path, "feedback_context", id=item["id"], annotation_ids=[parent["id"]])
    assert context["annotations"][0]["handwriting"]["transcript"] == "更正后的原意"


def test_parent_deletion_removes_only_owned_handwriting_and_generic_edit_is_blocked(tmp_path):
    item, parent, _ = fixture(tmp_path)
    saved = save(tmp_path, item, parent)
    path = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(path) as doc:
        page = doc[0]
        source = next(annot for annot in page.annots() if annot.info["id"] == parent["id"])
        external = page.add_text_annot((220, 220), "Unrelated external reply")
        external.set_irt_xref(source.xref)
        doc.saveIncr()
    with pytest.raises(ValueError, match="handwriting_save"):
        call(tmp_path, "annotation_update", id=item["id"], annotation_id=saved["note"]["id"], comment="bypass version")
    call(tmp_path, "annotation_delete", id=item["id"], annotation_id=parent["id"])
    values = call(tmp_path, "annotations", id=item["id"])["annotations"]
    assert {value["comment"] for value in values} == {"Unrelated external note", "Unrelated external reply"}


@pytest.mark.parametrize("change", [
    {"width": float("nan")}, {"height": 0}, {"strokes": None},
    {"strokes": [board()["strokes"][0]] * 129},
    {"strokes": [{"points": [[0, 0]] * 8193, "color": "#204080", "width": 2}]},
    {"strokes": [{"points": [[1.123456789012345, 2.123456789012345]] * 8192, "color": "#204080", "width": 2}]},
    {"strokes": [{"points": [[True, 2], [3, 4]], "color": "#204080", "width": 2}]},
    {"strokes": [{"points": [[0, 0], [641, 360]], "color": "#204080", "width": 2}]},
    {"strokes": [{"points": [[0, 0], [1, 2]], "color": "url(evil)", "width": 2}]},
    {"strokes": [{"points": [[0, 0], [1, 2]], "color": "#204080", "width": float("inf")}]},
])
def test_invalid_boards_reject_without_modification(tmp_path, change):
    item, parent, _ = fixture(tmp_path)
    path = call(tmp_path, "export_pdf", id=item["id"])["path"]
    before = Path(path).read_bytes()
    with pytest.raises(ValueError):
        save(tmp_path, item, parent, board={**board(), **change})
    assert Path(path).read_bytes() == before


def test_concurrent_edit_accepts_only_one_current_version(tmp_path):
    item, parent, _ = fixture(tmp_path)
    first = save(tmp_path, item, parent)
    def edit(text):
        try:
            return save(tmp_path, item, parent, expected_version=first["note"]["version"], transcript=text, transcription_source="edited")
        except HandwritingConflict:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, ["First writer", "Second writer"]))
    accepted = [result for result in results if result is not None]
    assert len(accepted) == 1
    final = call(tmp_path, "handwriting_get", id=item["id"], annotation_id=parent["id"])
    assert final["note"] == accepted[0]["note"]


def test_unrelated_external_attachment_and_transcript_preview_remain_bounded(tmp_path):
    item, parent, _ = fixture(tmp_path)
    path = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(path) as doc:
        page = doc[0]
        external = page.add_file_annot((200, 220), b"External attachment bytes", "external.txt")
        external_id = external.info["id"]
        doc.saveIncr()
    saved = save(tmp_path, item, parent, transcript="识别" * 200, transcription_source="model")
    values = call(tmp_path, "annotation_catalog", id=item["id"])["annotations"]
    projected = next(value for value in values if value["id"] == parent["id"])
    assert len(projected["handwriting"]["transcript"]) == 240
    assert projected["preview_truncated"] is True
    exported = json.loads(call(tmp_path, "export_annotations", id=item["id"], format="json")["text"])
    child = next(value for value in exported["annotations"] if value["id"] == saved["note"]["id"])
    assert child["transcript"] == "识别" * 200 and "board" not in child
    with fitz.open(path) as doc:
        page = doc[0]
        external = next(annot for annot in page.annots() if annot.info["id"] == external_id)
        assert external.get_file() == b"External attachment bytes"


@pytest.mark.parametrize("changes", [
    {"request_id": "invalid"}, {"expected_version": "invalid"},
    {"transcription_source": "none", "transcript": "Unlabelled"},
    {"transcription_source": "unknown"}, {"transcript": "x" * 12001},
])
def test_invalid_identity_and_transcript_request_are_rejected(tmp_path, changes):
    item, parent, _ = fixture(tmp_path)
    with pytest.raises(ValueError):
        save(tmp_path, item, parent, **changes)
    assert call(tmp_path, "handwriting_get", id=item["id"], annotation_id=parent["id"])["note"] is None


def test_external_contents_edit_changes_version_and_native_attachment_is_required(tmp_path):
    item, parent, _ = fixture(tmp_path)
    saved = save(tmp_path, item, parent, transcript="模型识别", transcription_source="model")
    path = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(path) as doc:
        page = doc[0]
        child = next(annot for annot in page.annots() if annot.info["id"] == saved["note"]["id"])
        child.set_info(content="External reader correction")
        child.update()
        doc.saveIncr()
    got = call(tmp_path, "handwriting_get", id=item["id"], annotation_id=parent["id"])["note"]
    assert got["transcript"] == "External reader correction" and got["version"] != saved["note"]["version"]
    with pytest.raises(HandwritingConflict):
        save(tmp_path, item, parent, expected_version=saved["note"]["version"])
    with fitz.open(path) as doc:
        page = doc[0]
        child = next(annot for annot in page.annots() if annot.info["id"] == saved["note"]["id"])
        child.update_file(buffer_=b'<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>')
        doc.saveIncr()
    with pytest.raises(ValueError):
        call(tmp_path, "handwriting_get", id=item["id"], annotation_id=parent["id"])


def test_missing_and_generated_parents_and_serialization_failure(tmp_path, monkeypatch):
    item, parent, _ = fixture(tmp_path)
    with pytest.raises(ValueError, match="missing"):
        call(tmp_path, "handwriting_get", id=item["id"], annotation_id="missing")
    saved = save(tmp_path, item, parent)
    with pytest.raises(ValueError, match="source annotation"):
        call(tmp_path, "handwriting_get", id=item["id"], annotation_id=saved["note"]["id"])
    library = Library(tmp_path / "library")
    try:
        before = library.pdf_path(item["id"]).read_bytes()
        def fail(*args, **kwargs):
            raise OSError("Synthetic write failure")
        monkeypatch.setattr(library, "_atomic_save", fail)
        with pytest.raises(OSError):
            library.handwriting_save(item["id"], parent["id"], board(), transcript="新转写", transcription_source="edited",
                                     expected_version=saved["note"]["version"], request_id=str(uuid.uuid4()))
        assert library.pdf_path(item["id"]).read_bytes() == before
    finally:
        library.close()
