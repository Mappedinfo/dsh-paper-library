"""Synthetic native Ink geometry, portability, bounded writes and retry checks."""
import hashlib
import json
import re
import shutil
import xml.etree.ElementTree as ET

import pymupdf as fitz
import pytest

from dsh_paper_library.annotations import MAX_INK_POINTS, MAX_INK_STROKES
from dsh_paper_library.core import Library, dispatch


def request(tmp_path, action, **kwargs):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **kwargs})


def fixture(tmp_path, rotation=0, cropped=False):
    source = tmp_path / "source.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=500, height=700)
        page.insert_text((60, 100), "Synthetic pencil annotation fixture")
        external = page.add_text_annot((180, 180), "Keep this external note")
        external.set_info(title="External reader")
        external.update()
        if cropped:
            page.set_cropbox(fitz.Rect(40, 60, 440, 610))
        page.set_rotation(rotation)
        doc.save(source)
    item = request(tmp_path, "import", path=str(source))["items"][0]
    return item, source


def assert_paths(actual, expected):
    assert len(actual) == len(expected)
    for stroke, original in zip(actual, expected):
        assert len(stroke) == len(original)
        for point, wanted in zip(stroke, original):
            assert point == pytest.approx(wanted, abs=0.001)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("cropped", [False, True])
def test_native_ink_display_geometry_and_xfdf_roundtrip(tmp_path, rotation, cropped):
    item, source = fixture(tmp_path, rotation, cropped)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    paths = [[[20.25, 35.75], [80.5, 125.25], [150.75, 65.5]], [[95, 140], [120, 170]]]
    saved = request(tmp_path, "annotate", id=item["id"], page=1, type="ink", paths=paths,
                    color="#205090", width=3.5, comment="手写圈注")["annotation"]
    assert saved["type"] == "ink" and saved["width"] == 3.5
    assert_paths(saved["paths"], paths)
    recovered = request(tmp_path, "annotations", id=item["id"])["annotations"]
    assert {value["comment"] for value in recovered} == {"Keep this external note", "手写圈注"}
    ink = next(value for value in recovered if value["id"] == saved["id"])
    assert_paths(ink["paths"], paths)
    managed = request(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(managed) as doc:
        page = doc[0]
        native = next(value for value in page.annots() if value.info["id"] == saved["id"])
        assert native.type == (15, "Ink")
        assert doc.xref_get_key(native.xref, "InkList")[0] == "array"
        # Read actual stored bottom-left PDF-user-space coordinates, separately
        # from PyMuPDF's transformed vertices, to verify cropped-page XFDF.
        raw_points = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", doc.xref_get_key(native.xref, "InkList")[1])]
        native_paths = [[list(fitz.Point(point) * page.derotation_matrix) for point in stroke] for stroke in paths]
        assert_paths(native.vertices, native_paths)
    xfdf = request(tmp_path, "export_annotations", id=item["id"], format="xfdf")
    assert xfdf["warnings"] == []
    root = ET.fromstring(xfdf["text"])
    node = root.find(".//{http://ns.adobe.com/xfdf/}ink")
    assert node.attrib["width"] == "3.5" and node.attrib["color"] == "#205090"
    gestures = node.findall("./{http://ns.adobe.com/xfdf/}inklist/{http://ns.adobe.com/xfdf/}gesture")
    assert len(gestures) == len(paths)
    exported_points = [float(value) for gesture in gestures for pair in gesture.text.split(";") for value in pair.split(",")]
    assert exported_points == pytest.approx(raw_points, abs=0.001)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash


def test_ink_copied_pdf_json_replay_updates_deletion_and_backup(tmp_path):
    item, _ = fixture(tmp_path)
    paths = [[[20, 35], [80, 125], [150, 65]], [[95, 140], [120, 170]]]
    saved = request(tmp_path, "annotate", id=item["id"], page=1, type="ink", paths=paths, width=1.5, color="#ff0000")["annotation"]
    assert len(list((tmp_path / "library" / "backups").iterdir())) == 1
    portable = tmp_path / "copy.pdf"
    shutil.copy2(request(tmp_path, "export_pdf", id=item["id"])["path"], portable)
    fresh = tmp_path / "fresh"
    imported = dispatch({"library": str(fresh), "action": "import", "path": str(portable)})["items"][0]
    recovered = dispatch({"library": str(fresh), "action": "annotations", "id": imported["id"]})["annotations"]
    assert_paths(next(value for value in recovered if value["id"] == saved["id"])["paths"], paths)
    exported = json.loads(request(tmp_path, "export_annotations", id=item["id"], format="json")["text"])
    ink = next(value for value in exported["annotations"] if value["type"] == "ink")
    replay = request(tmp_path, "annotate", id=item["id"], **{key: ink[key] for key in ("page", "type", "paths", "width", "text", "comment", "author")})["annotation"]
    assert_paths(replay["paths"], paths)
    changed = request(tmp_path, "annotation_update", id=item["id"], annotation_id=saved["id"], comment="Added explanation")["annotation"]
    assert_paths(changed["paths"], paths)
    assert changed["width"] == 1.5
    assert changed["color"]["stroke"] == [1, 0, 0]
    request(tmp_path, "annotation_delete", id=item["id"], annotation_id=saved["id"])
    assert saved["id"] not in {value["id"] for value in request(tmp_path, "annotations", id=item["id"])["annotations"]}


@pytest.mark.parametrize("changes", [
    {"paths": None}, {"paths": []}, {"paths": [None]}, {"paths": [[[20, 30]]]},
    {"paths": [[[20, 30], [40]]]}, {"paths": [[[True, 30], [40, 50]]]},
    {"paths": [[[20, float("nan")], [40, 50]]]}, {"paths": [[[20, float("inf")], [40, 50]]]},
    {"paths": [[[10 ** 500, 30], [40, 50]]]},
    {"paths": [[[-1, 30], [40, 50]]]}, {"paths": [[[20, 30], [501, 50]]]},
    {"paths": [[[20, 30], [40, 50]]] * (MAX_INK_STROKES + 1)},
    {"paths": [[[20, 30]] * (MAX_INK_POINTS + 1)]},
    {"paths": [[[20.12345678912345, 30.12345678912345]] * MAX_INK_POINTS]},
    {"width": True}, {"width": 0.4}, {"width": 8.1}, {"width": float("nan")}, {"width": 10 ** 500},
    {"color": "red"}, {"annotation_id": "invalid"},
])
def test_invalid_ink_fails_without_changing_pdf(tmp_path, changes):
    item, _ = fixture(tmp_path)
    managed = request(tmp_path, "export_pdf", id=item["id"])["path"]
    with open(managed, "rb") as stream:
        before = stream.read()
    with pytest.raises(ValueError):
        request(tmp_path, "annotate", id=item["id"], page=1, **{"type": "ink", "paths": [[[20, 30], [40, 50]]], **changes})
    with open(managed, "rb") as stream:
        assert stream.read() == before


def test_tap_dot_and_page_edge_ink_are_portable(tmp_path):
    item, _ = fixture(tmp_path)
    paths = [[[20, 30], [20, 30]], [[0, 0], [500, 700]]]
    saved = request(tmp_path, "annotate", id=item["id"], page=1, type="ink", paths=paths, width=0.5)["annotation"]
    recovered = next(value for value in request(tmp_path, "annotations", id=item["id"])["annotations"] if value["id"] == saved["id"])
    assert_paths(recovered["paths"], paths)
    assert recovered["width"] == 0.5


def test_ink_save_retry_is_idempotent_and_rejects_reused_id(tmp_path):
    item, _ = fixture(tmp_path, rotation=90, cropped=True)
    request_body = dict(id=item["id"], page=1, type="ink", paths=[[[20.3, 30.7], [40.1, 50.5]]],
                        color="#204080", annotation_id="ca9b4f7a-7575-4e96-8b19-31c4021b3ef2")
    first = request(tmp_path, "annotate", **request_body)["annotation"]
    library = Library(tmp_path / "library")
    try:
        before = library.pdf_path(item["id"]).read_bytes()
        retry = request(tmp_path, "annotate", **request_body)
        assert retry["duplicate"] is True and retry["annotation"]["id"] == first["id"]
        assert library.pdf_path(item["id"]).read_bytes() == before
        for change in ({"comment": "Changed"}, {"paths": [[[20.3, 30.7], [41.1, 50.5]]]}, {"width": 4}, {"color": "#ff0000"}):
            with pytest.raises(ValueError, match="different content"):
                request(tmp_path, "annotate", **{**request_body, **change})
        assert len(library.annotations(item["id"])["annotations"]) == 2
    finally:
        library.close()


def test_external_ink_geometry_changes_version_even_with_same_bounding_box(tmp_path):
    item, _ = fixture(tmp_path)
    saved = request(tmp_path, "annotate", id=item["id"], page=1, type="ink", paths=[[[20, 30], [40, 50], [60, 30]]])["annotation"]
    before = next(value for value in request(tmp_path, "annotation_catalog", id=item["id"])["annotations"] if value["id"] == saved["id"])
    managed = request(tmp_path, "export_pdf", id=item["id"])["path"]
    with fitz.open(managed) as doc:
        page = doc[0]
        annot = next(value for value in page.annots() if value.info["id"] == saved["id"])
        doc.xref_set_key(annot.xref, "InkList", "[[20 670 40 650 60 670 40 655]]")
        annot.update()
        doc.saveIncr()
    after = next(value for value in request(tmp_path, "annotation_catalog", id=item["id"])["annotations"] if value["id"] == saved["id"])
    assert before["version"] != after["version"]


def test_large_external_ink_remains_in_pdf_with_bounded_projection(tmp_path):
    source = tmp_path / "external-ink.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        annot = page.add_ink_annot([[(20 + index % 50, 30 + index % 80) for index in range(MAX_INK_POINTS + 1)]])
        annot.update()
        doc.save(source)
    item = request(tmp_path, "import", path=str(source))["items"][0]
    value = request(tmp_path, "annotations", id=item["id"])["annotations"][0]
    assert value["paths"] == [] and value["geometry_truncated"] is True
    assert value["source"] == "external-pdf"
    xfdf = request(tmp_path, "export_annotations", id=item["id"], format="xfdf")
    assert len(xfdf["warnings"]) == 1
    with pytest.raises(ValueError, match="ANNOTATION_GEOMETRY_LIMIT"):
        request(tmp_path, "annotation_catalog", id=item["id"])
    with fitz.open(request(tmp_path, "export_pdf", id=item["id"])["path"]) as doc:
        page = doc[0]
        assert len(next(page.annots()).vertices[0]) == MAX_INK_POINTS + 1


def test_failed_ink_serialization_leaves_managed_pdf_unchanged(tmp_path, monkeypatch):
    item, _ = fixture(tmp_path)
    library = Library(tmp_path / "library")
    try:
        before = library.pdf_path(item["id"]).read_bytes()
        def fail(*args, **kwargs):
            raise OSError("Synthetic serialization failure")
        monkeypatch.setattr(library, "_atomic_save", fail)
        with pytest.raises(OSError, match="serialization failure"):
            library.annotate(item["id"], page=1, type="ink", paths=[[[20, 30], [40, 50]]])
        assert library.pdf_path(item["id"]).read_bytes() == before
    finally:
        library.close()
