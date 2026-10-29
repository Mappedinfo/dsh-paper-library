"""Explicit writing intake uses synthetic images and workbooks only."""
import base64
import io
import zipfile

import pymupdf as fitz
import pytest
from openpyxl import Workbook

from dsh_paper_library.core import dispatch


def request(tmp_path, action, **values):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **values})


def project(tmp_path):
    root = tmp_path / "manuscript"
    root.mkdir()
    (root / "main.tex").write_text(r"\documentclass{article}\begin{document}Synthetic\end{document}")
    return root, request(tmp_path, "latex_project_create", root=str(root))["project"]["id"]


def image():
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 20), False)
    pixmap.clear_with(220)
    return pixmap.tobytes("png")


def encoded(body):
    return base64.b64encode(body).decode("ascii")


def workbook(configure):
    book = Workbook()
    configure(book)
    stream = io.BytesIO()
    book.save(stream)
    book.close()
    return stream.getvalue()


def test_image_import_is_content_addressed_reusable_and_never_overwrites_source(tmp_path):
    root, identity = project(tmp_path)
    original = (root / "main.tex").read_bytes()
    body = image()
    first = request(tmp_path, "latex_asset_import", id=identity, name="图 1.png", data_base64=encoded(body))
    assert first["path"].startswith("figures/1-") and first["path"].endswith(".png")
    assert first["reused"] is False
    assert (root / first["path"]).read_bytes() == body
    assert request(tmp_path, "latex_asset_import", id=identity, name="图 1.png", data_base64=encoded(body))["reused"] is True
    assert (root / "main.tex").read_bytes() == original
    (root / first["path"]).write_bytes(b"preserve this original")
    with pytest.raises(ValueError, match="未覆盖"):
        request(tmp_path, "latex_asset_import", id=identity, name="图 1.png", data_base64=encoded(body))
    assert (root / first["path"]).read_bytes() == b"preserve this original"


def test_image_refuses_symlink_escape_path_names_invalid_data_and_archived_project(tmp_path):
    root, identity = project(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "figures").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="超出项目目录"):
        request(tmp_path, "latex_asset_import", id=identity, name="x.png", data_base64=encoded(image()))
    assert not list(outside.iterdir())
    for name in ["../x.png", "a/b.png", "a\\b.png"]:
        with pytest.raises(ValueError, match="文件名无效"):
            request(tmp_path, "latex_asset_import", id=identity, name=name, data_base64=encoded(image()))
    for body in [b"not an image", b"\x89PNG\r\n\x1a\nbroken"]:
        with pytest.raises(ValueError):
            request(tmp_path, "latex_asset_import", id=identity, name="x.png", data_base64=encoded(body))
    with pytest.raises(ValueError, match="编码无效"):
        request(tmp_path, "latex_asset_import", id=identity, name="x.png", data_base64="!!!")
    request(tmp_path, "latex_project_archive", id=identity)
    with pytest.raises(ValueError, match="已归档"):
        request(tmp_path, "latex_asset_import", id=identity, name="x.png", data_base64=encoded(image()))


def test_xlsx_reads_explicit_sheet_values_without_writing_workbook(tmp_path):
    def configure(book):
        book.active.title = "Measurements"
        book.active.append(["Name", "Value"])
        book.active.append(["A & B", 12.5])
        book.active.append([True, None])
        book.create_sheet("Other").append(["中文", "text"])
    body = workbook(configure)
    result = request(tmp_path, "latex_table_import", data_base64=encoded(body))
    assert result["sheets"] == ["Measurements", "Other"]
    assert result["rows"] == [["Name", "Value"], ["A & B", "12.5"], ["True", ""]]
    assert result["warnings"]
    other = request(tmp_path, "latex_table_import", data_base64=encoded(body), sheet="Other")
    assert other["rows"] == [["中文", "text"]]
    with pytest.raises(ValueError, match="工作表不存在"):
        request(tmp_path, "latex_table_import", data_base64=encoded(body), sheet="Missing")


def test_xlsx_rejects_formula_without_cache_and_accepts_cached_value(tmp_path):
    body = workbook(lambda book: setattr(book.active["A1"], "value", "=1+1"))
    with pytest.raises(ValueError, match="没有缓存结果"):
        request(tmp_path, "latex_table_import", data_base64=encoded(body))
    rewritten = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(body)) as old, zipfile.ZipFile(rewritten, "w") as new:
        for item in old.infolist():
            content = old.read(item)
            if item.filename == "xl/worksheets/sheet1.xml":
                content = content.replace(b"<v></v>", b"<v>2</v>").replace(b"<v />", b"<v>2</v>")
            new.writestr(item.filename, content)
    result = request(tmp_path, "latex_table_import", data_base64=encoded(rewritten.getvalue()))
    assert result["rows"] == [["2"]]
    assert any("缓存" in warning for warning in result["warnings"])


def test_xlsx_bounds_and_untrusted_archive_are_rejected(tmp_path):
    for coordinate in ["A101", "AE1"]:
        body = workbook(lambda book: setattr(book.active[coordinate], "value", "outside"))
        with pytest.raises(ValueError, match="超过"):
            request(tmp_path, "latex_table_import", data_base64=encoded(body))
    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/workbook.xml", b"A" * (8 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="解压内容超过"):
        request(tmp_path, "latex_table_import", data_base64=encoded(bad.getvalue()))
    with pytest.raises(ValueError, match="XLSX 无法读取"):
        request(tmp_path, "latex_table_import", data_base64=encoded(b"not a workbook"))
