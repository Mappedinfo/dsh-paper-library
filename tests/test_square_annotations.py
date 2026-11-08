"""合成 PDF 的矩形框与自由笔画原生往返；不使用用户文献。"""
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import pymupdf as fitz
import pytest

from dsh_paper_library.core import dispatch


def request(tmp_path, action, **values):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **values})


def source_pdf(tmp_path, rotation=0):
    source = tmp_path / "synthetic-figure.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=500)
        page.insert_text((90, 160), "Synthetic figure detail")
        page.draw_rect(fitz.Rect(80, 170, 190, 240), color=(0, .5, .2), fill=(.8, .9, .8))
        external = page.add_text_annot((60, 100), "External note to preserve")
        external.set_info(title="Synthetic external reader")
        external.update()
        page.set_cropbox(fitz.Rect(40, 70, 360, 450))
        page.set_rotation(rotation)
        doc.save(source)
    return source


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_square_and_free_ink_are_native_portable_editable_objects(tmp_path, rotation):
    source = source_pdf(tmp_path, rotation)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    paper = request(tmp_path, "import", path=str(source))["items"][0]
    identity = {"id": paper["id"], "page": 1}
    rect = [30, 35, 180, 135]
    square = request(tmp_path, "annotate", **identity, type="square", rects=[rect],
                     comment="Synthetic image detail", color="#3366CC", width=3)["annotation"]
    paths = [[[40, 160], [52, 170], [75, 165]], [[100, 170], [120, 180]]]
    ink = request(tmp_path, "annotate", **identity, type="ink", paths=paths,
                  comment="Synthetic free stroke", color="#007733", width=2.5)["annotation"]
    assert square["type"] == "square" and square["width"] == 3
    assert square["color"].get("fill") in (None, [])
    # MuPDF 标准矩形对象为描边增加外边界；选中的内部区域保持原坐标。
    outer = square["rect"]
    assert outer == pytest.approx([rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1], abs=.001)
    listed = request(tmp_path, "annotations", id=paper["id"])["annotations"]
    versions = {a["id"]: a["version"] for a in listed}
    request(tmp_path, "annotation_update", id=paper["id"], annotation_id=square["id"], comment="Revised detail")
    listed = request(tmp_path, "annotations", id=paper["id"])["annotations"]
    assert next(a for a in listed if a["id"] == square["id"])["version"] != versions[square["id"]]
    assert next(a for a in listed if a["id"] == ink["id"])["version"] == versions[ink["id"]]
    rendered = request(tmp_path, "page", **identity, scale=.5)
    for native in rendered["annotations"]:
        assert native["version"] == next(a for a in listed if a["id"] == native["id"])["version"]
    managed = Path(request(tmp_path, "export_pdf", id=paper["id"])["path"])
    with fitz.open(managed) as doc:
        page = doc[0]
        annotations = {a.info["id"]: a for a in page.annots()}
        a = annotations[square["id"]]
        assert a.type[0] == fitz.PDF_ANNOT_SQUARE
        assert doc.xref_get_key(a.xref, "Subtype") == ("name", "/Square")
        assert list(a.rect * page.rotation_matrix) == pytest.approx(outer, abs=.001)
        assert a.border["width"] == 3 and not a.colors.get("fill")
        assert doc.xref_get_key(a.xref, "IC")[0] == "null"
        assert a.info["content"] == "Revised detail"
        pdf_rect = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", doc.xref_get_key(a.xref, "Rect")[1])]
        a = annotations[ink["id"]]
        assert a.type[0] == fitz.PDF_ANNOT_INK and not a.irt_xref
        assert doc.xref_get_key(a.xref, "InkList")[0] == "array"
        assert a.border["width"] == 2.5
        for native, displayed in zip(a.vertices, paths):
            for point, expected in zip(native, displayed):
                assert list(fitz.Point(point) * page.rotation_matrix) == pytest.approx(expected, abs=.001)
        assert any(a.info["content"] == "External note to preserve" for a in annotations.values())
        with fitz.open(source) as original:
            interior = fitz.Rect(rect) + (10, 10, -10, -10)
            assert page.get_pixmap(clip=interior).samples == original[0].get_pixmap(clip=interior).samples
    exported = request(tmp_path, "export_annotations", id=paper["id"], format="xfdf")
    assert exported["warnings"] == []
    elements = {node.attrib["name"]: node for node in ET.fromstring(exported["text"]).find("{*}annots")}
    box = elements[square["id"]]
    assert box.tag.endswith("}square") and box.attrib["width"] == "3.0"
    assert "coords" not in box.attrib and "interior-color" not in box.attrib
    assert [float(v) for v in box.attrib["rect"].split(",")] == pytest.approx(pdf_rect, abs=.001)
    assert box.attrib["color"] == "#3366CC" and box.find("{*}contents").text == "Revised detail"
    assert len(elements[ink["id"]].find("{*}inklist")) == 2
    json_export = json.loads(request(tmp_path, "export_annotations", id=paper["id"], format="json")["text"])
    assert next(a for a in json_export["annotations"] if a["id"] == square["id"])["width"] == 3
    fresh = dispatch({"library": str(tmp_path / "fresh"), "action": "import", "path": str(managed)})["items"][0]
    recovered = dispatch({"library": str(tmp_path / "fresh"), "action": "annotations", "id": fresh["id"]})["annotations"]
    assert {a["id"]: a["type"] for a in recovered} == {a["id"]: a["type"] for a in listed}
    request(tmp_path, "annotation_delete", id=paper["id"], annotation_id=square["id"])
    remaining = request(tmp_path, "annotations", id=paper["id"])["annotations"]
    assert square["id"] not in {a["id"] for a in remaining} and ink["id"] in {a["id"] for a in remaining}
    assert any(a["comment"] == "External note to preserve" for a in remaining)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    assert list((tmp_path / "library" / "backups").glob("*.bak"))


@pytest.mark.parametrize("overrides", [
    {"rects": []}, {"rects": [[20, 20, 30, 30], [40, 40, 50, 50]]},
    {"rects": [[20, 20, 20, 40]]}, {"rects": [[-1, 20, 30, 40]]},
    {"rects": [[20, 20, 900, 900]]}, {"rects": [[True, 20, 30, 40]]},
    {"rects": [[20, 20, float("nan"), 40]]}, {"width": True}, {"width": .4},
    {"width": 8.1}, {"width": float("inf")}, {"parent_id": "not-a-parent"},
])
def test_invalid_square_preserves_managed_pdf(tmp_path, overrides):
    paper = request(tmp_path, "import", path=str(source_pdf(tmp_path)))["items"][0]
    managed = Path(request(tmp_path, "export_pdf", id=paper["id"])["path"])
    before = managed.read_bytes()
    with pytest.raises(ValueError):
        request(tmp_path, "annotate", id=paper["id"], page=1, type="square",
                **{"rects": [[20, 20, 30, 40]], "width": 2, **overrides})
    assert managed.read_bytes() == before
