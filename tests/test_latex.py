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
HAS_SYNCTEX = bool(shutil.which("synctex") or Path("/Library/TeX/texbin/synctex").is_file())
needs_synctex = pytest.mark.skipif(not (HAS_LATEXMK and HAS_SYNCTEX), reason="latexmk and synctex are required for the jump checks")

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
        request(tmp_path, "latex_project_update", id=project["id"], expected_binding_generation=updated["binding_generation"])


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


@needs_synctex
def test_nested_main_compiles_from_its_directory_and_synctex_resolves_shared_source(tmp_path):
    folder = tmp_path / "manuscript"
    (folder / "review").mkdir(parents=True)
    (folder / "shared").mkdir()
    # A same-named file at the project root must not be compiled by accident.
    (folder / "main.tex").write_text("wrong main file\n", encoding="utf-8")
    (folder / "review" / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\n\\input{../shared/body.tex}\n\\end{document}\n",
        encoding="utf-8",
    )
    (folder / "shared" / "body.tex").write_text("Shared synthetic source sentence.\n", encoding="utf-8")
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    project = request(tmp_path, "latex_project_update", id=project["id"], main_path="review/main.tex", expected_binding_generation=project["binding_generation"])["project"]
    binding = {"expected_root": project["root"], "expected_binding_generation": project["binding_generation"]}

    with pytest.raises(ValueError, match="项目绑定已变化"):
        request(tmp_path, "latex_compile", id=project["id"], engine="xelatex", expected_binding_generation=0)
    built = request(tmp_path, "latex_compile", id=project["id"], engine="xelatex", **binding)
    assert built["ok"], built["log_tail"][-2000:]
    assert built["pdf_path"] == "review/main.pdf"
    with fitz.open(folder / "review" / "main.pdf") as pdf:
        assert "Shared synthetic source sentence" in pdf[0].get_text()
    layout = request(tmp_path, "latex_pdf_pages", id=project["id"])
    assert layout["build"]["verified"]
    forward = request(tmp_path, "latex_synctex_view", id=project["id"], path="shared/body.tex", line=1)
    back = request(tmp_path, "latex_synctex_edit", id=project["id"], page=forward["page"], x=forward["x"], y=forward["y"])
    assert back["path"] == "shared/body.tex" and back["line"] == 1
    (folder / "shared" / "body.tex").write_text("Changed shared synthetic source.\n", encoding="utf-8")
    assert not request(tmp_path, "latex_pdf_pages", id=project["id"])["build"]["verified"]


@needs_latexmk
def test_a_broken_document_reports_its_errors_instead_of_pretending(tmp_path):
    folder = make_project(tmp_path, body="\\documentclass{article}\n\\begin{document}\n\\thisIsNotACommand\n\\end{document}\n")
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    built = request(tmp_path, "latex_compile", id=project["id"], timeout_seconds=60)
    assert built["ok"] is False and built["exit_code"] not in (0, None)
    assert built["errors"] and any("thisIsNotACommand" in line or "Undefined control sequence" in line for line in built["errors"])
    assert built["pdf_path"] is None
    assert built["log_characters"] > 0 and built["log_tail"]


def test_synctex_without_data_is_a_clear_error(tmp_path):
    folder = make_project(tmp_path, with_pdf=True)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    with pytest.raises(ValueError, match="没有 SyncTeX 数据"):
        request(tmp_path, "latex_synctex_edit", id=project["id"], page=1, x=100, y=100)
    with pytest.raises(ValueError, match="没有 SyncTeX 数据"):
        request(tmp_path, "latex_synctex_view", id=project["id"], path="main.tex", line=2)


def test_project_rebind_supports_nested_absolute_main_and_isolates_histories(tmp_path):
    parent = tmp_path / "workspace"
    root = parent / "review"
    root.mkdir(parents=True)
    main = root / "main.tex"
    main.write_text("Original source.\n", encoding="utf-8")
    project = request(tmp_path, "latex_project_create", root=str(root), main_path=str(main))["project"]
    identity = project["id"]
    current = request(tmp_path, "latex_read", id=identity)
    request(tmp_path, "latex_write", id=identity, path="main.tex", content="Changed source.\n", expected_revision=current["revision"])
    note_read = request(tmp_path, "latex_read", id=identity)
    anchor = {"kind": "source", "path": "main.tex", "revision": note_read["revision"], "start": 0, "end": 7, "text": "Changed"}
    request(tmp_path, "latex_review_put", id=identity, anchor=anchor, comment="old review")
    changed = request(tmp_path, "latex_project_update", id=identity, root=str(parent), main_path=str(main))["project"]
    assert changed["id"] == identity and changed["main_path"] == "review/main.tex"
    assert request(tmp_path, "latex_history", id=identity, path="review/main.tex")["revisions"]
    notes = request(tmp_path, "latex_review_list", id=identity)["annotations"]
    assert len(notes) == 1 and notes[0]["anchor"]["path"] == "review/main.tex" and not notes[0]["stale"]
    other = tmp_path / "other"
    other.mkdir()
    (other / "main.tex").write_text("Changed source.\n", encoding="utf-8")
    switched = request(tmp_path, "latex_project_update", id=identity, root=str(other), main_path="main.tex", expected_binding_generation=changed["binding_generation"])["project"]
    assert switched["root"] == str(other)
    assert not request(tmp_path, "latex_history", id=identity, path="main.tex")["revisions"]
    assert not request(tmp_path, "latex_review_list", id=identity)["annotations"]
    request(tmp_path, "latex_project_update", id=identity, root=str(root), main_path="main.tex", expected_binding_generation=switched["binding_generation"])
    assert request(tmp_path, "latex_review_list", id=identity)["annotations"][0]["comment"] == "old review"
    assert request(tmp_path, "latex_history", id=identity, path="main.tex")["revisions"]
    assert main.read_text(encoding="utf-8") == "Changed source.\n"


def test_project_rebind_rejects_invalid_main_and_duplicate_root(tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir(); second.mkdir()
    (first / "main.tex").write_text("First", encoding="utf-8")
    (second / "main.tex").write_text("Second", encoding="utf-8")
    one = request(tmp_path, "latex_project_create", root=str(first))["project"]
    request(tmp_path, "latex_project_create", root=str(second))
    with pytest.raises(ValueError, match="已经是"):
        request(tmp_path, "latex_project_update", id=one["id"], root=str(second), main_path="main.tex")
    with pytest.raises(ValueError, match="超出项目"):
        request(tmp_path, "latex_project_update", id=one["id"], root=str(tmp_path), main_path=str(tmp_path.parent / "outside.tex"))
    assert request(tmp_path, "latex_project_get", id=one["id"])["project"]["root"] == str(first)


def test_project_rebind_preserves_native_pdf_review_for_the_same_main(tmp_path):
    parent = tmp_path / "workspace"
    root = parent / "review"
    root.mkdir(parents=True)
    (root / "main.tex").write_text("Synthetic source.\n", encoding="utf-8")
    with fitz.open() as document:
        document.new_page().insert_text((50, 50), "Synthetic page")
        document.save(root / "main.pdf")
    identity = request(tmp_path, "latex_project_create", root=str(root))["project"]["id"]
    layout = request(tmp_path, "latex_pdf_pages", id=identity)
    word = request(tmp_path, "latex_pdf_page", id=identity, page=1)["words"][0]
    request(tmp_path, "latex_review_put", id=identity, type="highlight", comment="PDF note",
            anchor={"kind": "pdf", "pdf_version": layout["build"]["pdf_version"], "page": 1, "rects": [word[:4]], "text": word[4]})
    rebound = request(tmp_path, "latex_project_update", id=identity, root=str(parent), main_path="review/main.tex")["project"]
    note = request(tmp_path, "latex_review_list", id=identity)["annotations"][0]
    assert note["comment"] == "PDF note" and note["stale"]
    output = request(tmp_path, "latex_review_export", id=identity, format="pdf", expected_binding_generation=rebound["binding_generation"])
    with fitz.open(output["path"]) as exported:
        assert [annot.info["content"] for annot in exported[0].annots()] == ["PDF note"]


@needs_synctex
def test_synctex_round_trip_between_pdf_and_source(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    built = request(tmp_path, "latex_compile", id=project["id"], timeout_seconds=120)
    assert built["ok"]
    forward = request(tmp_path, "latex_synctex_view", id=project["id"], path="main.tex", line=5)
    assert forward["page"] == 1 and forward["rotation"] == 0
    assert 0 < forward["y"] < 800 and 0 < forward["x"] < 620
    assert forward["h"] is not None and forward["v"] is not None
    back = request(tmp_path, "latex_synctex_edit", id=project["id"], page=forward["page"], x=forward["x"], y=forward["y"])
    assert back["path"] == "main.tex"
    assert abs(back["line"] - 5) <= 2
    # synctex snaps an empty-margin click to the nearest source line instead of failing
    margin = request(tmp_path, "latex_synctex_edit", id=project["id"], page=1, x=30, y=30)
    assert margin["path"] == "main.tex" and margin["line"] >= 1


@needs_synctex
def test_synctex_guards_paths_and_numbers(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    assert request(tmp_path, "latex_compile", id=project["id"], timeout_seconds=120)["ok"]
    with pytest.raises(ValueError, match="超出项目目录"):
        request(tmp_path, "latex_synctex_view", id=project["id"], path="../main.tex", line=1)
    with pytest.raises(ValueError, match="源文件不存在"):
        request(tmp_path, "latex_synctex_view", id=project["id"], path="nope.tex", line=1)
    with pytest.raises(ValueError, match="行号必须是正整数"):
        request(tmp_path, "latex_synctex_view", id=project["id"], path="main.tex", line=0)
    with pytest.raises(ValueError, match="列号必须是非负整数"):
        request(tmp_path, "latex_synctex_view", id=project["id"], path="main.tex", line=1, column=-2)
    with pytest.raises(ValueError, match="坐标超出这一页"):
        request(tmp_path, "latex_synctex_edit", id=project["id"], page=1, x=-5, y=100)
    with pytest.raises(ValueError, match="必须是数字"):
        request(tmp_path, "latex_synctex_edit", id=project["id"], page=1, x="soon", y=100)


@needs_latexmk
def test_compiling_reports_a_missing_engine_or_bad_timeout(tmp_path):
    folder = make_project(tmp_path)
    project = request(tmp_path, "latex_project_create", root=str(folder))["project"]
    with pytest.raises(ValueError, match="引擎必须是"):
        request(tmp_path, "latex_compile", id=project["id"], engine="tectonic")
    with pytest.raises(ValueError, match="超时必须在"):
        request(tmp_path, "latex_compile", id=project["id"], timeout_seconds=1)
