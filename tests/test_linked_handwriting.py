"""Synthetic page-native handwriting bound to standard source annotations."""
import hashlib
import json
import shutil
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pymupdf as fitz
import pytest

from dsh_paper_library.core import dispatch
from dsh_paper_library.handwriting import HandwritingConflict, HEADERS
from test_handwriting import board, call, fixture


PATHS = [[[45, 65], [70.25, 90], [100, 75]]]


def ink(tmp_path, item, parent, **kwargs):
    return call(tmp_path, "annotate", id=item["id"], **{
        "page": parent["page"], "parent_id": parent["id"], "type": "ink", "paths": PATHS,
        "color": "#203090", "width": 2, "annotation_id": str(uuid.uuid4()), **kwargs})


def get_parent(tmp_path, item, parent):
    return call(tmp_path, "handwriting_get", id=item["id"], annotation_id=parent["id"])["annotation"]


def transcript(tmp_path, item, parent, **kwargs):
    version = get_parent(tmp_path, item, parent)["linked_ink"]["version"]
    return call(tmp_path, "linked_handwriting_text", id=item["id"], parent_id=parent["id"], **{
        "transcript": "这个证据充分吗？", "transcription_source": "model", "expected_version": version,
        "request_id": str(uuid.uuid4()), **kwargs})


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_native_linked_ink_transcript_portability_rotation_and_legacy(tmp_path, rotation):
    item, parent, source = fixture(tmp_path, rotation)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    legacy = call(tmp_path, "handwriting_save", id=item["id"], annotation_id=parent["id"], board=board(), request_id=str(uuid.uuid4()))
    child = ink(tmp_path, item, parent)["annotation"]
    assert child["kind"] == "linked-handwriting" and child["parent_id"] == parent["id"]
    for actual, expected in zip(child["paths"][0], PATHS[0]):
        assert actual == pytest.approx(expected, abs=.001)
    saved = transcript(tmp_path, item, parent)["annotation"]
    group = saved["linked_ink"]
    assert group["transcript"] == "这个证据充分吗？" and group["transcription_source"] == "model"
    assert not group["transcript_stale"] and group["annotation_count"] == 1
    assert group["annotations"][0]["id"] == child["id"]
    assert saved["handwriting"] == legacy["annotation"]["handwriting"]
    exported = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(exported) as doc:
        page = doc[0]
        replies = [annot for annot in page.annots() if annot.irt_xref]
        assert {annot.type[0] for annot in replies} == {0, 15, 17}
        for annot in replies:
            assert page.load_annot(annot.irt_xref).info["id"] == parent["id"]
        native_ink = next(annot for annot in replies if annot.type[0] == 15)
        assert doc.xref_get_key(native_ink.xref, "InkList")[0] == "array"
        native_text = next(annot for annot in replies if annot.type[0] == 0)
        assert native_text.info["content"] == HEADERS["model"] + group["transcript"]
    copied = tmp_path / "copied.pdf"
    shutil.copy2(exported, copied)
    fresh = str(tmp_path / "fresh-library")
    new_item = dispatch({"library": fresh, "action": "import", "path": str(copied)})["items"][0]
    recovered = dispatch({"library": fresh, "action": "handwriting_get", "id": new_item["id"], "annotation_id": parent["id"]})
    assert recovered["annotation"]["linked_ink"] == group
    assert recovered["note"]["board"] == board()
    values = call(tmp_path, "annotations", id=item["id"])["annotations"]
    assert any(value["comment"] == "Unrelated external note" for value in values)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    serialized = json.loads(call(tmp_path, "export_annotations", id=item["id"], format="json")["text"])
    assert next(a for a in serialized["annotations"] if a["id"] == parent["id"])["linked_ink"] == group


def test_retries_cas_stale_transcript_and_source_references(tmp_path):
    item, parent, _ = fixture(tmp_path)
    request_id = str(uuid.uuid4())
    first = ink(tmp_path, item, parent, annotation_id=request_id)
    pdf = call(tmp_path, "export_pdf", id=item["id"])["path"]
    before = Path(pdf).read_bytes()
    assert ink(tmp_path, item, parent, annotation_id=request_id)["duplicate"]
    assert Path(pdf).read_bytes() == before
    second_parent = call(tmp_path, "annotate", id=item["id"], page=1, type="note")["annotation"]
    with pytest.raises(ValueError, match="different content"):
        ink(tmp_path, item, second_parent, annotation_id=request_id)
    initial = get_parent(tmp_path, item, parent)["linked_ink"]
    text_request = str(uuid.uuid4())
    text = transcript(tmp_path, item, parent, request_id=text_request, expected_version=initial["version"])
    before = Path(pdf).read_bytes()
    retry = transcript(tmp_path, item, parent, request_id=text_request, expected_version=initial["version"])
    assert retry["duplicate"] and retry["annotation"]["linked_ink"] == text["annotation"]["linked_ink"]
    assert Path(pdf).read_bytes() == before
    with pytest.raises(ValueError, match="reused"):
        transcript(tmp_path, item, parent, request_id=text_request, expected_version=initial["version"], transcript="Different")
    catalog = call(tmp_path, "annotation_catalog", id=item["id"])
    assert not any(a["id"] == first["annotation"]["id"] for a in catalog["annotations"])
    selected = next(a for a in catalog["annotations"] if a["id"] == parent["id"])
    assert "annotations" not in selected["linked_ink"]
    refs = [{"id": selected["id"], "version": selected["version"]}]
    context = call(tmp_path, "annotation_context_exact", id=item["id"], annotation_refs=refs)
    assert context["annotations"][0]["linked_ink"]["transcript"] == "这个证据充分吗？"
    assert selected["source_characters"] == len(parent["text"]) + len(parent["comment"]) + len("这个证据充分吗？")
    with pytest.raises(ValueError, match="SOURCE_BUDGET"):
        call(tmp_path, "annotation_context_exact", id=item["id"], annotation_refs=refs, max_characters=selected["source_characters"] - 1)
    ink(tmp_path, item, parent, paths=[[[160, 170], [165, 195]]])
    current = get_parent(tmp_path, item, parent)["linked_ink"]
    assert current["transcript_stale"] and current["transcript"] == "这个证据充分吗？"
    assert current["geometry_version"] != initial["geometry_version"]
    with pytest.raises(ValueError, match="ANNOTATION_STALE"):
        call(tmp_path, "annotation_context_exact", id=item["id"], annotation_refs=refs)
    with pytest.raises(HandwritingConflict):
        transcript(tmp_path, item, parent, expected_version=text["annotation"]["linked_ink"]["version"])
    with pytest.raises(HandwritingConflict):
        transcript(tmp_path, item, parent, request_id=text_request, expected_version=initial["version"])
    corrected = transcript(tmp_path, item, parent, transcription_source="edited", transcript="用户校正")
    assert not corrected["annotation"]["linked_ink"]["transcript_stale"]


def test_parent_delete_cascades_owned_replies_preserves_external_replies(tmp_path):
    item, parent, _ = fixture(tmp_path)
    child = ink(tmp_path, item, parent)["annotation"]
    transcript(tmp_path, item, parent)
    call(tmp_path, "handwriting_save", id=item["id"], annotation_id=parent["id"], board=board(), request_id=str(uuid.uuid4()))
    pdf = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(pdf) as doc:
        page = doc[0]
        native_parent = next(a for a in page.annots() if a.info["id"] == parent["id"])
        external = page.add_ink_annot([[(60, 70), (90, 110)]])
        external.set_info(content="External ink reply")
        external.set_irt_xref(native_parent.xref)
        native_child = next(a for a in page.annots() if a.info["id"] == child["id"])
        reply = page.add_text_annot((40, 80), "External reply to owned Ink")
        reply.set_irt_xref(native_child.xref)
        doc.saveIncr()
    call(tmp_path, "annotation_delete", id=item["id"], annotation_id=parent["id"])
    values = call(tmp_path, "annotations", id=item["id"])["annotations"]
    assert {value["comment"] for value in values} == {"Unrelated external note", "External ink reply", "External reply to owned Ink"}
    assert all(not value.get("reply_to") for value in values)


def test_bounds_and_same_page_parent_validation_are_atomic(tmp_path, monkeypatch):
    item, parent, _ = fixture(tmp_path)
    pdf = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(pdf) as doc:
        doc.new_page(width=500, height=700)
        doc.saveIncr()
    before = Path(pdf).read_bytes()
    for kwargs in ({"parent_id": "missing"}, {"page": 2}, {"type": "note"}):
        with pytest.raises(ValueError):
            ink(tmp_path, item, parent, **kwargs)
        assert Path(pdf).read_bytes() == before
    ink(tmp_path, item, parent)
    import dsh_paper_library.linked_handwriting as linked
    for name, limit in (("MAX_LINKED_OBJECTS", 1), ("MAX_LINKED_STROKES", 1), ("MAX_LINKED_POINTS", 4), ("MAX_LINKED_BYTES", 1)):
        with monkeypatch.context() as context:
            context.setattr(linked, name, limit)
            before = Path(pdf).read_bytes()
            with pytest.raises(ValueError, match="LINKED_HANDWRITING_LIMIT"):
                ink(tmp_path, item, parent)
            assert Path(pdf).read_bytes() == before
    second = call(tmp_path, "annotate", id=item["id"], page=2, type="note")["annotation"]
    ink(tmp_path, item, second)
    assert get_parent(tmp_path, item, second)["linked_ink"]["annotations"][0]["page"] == 2


@pytest.mark.parametrize("kwargs", [
    {"transcript": "x", "transcription_source": "none"}, {"transcript": "x" * 12001},
    {"transcription_source": "unknown"}, {"expected_version": None}, {"expected_version": "bad"},
    {"request_id": "bad"}, {"transcript": False},
])
def test_invalid_transcript_inputs_do_not_write(tmp_path, kwargs):
    item, parent, _ = fixture(tmp_path)
    ink(tmp_path, item, parent)
    pdf = Path(call(tmp_path, "export_pdf", id=item["id"])["path"])
    before = pdf.read_bytes()
    with pytest.raises(ValueError):
        transcript(tmp_path, item, parent, **kwargs)
    assert pdf.read_bytes() == before


def test_external_group_expansion_is_explicit_and_exact_reference_refuses(tmp_path, monkeypatch):
    item, parent, _ = fixture(tmp_path)
    ink(tmp_path, item, parent)
    import dsh_paper_library.linked_handwriting as linked
    monkeypatch.setattr(linked, "MAX_LINKED_POINTS", 1)
    value = get_parent(tmp_path, item, parent)
    assert value["linked_ink"]["truncated"] and value["linked_ink"]["annotations"] == []
    with pytest.raises(ValueError, match="ANNOTATION_GEOMETRY_LIMIT"):
        call(tmp_path, "annotation_catalog", id=item["id"])
    with pytest.raises(ValueError, match="LINKED_HANDWRITING_LIMIT"):
        transcript(tmp_path, item, parent)


def test_two_transcripts_for_same_version_accept_only_one(tmp_path):
    item, parent, _ = fixture(tmp_path)
    ink(tmp_path, item, parent)
    version = get_parent(tmp_path, item, parent)["linked_ink"]["version"]
    def edit(text):
        try:
            return transcript(tmp_path, item, parent, transcript=text, expected_version=version)
        except HandwritingConflict:
            return "conflict"
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(edit, ["First", "Second"]))
    assert len([value for value in values if value == "conflict"]) == 1
    annotations = call(tmp_path, "annotations", id=item["id"])["annotations"]
    assert len([value for value in annotations if value.get("kind") == "linked-handwriting-transcript"]) == 1


def test_external_transcript_edit_invalidates_parent_and_both_note_forms_count(tmp_path):
    item, parent, _ = fixture(tmp_path)
    call(tmp_path, "handwriting_save", id=item["id"], annotation_id=parent["id"], board=board(),
         request_id=str(uuid.uuid4()), transcript="原稿🧪", transcription_source="edited")
    ink(tmp_path, item, parent)
    transcript(tmp_path, item, parent, transcript="纸上🧪")
    selected = next(a for a in call(tmp_path, "annotation_catalog", id=item["id"])["annotations"] if a["id"] == parent["id"])
    assert selected["source_characters"] == len(parent["text"]) + len("原稿🧪纸上🧪")
    context = call(tmp_path, "feedback_context", id=item["id"], annotation_ids=[parent["id"]])
    assert "原稿🧪" in json.dumps(context, ensure_ascii=False) and "纸上🧪" in json.dumps(context, ensure_ascii=False)
    pdf = call(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(pdf) as doc:
        page = doc[0]
        child = next(a for a in page.annots() if "linked-handwriting-transcript" in a.info.get("subject", ""))
        child.set_info(content="Externally corrected content")
        child.update()
        doc.saveIncr()
    group = get_parent(tmp_path, item, parent)["linked_ink"]
    assert group["transcript"] == "Externally corrected content"
    with pytest.raises(ValueError, match="ANNOTATION_STALE"):
        call(tmp_path, "annotation_context_exact", id=item["id"], annotation_refs=[{"id": parent["id"], "version": selected["version"]}])


def test_linked_parent_identity_is_scoped_to_current_pdf(tmp_path):
    item, parent, source = fixture(tmp_path)
    foreign = call(tmp_path, "create", metadata={"title": "Other synthetic PDF"})
    call(tmp_path, "attach", id=foreign["id"], path=str(source))
    with pytest.raises(ValueError, match="missing or ambiguous"):
        ink(tmp_path, foreign, parent)
