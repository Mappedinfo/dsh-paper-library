"""Synthetic page geometry and standard PDF markup portability contracts."""
import base64
import hashlib
import json
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, dispatch


def request(tmp_path, action, **values):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **values})


def synthetic_pdf(path, pages):
    with fitz.open() as doc:
        for width, height, rotation in pages:
            page = doc.new_page(width=width, height=height)
            page.insert_text((55, 75), "Synthetic evidence for portable annotation.")
            note = page.add_text_annot((25, 25), "Existing external annotation")
            note.set_info(title="Synthetic external reader")
            note.update()
            page.set_rotation(rotation)
        doc.save(path)
    return path


def test_page_layout_uses_geometry_only_and_closes_pdf_before_return(tmp_path, monkeypatch):
    source = synthetic_pdf(tmp_path / "source.pdf", [(300, 400, 0), (500, 250, 90), (600, 300, 180), (320, 540, 270)])
    item = request(tmp_path, "import", path=str(source))["items"][0]
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    managed = Path(request(tmp_path, "export_pdf", id=item["id"])["path"])
    managed_hash = hashlib.sha256(managed.read_bytes()).hexdigest()
    original_open = Library._open_pdf
    opened = []

    def tracked_open(path, writing=False):
        assert writing is False
        doc = original_open(path, writing=writing)
        opened.append(doc)
        return doc

    def forbidden(*args, **kwargs):
        raise AssertionError("page_layout attempted pixel, text, image or annotation extraction")

    monkeypatch.setattr(Library, "_open_pdf", staticmethod(tracked_open))
    for method in ("get_text", "get_pixmap", "get_images", "annots"):
        monkeypatch.setattr(fitz.Page, method, forbidden)
    layout = request(tmp_path, "page_layout", id=item["id"])
    assert layout["id"] == item["id"] and layout["page_count"] == 4
    assert layout["coordinate_system"] == "displayed-pdf-points" and layout["rotation_applied"] is True
    assert layout["truncated"] is False and layout["limits"]["pages"] == 2000
    assert [(page["width"], page["height"]) for page in layout["pages"]] == [(300, 400), (250, 500), (600, 300), (540, 320)]
    assert [page["rotation"] for page in layout["pages"]] == [0, 90, 180, 270]
    assert all(set(page) == {"page", "width", "height", "rotation"} for page in layout["pages"])
    assert opened and all(doc.is_closed for doc in opened)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    assert hashlib.sha256(managed.read_bytes()).hexdigest() == managed_hash


def test_layout_dimensions_match_bounded_renderer_at_mixed_sizes_and_rotations(tmp_path):
    source = synthetic_pdf(tmp_path / "source.pdf", [(300, 400, 0), (520, 260, 90), (600, 300, 180), (320, 540, 270)])
    item = request(tmp_path, "import", path=str(source))["items"][0]
    layout = request(tmp_path, "page_layout", id=item["id"])
    for geometry in layout["pages"]:
        page = request(tmp_path, "page", id=item["id"], page=geometry["page"], scale=1.5)
        assert (page["width"], page["height"], page["rotation"]) == (geometry["width"], geometry["height"], geometry["rotation"])
        image = base64.b64decode(page["image"])
        assert image.startswith(b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", image[16:24])
        assert width == pytest.approx(geometry["width"] * page["scale"], abs=1)
        assert height == pytest.approx(geometry["height"] * page["scale"], abs=1)
        assert width * height <= 4_000_000
        for word in page["words"]:
            assert 0 <= word[0] < word[2] <= geometry["width"]
            assert 0 <= word[1] < word[3] <= geometry["height"]


def test_layout_rejects_no_pdf_archived_and_oversized_documents(tmp_path):
    item = request(tmp_path, "create", metadata={"title": "Synthetic empty record"})
    with pytest.raises(ValueError, match="no attached PDF"):
        request(tmp_path, "page_layout", id=item["id"])
    # This emulates an externally replaced managed copy, not an import bypass in
    # the product. The same reader gate must protect page-tree introspection.
    path = tmp_path / "library" / "pdfs" / "oversized-synthetic.pdf"
    with fitz.open() as doc:
        for _ in range(2001):
            doc.new_page(width=100, height=100)
        doc.save(path)
    library = Library(tmp_path / "library")
    try:
        with library.lock():
            library.db.execute("UPDATE papers SET pdf_path=? WHERE id=?", ("pdfs/oversized-synthetic.pdf", item["id"]))
    finally:
        library.close()
    with pytest.raises(ValueError, match="2000-page limit"):
        request(tmp_path, "page_layout", id=item["id"])
    request(tmp_path, "archive", id=item["id"])
    with pytest.raises(ValueError, match="archived"):
        request(tmp_path, "page_layout", id=item["id"])


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("kind,native_type", [("highlight", 8), ("underline", 9), ("strikeout", 11), ("note", 0)])
def test_standard_markup_roundtrip_update_native_geometry_color_and_exports(tmp_path, rotation, kind, native_type):
    source = synthetic_pdf(tmp_path / "source.pdf", [(400, 500, rotation)])
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    item = request(tmp_path, "import", path=str(source))["items"][0]
    page = request(tmp_path, "page", id=item["id"])
    words = page["words"][:2]
    rects = [word[:4] for word in words]
    note = request(tmp_path, "annotate", id=item["id"], page=1, type=kind, rects=rects,
                   text=" ".join(word[4] for word in words), comment="Synthetic interpretation", color="#3489CB", author="Synthetic reader")["annotation"]
    updated = request(tmp_path, "annotation_update", id=item["id"], annotation_id=note["id"], comment="Revised synthetic interpretation")["annotation"]
    assert updated["id"] == note["id"] and updated["type"] == kind
    assert updated["color"]["stroke"] == pytest.approx([0x34 / 255, 0x89 / 255, 0xCB / 255])
    assert updated["comment"] == "Revised synthetic interpretation"
    pdf = Path(request(tmp_path, "export_pdf", id=item["id"])["path"])
    native_points = None
    with fitz.open(pdf) as doc:
        page = doc[0]
        annot = next(a for a in page.annots() if a.info["id"] == note["id"])
        assert annot.type[0] == native_type
        assert doc.xref_get_key(annot.xref, "NM")[1] == note["id"]
        if kind != "note":
            assert len(updated["rects"]) == len(rects)
            for actual, original in zip(updated["rects"], rects):
                assert actual == pytest.approx(original, abs=0.001)
            # Quad ordering is native text-baseline ordering, even after display
            # rotation. Underline/strikeout must not use a screen-box bottom edge.
            native_rect = fitz.Rect(rects[0]) * page.derotation_matrix
            for actual, expected in zip(annot.vertices[:4], native_rect.quad):
                assert actual == pytest.approx(tuple(expected), abs=0.001)
            native_points = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", doc.xref_get_key(annot.xref, "QuadPoints")[1])]
    exported = request(tmp_path, "export_annotations", id=item["id"], format="xfdf")
    xml = ET.fromstring(exported["text"])
    element = next(node for node in xml.find("{*}annots") if node.attrib["name"] == note["id"])
    assert element.tag.rsplit("}", 1)[-1] == ("text" if kind == "note" else kind)
    assert element.attrib["color"] == "#3489CB"
    assert element.find("{*}contents").text == updated["comment"]
    if native_points is not None:
        assert [float(value) for value in element.attrib["coords"].split(",")] == pytest.approx(native_points, abs=0.001)
    json_export = json.loads(request(tmp_path, "export_annotations", id=item["id"], format="json")["text"])
    assert next(value for value in json_export["annotations"] if value["id"] == note["id"])["type"] == kind
    assert f"· {kind} · {note['id']}" in request(tmp_path, "export_annotations", id=item["id"], format="markdown")["text"]
    fresh = dispatch({"library": str(tmp_path / "fresh"), "action": "import", "path": str(pdf)})["items"][0]
    recovered = dispatch({"library": str(tmp_path / "fresh"), "action": "annotations", "id": fresh["id"]})["annotations"]
    assert next(value for value in recovered if value["id"] == note["id"])["type"] == kind
    assert any(value["comment"] == "Existing external annotation" for value in recovered)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    assert len(list((tmp_path / "library" / "backups").glob("*.bak"))) == 1


@pytest.mark.parametrize("kind", ["underline", "strikeout"])
def test_markup_failure_leaves_managed_pdf_and_original_unchanged(tmp_path, kind):
    source = synthetic_pdf(tmp_path / "source.pdf", [(400, 500, 0)])
    item = request(tmp_path, "import", path=str(source))["items"][0]
    pdf = Path(request(tmp_path, "export_pdf", id=item["id"])["path"])
    before = hashlib.sha256(pdf.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="inside displayed page"):
        request(tmp_path, "annotate", id=item["id"], page=1, type=kind, rects=[[-100, -100, 10, 10]])
    assert hashlib.sha256(pdf.read_bytes()).hexdigest() == before
    assert len(request(tmp_path, "annotations", id=item["id"])["annotations"]) == 1


@pytest.mark.parametrize("kind", ["underline", "strikeout"])
def test_external_standard_markup_is_read_and_updated_without_replacing_its_identity(tmp_path, kind):
    source = tmp_path / "external.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=500)
        page.insert_text((55, 75), "Synthetic external evidence")
        rect = fitz.Rect(page.get_text("words")[0][:4])
        creator = page.add_underline_annot if kind == "underline" else page.add_strikeout_annot
        annot = creator(rect.quad)
        annot.set_info(content="External interpretation", title="External reader")
        annot.set_colors(stroke=(0.2, 0.4, 0.8))
        annot.update()
        original_id = annot.info["id"]
        page.set_rotation(90)
        doc.save(source)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    item = request(tmp_path, "import", path=str(source))["items"][0]
    external = request(tmp_path, "annotations", id=item["id"])["annotations"][0]
    assert external["id"] == original_id and external["type"] == kind
    assert external["source"] == "external-pdf" and external["text"] == "Synthetic"
    updated = request(tmp_path, "annotation_update", id=item["id"], annotation_id=original_id, comment="Reader correction")["annotation"]
    assert updated["id"] == original_id and updated["type"] == kind
    assert updated["rects"][0] == pytest.approx(external["rects"][0], abs=0.001)
    assert updated["color"]["stroke"] == pytest.approx(external["color"]["stroke"])
    assert updated["source"] == "external-pdf" and updated["text"] == "Synthetic"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
