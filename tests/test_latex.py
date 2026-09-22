"""LaTeX projects: a real folder with sources, its PDF, revisions and a local build."""
import os
import shutil
import sys
from pathlib import Path

import pymupdf as fitz
import pytest

from dsh_paper_library.core import dispatch
from dsh_paper_library.latex import LatexConflict

HAS_LATEXMK = bool(shutil.which("latexmk") or Path("/Library/TeX/texbin/latexmk").is_file())
needs_latexmk = pytest.mark.skipif(not HAS_LATEXMK, reason="latexmk is required for the build checks")

MINIMAL = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section{Introduction}
Evidence from the manuscript.
\end{document}
"""


def request(library_root, action, **kw):
    return dispatch({"library": str(library_root / "library"), "action": action, **kw})


def make_project(root, name="manuscript", body=MINIMAL, extra=None, with_pdf=False):
    folder = root / name
    (folder / "sections").mkdir(parents=True, exist_ok=True)
    (folder / "main.tex").write_text(body, encoding="utf-8")
    (folder / "sections" / "intro.tex").write_text("\\section{Intro}\nText.\n", encoding="utf-8")
    (folder / "refs.bib").write_text("@article{a, title={A}}\n", encoding="utf-8")
    (folder / "figure.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    for path, content in (extra or {}).items():
        target = folder / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    if with_pdf:
        with fitz.open() as doc:
            doc.new_page(width=400, height=500).insert_text((50, 80), "compiled")
            doc.save(folder / "main.pdf")
    return folder


def test_create_registers_the_folder_and_finds_its_main_and_pdf(tmp_path):
    folder = make_project(tmp_path, with_pdf=True)
    created = request(tmp_path, "latex_project_create", root=str(folder), title="我的手稿")
    project = created["project"]
    assert project["title"] == "我的手稿"
    assert project["main_path"] == "main.tex"
    assert project["pdf_path"] == "main.pdf"
    assert project["exists"] is True and project["main_present"] is True and project["pdf_present"] is True

    listed = request(tmp_path, "latex_project_list")["projects"]
    assert [item["id"] for item in listed] == [project["id"]]
    detail = request(tmp_path, "latex_project_get", id=project["id"])["project"]
    assert detail["files"] == 5  # main.tex, refs.bib, sections/intro.tex, figure.png, main.pdf
    tree = request(tmp_path, "latex_tree", id=project["id"])
    assert [item["path"] for item in tree["files"] if item["kind"] == "text"] == ["main.tex", "refs.bib", "sections/intro.tex"]
    assert [item["path"] for item in tree["files"] if item["kind"] == "asset"] == ["figure.png", "main.pdf"]
    assert [item["path"] for item in tree["files"] if item["pdf"]] == ["main.pdf"]
    assert tree["main_path"] == "main.tex"
    with pytest.raises(ValueError, match="已经是 LaTeX 项目"):
        request(tmp_path, "latex_project_create", root=str(folder))


def test_create_offers_a_starter_only_when_asked(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="没有 .tex 文件"):
        request(tmp_path, "latex_project_create", root=str(empty))
    created = request(tmp_path, "latex_project_create", root=str(empty), create_missing=True)
    assert created["project"]["title"] == "empty"
    starter = empty / "main.tex"
    assert starter.is_file() and "\\documentclass" in starter.read_text(encoding="utf-8")
    assert (starter.stat().st_mode & 0o777) == 0o644


def test_main_detection_prefers_documentclass_and_accepts_an_explicit_choice(tmp_path):
    folder = tmp_path / "many"
    folder.mkdir()
    (folder / "a-notes.tex").write_text("random text\n", encoding="utf-8")
    (folder / "paper.tex").write_text("\\documentclass{article}\\begin{document}x\\end{document}\n", encoding="utf-8")
    created = request(tmp_path, "latex_project_create", root=str(folder))
    assert created["project"]["main_path"] == "paper.tex"
    other_kind = tmp_path / "kinds"
    other_kind.mkdir()
    (other_kind / "a-notes.txt").write_text("notes\n", encoding="utf-8")
    with pytest.raises(ValueError, match="主文件必须是 .tex"):
        request(tmp_path, "latex_project_create", root=str(other_kind), main_path="a-notes.txt")
    other = tmp_path / "other"
    other.mkdir()
    (other / "thesis.tex").write_text(MINIMAL, encoding="utf-8")
    (other / "notes.tex").write_text("notes\n", encoding="utf-8")
    chosen = request(tmp_path, "latex_project_create", root=str(other), main_path="notes.tex")
    assert chosen["project"]["main_path"] == "notes.tex"


def test_reads_and_writes_stay_inside_the_project_folder(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    read = request(tmp_path, "latex_read", id=project["id"])
    assert read["path"] == "main.tex" and read["main"] is True
    assert read["content"].startswith("\\documentclass")
    assert read["revision"] == request(tmp_path, "latex_read", id=project["id"], path="main.tex")["revision"]

    for attempt in ("../escape.tex", "/etc/hosts", "sections/../../escape.tex"):
        with pytest.raises(ValueError):
            request(tmp_path, "latex_read", id=project["id"], path=attempt)
        with pytest.raises(ValueError):
            request(tmp_path, "latex_write", id=project["id"], path=attempt, content="x")

    outside = tmp_path / "outside.tex"
    outside.write_text("secret\n", encoding="utf-8")
    os.symlink(outside, folder / "linked.tex")
    with pytest.raises(ValueError, match="超出项目目录"):
        request(tmp_path, "latex_read", id=project["id"], path="linked.tex")
    assert outside.read_text(encoding="utf-8") == "secret\n"
    assert not (tmp_path / "escape.tex").exists()

    with pytest.raises(ValueError, match="只支持写入文本源文件"):
        request(tmp_path, "latex_write", id=project["id"], path="figure.png", content="x")
    assert (folder / "figure.png").read_bytes() == b"\x89PNG\r\n\x1a\n"


def test_writes_are_revision_checked_and_keep_a_bounded_history(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    first = request(tmp_path, "latex_read", id=project["id"])
    written = request(tmp_path, "latex_write", id=project["id"], path="main.tex", content=MINIMAL.replace("Evidence", "Rewritten evidence"), expected_revision=first["revision"], origin="reader")
    assert written["changed"] is True and written["previous_revision"] == first["revision"]
    assert (folder / "main.tex").read_text(encoding="utf-8").count("Rewritten evidence") == 1

    stale = request(tmp_path, "latex_read", id=project["id"], path="main.tex")
    request(tmp_path, "latex_write", id=project["id"], path="main.tex", content=stale["content"] + "% more\n", expected_revision=stale["revision"], origin="reader")
    with pytest.raises(LatexConflict) as conflict:
        request(tmp_path, "latex_write", id=project["id"], path="main.tex", content="overwrite\n", expected_revision=stale["revision"])
    assert conflict.value.code == "STATE_CONFLICT"
    assert conflict.value.current["path"] == "main.tex" and conflict.value.current["revision"] != stale["revision"]
    assert "% more" in (folder / "main.tex").read_text(encoding="utf-8")

    unchanged = request(tmp_path, "latex_write", id=project["id"], path="main.tex", content=(folder / "main.tex").read_text(encoding="utf-8"), expected_revision=None)
    assert unchanged["changed"] is False

    history = request(tmp_path, "latex_history", id=project["id"], path="main.tex")
    assert history["current_revision"] and len(history["revisions"]) >= 3
    assert {item["origin"] for item in history["revisions"]} >= {"reader", "before-write"}
    difference = request(tmp_path, "latex_diff", id=project["id"], path="main.tex", from_revision="previous")
    assert difference["changed"] is True and difference["added"] >= 1 and "% more" in difference["diff"]
    same = request(tmp_path, "latex_diff", id=project["id"], path="main.tex", from_revision="current", to_revision="current")
    assert same["changed"] is False and same["diff"] == ""
    with pytest.raises(ValueError, match="还没有历史版本"):
        request(tmp_path, "latex_diff", id=project["id"], path="refs.bib", from_revision="previous")


def test_compare_diffs_the_same_file_across_two_projects(tmp_path):
    left = make_project(tmp_path, "left", body=MINIMAL)
    right = make_project(tmp_path, "right", body=MINIMAL.replace("Evidence from the manuscript.", "A different claim entirely."))
    a = request(tmp_path, "latex_project_create", root=str(left), title="第一版")["project"]
    b = request(tmp_path, "latex_project_create", root=str(right), title="第二版")["project"]
    compared = request(tmp_path, "latex_compare", a=a["id"], b=b["id"])
    assert compared["from"]["title"] == "第一版" and compared["to"]["title"] == "第二版"
    assert compared["changed"] is True
    assert "A different claim entirely." in compared["diff"] and "Evidence from the manuscript." in compared["diff"]
    same_file = request(tmp_path, "latex_compare", a=a["id"], b=b["id"], path="refs.bib")
    assert same_file["changed"] is False
    with pytest.raises(ValueError, match="两个不同的项目"):
        request(tmp_path, "latex_compare", a=a["id"], b=a["id"])


def test_roots_in_the_managed_library_are_refused(tmp_path):
    library = tmp_path / "library"
    (library / "pdfs").mkdir(parents=True)
    with pytest.raises(ValueError, match="受管目录"):
        request(tmp_path, "latex_project_create", root=str(library / "pdfs"))
    with pytest.raises(ValueError, match="绝对路径"):
        request(tmp_path, "latex_project_create", root="relative/folder")
    with pytest.raises(ValueError, match="不存在"):
        request(tmp_path, "latex_project_create", root=str(tmp_path / "missing"))


def test_archive_keeps_the_folder_and_blocks_edits(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    archived = request(tmp_path, "latex_project_archive", id=project["id"])
    assert archived["folder_kept"] == str(folder)
    assert archived["project"]["archived"] is True
    assert (folder / "main.tex").is_file()
    with pytest.raises(ValueError, match="已归档"):
        request(tmp_path, "latex_read", id=project["id"])
    assert request(tmp_path, "latex_project_get", id=project["id"], include_archived=True)["project"]["archived"] is True
    assert request(tmp_path, "latex_project_list")["projects"] == []
    restored = request(tmp_path, "latex_project_restore", id=project["id"])
    assert restored["restored"] is True and restored["project"]["archived"] is False


def test_update_changes_title_main_and_pdf_pair(tmp_path):
    folder = make_project(tmp_path)
    (folder / "appendix.tex").write_text("\\documentclass{article}\\begin{document}appendix\\end{document}\n", encoding="utf-8")
    with fitz.open() as doc:
        doc.new_page(width=200, height=200)
        doc.save(folder / "appendix.pdf")
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    updated = request(tmp_path, "latex_project_update", id=project["id"], title="改名", main_path="appendix.tex")["project"]
    assert updated["title"] == "改名" and updated["main_path"] == "appendix.tex" and updated["pdf_path"] == "appendix.pdf"
    assert request(tmp_path, "latex_read", id=project["id"])["path"] == "appendix.tex"
    with pytest.raises(ValueError, match="没有需要修改的字段"):
        request(tmp_path, "latex_project_update", id=project["id"])


def test_unknown_actions_and_identifiers_are_refused(tmp_path):
    with pytest.raises(ValueError, match="Unknown LaTeX action"):
        dispatch({"library": str(tmp_path / "library"), "action": "latex_nope"})
    with pytest.raises(ValueError, match="项目标识无效"):
        request(tmp_path, "latex_project_get", id="nope")


@needs_latexmk
def test_compile_builds_a_pdf_that_the_reader_can_page_through(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    built = request(tmp_path, "latex_compile", id=project["id"])
    assert built["ok"] is True, built["log_tail"][-2000:]
    assert built["pdf_path"] == "main.pdf" and built["pages"] == 1
    assert built["engine"] == "xelatex" and built["exit_code"] == 0
    assert built["errors"] == [] and built["timed_out"] is False
    assert (folder / "main.pdf").is_file()
    assert request(tmp_path, "latex_project_get", id=project["id"])["project"]["pdf_present"] is True

    layout = request(tmp_path, "latex_pdf_pages", id=project["id"])
    assert layout["page_count"] == 1 and layout["pages"][0]["width"] > 100
    rendered = request(tmp_path, "latex_pdf_page", id=project["id"], page=1, scale=1)
    assert rendered["page"] == 1 and len(rendered["image"]) > 500
    with pytest.raises(ValueError, match="渲染比例"):
        request(tmp_path, "latex_pdf_page", id=project["id"], page=1, scale=0)

    cleaned = request(tmp_path, "latex_clean", id=project["id"])
    assert "main.pdf" not in cleaned["removed"] and "main.tex" not in cleaned["removed"]
    assert (folder / "main.tex").is_file() and (folder / "main.pdf").is_file()
    assert cleaned["removed_count"] >= 1


@needs_latexmk
def test_a_broken_document_reports_its_errors_instead_of_pretending(tmp_path):
    folder = make_project(tmp_path, body="\\documentclass{article}\n\\begin{document}\n\\thisIsNotACommand\n\\end{document}\n")
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    built = request(tmp_path, "latex_compile", id=project["id"], timeout_seconds=60)
    assert built["ok"] is False and built["exit_code"] not in (0, None)
    assert built["errors"] and any("thisIsNotACommand" in line or "Undefined control sequence" in line for line in built["errors"])
    assert built["pdf_path"] is None
    assert built["log_characters"] > 0 and built["log_tail"]


@needs_latexmk
def test_compiling_reports_a_missing_engine_or_bad_timeout(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    with pytest.raises(ValueError, match="引擎必须是"):
        request(tmp_path, "latex_compile", id=project["id"], engine="tectonic")
    with pytest.raises(ValueError, match="超时必须在"):
        request(tmp_path, "latex_compile", id=project["id"], timeout_seconds=1)
