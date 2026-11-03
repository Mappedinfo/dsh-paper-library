"""PDF search targets and bounds, exercised with synthetic PDF pages only."""

import pymupdf as fitz
import pytest

from dsh_paper_library import latex_pdf_search, latex_versions
from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.latex import _project


def write_pdf(path, pages):
    with fitz.open() as document:
        for lines, rotation in pages:
            page = document.new_page(width=240, height=180)
            for index, text in enumerate(lines):
                page.insert_text((25, 35 + 24 * index), text, fontname="china-s")
            page.set_rotation(rotation)
        document.save(path)


def project(tmp_path, pages, name="manuscript"):
    root = tmp_path / name
    root.mkdir()
    (root / "main.tex").write_text("\\documentclass{article}\n\\begin{document}Synthetic.\\end{document}\n")
    pdf = root / "main.pdf"
    write_pdf(pdf, pages)
    config = {"library": str(tmp_path / "library")}
    result = dispatch({**config, "action": "latex_project_create", "root": str(root)})["project"]

    def call(action, **args):
        return dispatch({**config, "action": action, "id": result["id"], **args})

    return pdf, result, call


def test_search_returns_rotated_display_rectangles_and_rejects_stale_preview(tmp_path):
    pdf, _, call = project(tmp_path, [(["Unrelated page"], 0), (["合成 章节 测试", "这是第二处合成测试"], 90)])
    layout = call("latex_pdf_pages")
    result = call("latex_pdf_search", query="测试", expected_version=layout["version"])
    assert result["version"] == layout["version"] and result["next_page"] is None
    assert [(item["page"], item["text"]) for item in result["matches"]] == [(2, "测试"), (2, "测试")]
    with fitz.open(pdf) as document:
        first = document[1].search_for("测试")[0]
    x0, y0, x1, y1 = first
    assert result["matches"][0]["rects"][0] == pytest.approx([180 - y1, x0, 180 - y0, x1])
    write_pdf(pdf, [(["New revision with different text."], 0)])
    with pytest.raises(ValueError, match="PDF 已更新"):
        call("latex_pdf_search", query="测试", expected_version=layout["version"])


def test_pdf_search_batch_limit_restarts_page_without_losing_hits(tmp_path, monkeypatch):
    _, _, call = project(tmp_path, [(["Alpha"], 0), (["Alpha", "Alpha"], 0), (["Alpha", "Alpha", "Alpha"], 0)])
    monkeypatch.setattr(latex_pdf_search, "MAX_BATCH_HITS", 2)
    first = call("latex_pdf_search", query="alpha")
    assert len(first["matches"]) == 1 and first["next_page"] == 2 and not first["truncated"]
    second = call("latex_pdf_search", query="alpha", start_page=first["next_page"], expected_version=first["version"])
    assert [hit["page"] for hit in second["matches"]] == [2, 2]
    assert second["next_page"] == 3 and not second["truncated"]
    last = call("latex_pdf_search", query="alpha", start_page=second["next_page"], expected_version=first["version"])
    assert [hit["page"] for hit in last["matches"]] == [3, 3]
    assert last["next_page"] is None and last["truncated"]


def test_search_reads_frozen_preview_and_review_pdf_for_own_project(tmp_path):
    pdf, active, call = project(tmp_path, [(["Frozen synthetic document"], 0)])
    layout = call("latex_pdf_pages")
    digest = layout["build"]["pdf_version"]
    call("latex_review_put", anchor={"kind": "pdf", "page": 1, "pdf_version": digest,
                                    "rects": [[25, 26, 68, 37]], "text": "Frozen"}, comment="Synthetic note")
    library = Library(str(tmp_path / "library"))
    try:
        row = _project(library, active["id"])
        version_id = latex_versions.create(library, row, "pdflatex", latex_versions.capture_sources(library, row))["id"]
    finally:
        library.close()
    write_pdf(pdf, [(["New synthetic revision"], 0)])
    assert not call("latex_pdf_search", query="Frozen")["matches"]
    for args in ({"version_id": version_id}, {"version_id": version_id, "review_pdf_version": digest}):
        expected = call("latex_version_pdf_pages", **args)["version"]
        result = call("latex_pdf_search", query="Frozen", expected_version=expected, **args)
        assert result["version"] == expected and len(result["matches"]) == 1
    _, _, call_other = project(tmp_path, [(["Another project"], 0)], name="another")
    with pytest.raises(ValueError, match="不属于当前项目"):
        call_other("latex_pdf_search", query="Frozen", version_id=version_id)
