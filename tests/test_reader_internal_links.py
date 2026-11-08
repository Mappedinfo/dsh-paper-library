"""合成 PDF 原生内页链接：显示坐标、目的地、安全边界与读取预算。"""
import hashlib

import pymupdf as fitz
import pytest

from dsh_paper_library.annotations import AnnotationAccess
from dsh_paper_library.core import dispatch


def linked_pdf(path, rotation=0, named=False):
    with fitz.open() as doc:
        doc.new_page(width=300, height=500)
        doc.new_page(width=400, height=600)
        doc[0].insert_text((20, 40), "Synthetic citation (Example, 2013).", fontsize=10)
        doc[0].insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(20, 40, 100, 60),
                            "page": 1, "to": fitz.Point(40, 80)})
        data = doc.tobytes()
    with fitz.open(stream=data, filetype="pdf") as doc:
        if named:
            xref = doc[0].get_links()[0]["xref"]
            doc.xref_set_key(doc.pdf_catalog(), "Names",
                             f"<< /Dests << /Names [(references) [{doc[1].xref} 0 R /XYZ 40 520 0]] >> >>")
            doc.xref_set_key(xref, "A", "<< /S /GoTo /D (references) >>")
        doc[0].set_cropbox(fitz.Rect(10, 20, 290, 480))
        doc[1].set_cropbox(fitz.Rect(10, 20, 390, 580))
        doc[0].set_rotation(rotation)
        doc[1].set_rotation(rotation)
        doc.save(path)
    return path


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("named", [False, True])
def test_page_internal_links_use_displayed_crop_and_rotation_coordinates(tmp_path, rotation, named):
    source = linked_pdf(tmp_path / "links.pdf", rotation, named)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    library = str(tmp_path / "library")
    paper = dispatch({"library": library, "action": "import", "path": str(source)})["items"][0]
    result = dispatch({"library": library, "action": "page", "id": paper["id"], "page": 1, "scale": .5})
    with fitz.open(source) as doc:
        expected_rect = fitz.Rect(10, 20, 90, 40) * doc[0].rotation_matrix
        expected_to = fitz.Point(30, 60) * doc[1].rotation_matrix
    assert len(result["internal_links"]) == 1
    assert result["internal_links"][0]["rect"] == pytest.approx(list(expected_rect))
    assert result["internal_links"][0]["page"] == 2
    assert result["internal_links"][0]["to"] == pytest.approx(list(expected_to))
    assert result["internal_links_truncated"] is False
    assert result["limits"]["internal_links"] == 1000
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before


def test_external_actions_and_unresolved_destinations_are_not_exposed(tmp_path):
    source = linked_pdf(tmp_path / "links.pdf")
    with fitz.open(source) as doc:
        # 每项都是合成动作；读取接口绝不能返回外部目标或执行动作。
        for index in range(6):
            doc[0].insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(20, 100 + index * 25, 100, 120 + index * 25),
                                "page": 1, "to": fitz.Point(40, 80)})
        data = doc.tobytes()
    actions = [
        "<< /S /URI /URI (https://example.invalid/) >>",
        "<< /S /GoToR /F (external.pdf) /D [0 /Fit] >>",
        "<< /S /Launch /F (external.pdf) >>",
        r"<< /S /JavaScript /JS (app.alert\(1\)) >>",
        "<< /S /GoTo /D (missing-destination) >>",
        "<< /S /GoTo /D [999 /XYZ 0 0 0] >>",
    ]
    with fitz.open(stream=data, filetype="pdf") as doc:
        for item, action in zip(doc[0].get_links()[1:], actions):
            doc.xref_set_key(item["xref"], "A", action)
        data = doc.tobytes()
    with fitz.open(stream=data, filetype="pdf") as doc:
        links, truncated = AnnotationAccess._page_internal_links(doc, doc[0])
    assert len(links) == 1
    assert links[0]["page"] == 2
    assert set(links[0]) == {"rect", "page", "to"}
    assert truncated is False


def test_link_budget_bounds_inspected_links_even_for_external_actions(tmp_path, monkeypatch):
    import dsh_paper_library.annotations as module
    monkeypatch.setattr(module, "READER_MAX_INTERNAL_LINKS", 2)
    with fitz.open() as doc:
        doc.new_page(width=300, height=400)
        for index in range(3):
            doc[0].insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(20, 40 + index * 20, 100, 55 + index * 20),
                                "uri": "https://example.invalid/"})
        data = doc.tobytes()
    with fitz.open(stream=data, filetype="pdf") as doc:
        # 使用链式读取，不能先构建无限制的 get_links() 列表再切片。
        monkeypatch.setattr(fitz.Page, "get_links", lambda *_: pytest.fail("unbounded get_links"))
        links, truncated = AnnotationAccess._page_internal_links(doc, doc[0])
    assert links == [] and truncated is True


def test_missing_and_nonfinite_targets_are_skipped_and_page_edges_clamped():
    class Destination:
        kind = fitz.LINK_GOTO

    class Link:
        is_external = False
        dest = Destination()
        rect = fitz.Rect(-10, 20, 50, 60)
        uri = "#page=2"
        next = None

    class Page:
        rect = fitz.Rect(0, 0, 300, 400)
        first_link = Link()

    class Doc:
        page_count = 2
        resolved = (1, 20, 40)
        def resolve_link(self, _):
            return self.resolved
        def __getitem__(self, _):
            return Page()

    doc = Doc()
    for invalid in [(-1, 0, 0), (2, 0, 0), (1, float("nan"), 0), (1, 0, float("inf"))]:
        doc.resolved = invalid
        assert AnnotationAccess._page_internal_links(doc, Page())[0] == []
    doc.resolved = (1, -10, 450)
    assert AnnotationAccess._page_internal_links(doc, Page())[0] == [
        {"rect": [0.0, 20.0, 50.0, 60.0], "page": 2, "to": [0.0, 400.0]}]
