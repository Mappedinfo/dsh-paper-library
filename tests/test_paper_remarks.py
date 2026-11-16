from contextlib import closing

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.paper_remarks import RemarkConflict


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_remark_is_a_first_page_native_note_and_survives_reimport(tmp_path, rotation):
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((72, 72), "Synthetic evaluation")
        page.add_text_annot((40, 40), "Existing PDF note")
        page.set_rotation(rotation)
        doc.new_page()
        doc.save(source)
    original = source.read_bytes()
    path = str(tmp_path / "library")
    with closing(Library(path)) as library:
        item = library.import_items(path=str(source))["items"][0]
        managed = library.pdf_path(item["id"])
    params = {"library": path, "view": "paper-remark"}

    def read():
        return dispatch({**params, "action": "annotations", "ids": [item["id"]]})["items"][0]["remark"]

    def save(text, version):
        return dispatch({**params, "action": "annotation_update", "id": item["id"],
                         "comment": text, "expected_version": version})["remark"]

    assert read() is None
    first = save("方法清晰。\n建议核对验证范围。", None)
    assert first == read()
    assert save(first["comment"], None) == first
    assert first["page"] == 1
    with fitz.open(managed) as doc:
        page = doc[0]
        native = list(page.annots())
        assert len(native) == 2
        note = next(annotation for annotation in native if annotation.info["id"] == first["annotation_id"])
        assert note.type[0] == 0
        assert note.info["subject"] == "文献备注"
        assert note.info["content"] == first["comment"]
        assert page.rect.contains(note.rect * page.rotation_matrix)
        assert not list(doc[1].annots())
    normal = dispatch({"library": path, "action": "annotations", "id": item["id"]})["annotations"]
    assert [row["kind"] for row in normal if row.get("kind")] == ["paper-remark"]
    assert (tmp_path / "library" / "backups" / (item["id"] + ".pdf.bak")).is_file()
    assert source.read_bytes() == original

    with closing(Library(tmp_path / "another")) as other:
        imported = other.import_items(path=str(managed))["items"][0]
        moved = dispatch({"library": str(other.root), "action": "annotations", "view": "paper-remark",
                          "ids": [imported["id"]]})["items"][0]["remark"]
        assert moved == first
    second = save("更新后的评价", first["version"])
    assert second["annotation_id"] == first["annotation_id"]
    with pytest.raises(RemarkConflict):
        save("旧窗口的评价", first["version"])
    assert save("", second["version"]) is None
    assert read() is None
    with fitz.open(managed) as doc:
        page = doc[0]
        assert [entry.info["content"] for entry in page.annots()] == ["Existing PDF note"]
