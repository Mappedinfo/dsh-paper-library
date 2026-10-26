"""Synthetic source-order navigation and inert, density-preserving previews."""
import base64
import hashlib
from pathlib import Path

import pymupdf as fitz
import pytest

from dsh_paper_library.core import dispatch


def fixture(tmp_path, files):
    root = tmp_path / "manuscript"
    for path, body in files.items():
        file = root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(body, encoding="utf-8")
    config = {"library": str(tmp_path / "library")}
    project = dispatch({**config, "action": "latex_project_create", "root": str(root)})["project"]
    return root, lambda action, **args: dispatch({**config, "action": action, "id": project["id"], **args})


def test_outline_expands_occurrences_in_document_order_and_keeps_drafts_separate(tmp_path):
    root, call = fixture(tmp_path, {
        "main.tex": "\\documentclass{article}\n\\input{body}\n\\section{末尾}\n",
        "draft.tex": "\\documentclass{article}\n\\input{body}\n\\input{rp}\n",
        "body.tex": "\\section{中文标题}\n\\input{shared}\n\\subsection{}\n\\input{shared}\n",
        "shared.tex": "\\subsection[短标题]{Shared {nested} heading}\n",
        "rp.tex": "\\section{Research proposal}\n",
        "unused.tex": "\\section{Not in manuscript}\n",
    })
    before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*.tex")}
    result = call("latex_outline")
    headings = [e for e in result["events"] if e["kind"] == "heading"]
    assert [e["title"] for e in headings] == ["中文标题", "Shared {nested} heading", "（无标题 subsection）", "Shared {nested} heading", "末尾"]
    assert headings[1]["path"] == "shared.tex" and headings[1]["line"] == 1
    assert any(e.get("repeated") for e in result["events"])
    assert set(result["entries"]) == {"main.tex", "draft.tex"}
    assert "rp.tex" in result["unreferenced"]
    call("latex_project_update", main_path="draft.tex")
    draft = call("latex_outline")
    assert draft["main_path"] == "draft.tex"
    assert [e["title"] for e in draft["events"] if e["kind"] == "heading"][-1] == "Research proposal"
    assert all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in before.items())


def test_outline_skips_comments_definitions_and_examples_and_reports_uncertainty(tmp_path):
    root, call = fixture(tmp_path, {
        "main.tex": r"""\documentclass{article}
% \section{Comment}
\newcommand{\heading}[1]{\section{Macro definition}}
\def\other#1{\input{hidden}}
\begin{verbatim}
\section{Example}
\end{verbatim}
\verb|\section{inline}|
\input{\dynamic/path}
\input{cycle}
\input{../outside}
\input{missing}
\ifdraft\section{Static branch}\fi
\section*{真实章节}
\begin{abstract}Text\end{abstract}
\end{document}
\section{After end}
""",
        "cycle.tex": "\\input{main}\n",
        "hidden.tex": "\\section{Hidden}\n",
    })
    result = call("latex_outline")
    assert [e["title"] for e in result["events"] if e["kind"] == "heading"] == ["Static branch", "真实章节", "摘要 / Abstract"]
    warnings = [e["title"] for e in result["events"] if e["kind"] == "warning"]
    assert "循环引用" in warnings and "动态引用未解析" in warnings
    assert any("超出项目" in w for w in warnings) and any("不存在" in w for w in warnings)
    assert any("未解释" in w for w in warnings)
    (root / "escape.tex").symlink_to(tmp_path / "outside.tex")
    (tmp_path / "outside.tex").write_text("private", encoding="utf-8")
    (root / "main.tex").write_text("\\input{escape}", encoding="utf-8")
    assert any("超出项目" in e["title"] for e in call("latex_outline")["events"])


def test_outline_and_tree_budgets_report_incomplete_coverage(tmp_path, monkeypatch):
    from dsh_paper_library import latex_outline
    root, call = fixture(tmp_path, {"main.tex": "\\input{a}\n" * 20, "a.tex": "\\section{A}\n"})
    monkeypatch.setattr(latex_outline, "MAX_EVENTS", 5)
    result = call("latex_outline")
    assert result["truncated"] is True and len(result["events"]) == 5
    assert result["limited_interpretation"] is True


def test_density_is_fulfilled_exactly_or_refused_without_silent_downsampling(tmp_path):
    root, call = fixture(tmp_path, {"main.tex": "\\documentclass{article}"})
    with fitz.open() as doc:
        doc.new_page(width=600, height=800).insert_text((40, 50), "Retina preview text")
        doc.new_page(width=300, height=300)
        doc.save(root / "main.pdf")
    call("latex_project_update", main_path="main.tex")
    result = call("latex_pdf_page", scale=8)
    assert result["pixel_width"] == 4800 and result["pixel_height"] == 6400
    assert result["scale"] == 8 and result["limited"] is False
    assert base64.b64decode(result["image"]).startswith(b"\x89PNG")
    for scale in [0, -1, float("inf"), float("nan")]:
        with pytest.raises(ValueError, match="渲染比例"):
            call("latex_pdf_page", scale=scale)
    for scale in [100, 1e308]:
        with pytest.raises(ValueError, match="未降低清晰度"):
            call("latex_pdf_page", scale=scale)
    for page in [0, 3, 1.5, True]:
        with pytest.raises(ValueError, match="页码"):
            call("latex_pdf_page", page=page)
    layout = call("latex_pdf_pages")
    assert layout["version"] and layout["page_count"] == 2


def test_media_preview_is_inert_bounded_and_confined(tmp_path):
    root, call = fixture(tmp_path, {"main.tex": "\\documentclass{article}", "media/formal/safe.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="200" height="80" fill="blue"/></svg>', "media/formal/data.xyz": "unsupported"})
    svg = call("latex_media_preview", path="media/formal/safe.svg", scale=2)
    assert svg["supported"] and svg["mime_type"] == "image/png" and svg["pixel_width"] == 480
    png = fitz.Pixmap(base64.b64decode(svg["image"]))
    png.save(root / "media" / "figure.png")
    png.save(root / "media" / "figure.jpg")
    for name in ["figure.png", "figure.jpg"]:
        result = call("latex_media_preview", path=f"media/{name}")
        assert result["source_width"] == 480 and result["source_height"] == 200
    unknown = call("latex_media_preview", path="media/formal/data.xyz")
    assert unknown["supported"] is False and "reason" in unknown
    assert any(e["path"] == "media/formal/data.xyz" for e in call("latex_tree")["files"])
    with pytest.raises(ValueError, match="超出项目"):
        call("latex_media_preview", path="../outside.png")
    (root / "media" / "escape.png").symlink_to(tmp_path / "outside.png")
    with pytest.raises(ValueError, match="超出项目"):
        call("latex_media_preview", path="media/escape.png")
    for attack in ['<script>alert(1)</script>', '<rect onload="alert(1)"/>', '<use href="file:///etc/passwd"/>', '<style>@import "https://example.com/a";</style>', '<image href="https://example.com/a.png"/>', '<foreignObject/>']:
        (root / "media" / "attack.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg">{attack}</svg>', encoding="utf-8")
        with pytest.raises(ValueError, match="SVG"):
            call("latex_media_preview", path="media/attack.svg")


def test_entry_without_pdf_cannot_keep_previous_entry_pdf(tmp_path):
    root, call = fixture(tmp_path, {"main.tex": "\\documentclass{article}", "draft.tex": "\\documentclass{article}"})
    with fitz.open() as doc:
        doc.new_page()
        doc.save(root / "main.pdf")
    assert call("latex_project_update", main_path="main.tex")["project"]["pdf_present"]
    switched = call("latex_project_update", main_path="draft.tex")["project"]
    assert switched["pdf_path"] is None and not switched["pdf_present"]
    with pytest.raises(ValueError, match="还没有 PDF"):
        call("latex_pdf_pages")
