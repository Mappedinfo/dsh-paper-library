"""对话只读检索只使用临时合成项目，不访问研究目录或模型。"""
import hashlib
import os

import pymupdf as fitz
import pytest

from dsh_paper_library.core import dispatch
from dsh_paper_library import latex_retrieval


pytestmark = pytest.mark.skipif(not latex_retrieval.CAN_OPEN_WITHOUT_LINKS, reason="requires no-follow directory descriptors")


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "manuscript"
    (root / "chapters").mkdir(parents=True)
    (root / "references").mkdir()
    (root / "main.tex").write_text("\\documentclass{article}\n\\input{chapters/evidence}\n", encoding="utf-8")
    (root / "chapters/evidence.tex").write_bytes("第一行\r\nUnique evidence appears here.\r\nLiteral [a-z]+ is not a regex.\r\n".encode())
    (root / "refs.bib").write_text("@article{source, title={Synthetic evidence}}\n", encoding="utf-8")
    with fitz.open() as doc:
        for number in range(1, 5):
            doc.new_page().insert_text((50, 80), f"Synthetic reference page {number}")
        doc.save(root / "references/source.pdf")
    library = tmp_path / "library"
    created = dispatch({"library": str(library), "action": "latex_project_create", "root": str(root)})["project"]

    def call(action, **arguments):
        return dispatch({"library": str(library), "action": action, "id": created["id"],
                         "expected_root": created["root"], "expected_binding_generation": created["binding_generation"], **arguments})

    return root, created, call, library


def test_list_only_shows_safe_readable_candidates_and_paginates(project, tmp_path):
    root, _, call, _ = project
    for path in [".env", "credentials.txt", "secrets/notes.tex", "build/cached.tex", "dist/cached.md", ".latex-build/cache.tex", "settings.cfg", "main.aux"]:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("private material", encoding="utf-8")
    (tmp_path / "outside.tex").write_text("outside", encoding="utf-8")
    os.symlink(tmp_path / "outside.tex", root / "linked.tex")
    os.symlink(tmp_path, root / "linked-directory")
    result = call("latex_retrieval_list", limit=2)
    assert [file["path"] for file in result["files"]] == ["chapters/evidence.tex", "main.tex"]
    assert result["total"] == 4 and result["has_more"] is True and result["truncated"] is False
    remaining = call("latex_retrieval_list", offset=2)["files"]
    assert [file["path"] for file in remaining] == ["references/source.pdf", "refs.bib"]
    assert remaining[0]["kind"] == "pdf"
    assert call("latex_retrieval_list", path="chapters")["total"] == 1
    assert call("latex_retrieval_list", path="chapters/evidence.tex")["total"] == 1
    assert str(root) not in str(result)


def test_source_line_read_has_the_same_revision_as_saved_source(project):
    _, _, call, _ = project
    result = call("latex_retrieval_read", path="chapters/evidence.tex", start_line=2, lines=1)
    assert result["content"] == "Unique evidence appears here.\n"
    assert result["start_line"] == result["end_line"] == 2
    assert result["total_lines"] == 3 and result["truncated"] is True
    assert result["revision"] == call("latex_read", path="chapters/evidence.tex")["revision"]
    empty = call("latex_retrieval_read", path="chapters/evidence.tex", start_line=10)
    assert empty["content"] == "" and empty["end_line"] is None and empty["truncated"] is False


def test_search_reads_related_files_and_is_literal_case_and_scope_aware(project):
    _, _, call, _ = project
    result = call("latex_search", query="unique EVIDENCE")
    assert len(result["matches"]) == 1 and result["truncated"] is False
    match = result["matches"][0]
    assert match["path"] == "chapters/evidence.tex" and match["line"] == 2
    assert match["revision"] == call("latex_read", path=match["path"])["revision"]
    assert result["scanned_files"] == result["candidate_files"] == 3
    assert call("latex_search", query="unique EVIDENCE", case_sensitive=True)["matches"] == []
    assert call("latex_search", query="[a-z]+")["matches"][0]["line"] == 3
    assert call("latex_search", query="Unique", path="main.tex")["matches"] == []
    assert call("latex_search", query="evidence", glob="*.bib")["matches"][0]["path"] == "refs.bib"


def test_editor_search_returns_exact_offsets_for_repeated_literal_matches(project):
    root, _, call, _ = project
    path = "chapters/repeated.TEX"
    (root / path).write_bytes("第一行😀\r\n🔎 [m-p]+ 和 [M-P]+\r\n".encode())
    (root / "ignored.bib").write_text("[m-p]+", encoding="utf-8")
    (root / "credentials.tex").write_text("[m-p]+", encoding="utf-8")
    saved = call("latex_read", path=path)

    result = call("latex_source_search", query="[m-p]+", paths=[path])
    assert [(hit["path"], hit["line"], hit["column"]) for hit in result["matches"]] == [(path, 2, 3), (path, 2, 12)]
    assert [saved["content"][hit["start"]:hit["end"]] for hit in result["matches"]] == ["[m-p]+", "[M-P]+"]
    assert all(hit["revision"] == saved["revision"] for hit in result["matches"])
    assert result["truncated"] is False


def test_editor_search_bounds_repeated_matches_and_skips_oversized_files(project):
    root, _, call, _ = project
    (root / "00-large.tex").write_bytes(b"x" * (4 * 1024 * 1024 + 1))
    (root / "repeated.tex").write_text("hit " * 25, encoding="utf-8")
    result = call("latex_source_search", query="hit", paths=["00-large.tex", "repeated.tex"])
    assert [hit["column"] for hit in result["matches"]] == list(range(1, 81, 4))
    assert result["truncated"] and result["skipped_files"] == 1


def test_editor_search_uses_chapter_paths_in_display_order_without_scanning_other_files(project, monkeypatch):
    root, _, call, _ = project
    deep = "/".join(["nested"] * 10 + ["text.tex"])
    chapter_paths = ["chapters/z.tex", "revisions/linked-in-manuscript.tex", "chapters/a.tex", deep]
    for path in chapter_paths + ["revisions/old.tex", "chapters/unreferenced.tex"]:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("Synthetic discussion", encoding="utf-8")

    def unexpected_scan(*args, **kwargs):
        pytest.fail("Editor chapter search must not scan the project")

    monkeypatch.setattr(latex_retrieval, "_inventory", unexpected_scan)
    result = call("latex_source_search", query="discussion", paths=[*chapter_paths, chapter_paths[0]])
    assert [hit["path"] for hit in result["matches"]] == chapter_paths
    assert result["candidate_files"] == result["scanned_files"] == len(chapter_paths)
    assert result["truncated"] is False
    assert call("latex_source_search", query="discussion", paths=[])["matches"] == []


@pytest.mark.parametrize("paths", [None, "main.tex", [1], ["chapters"], ["refs.bib"], ["a" * 500 + ".tex"], ["main.tex"] * 101])
def test_editor_search_requires_a_bounded_list_of_tex_paths(project, paths):
    _, _, call, _ = project
    with pytest.raises(ValueError, match="章节文件列表"):
        call("latex_source_search", query="evidence", paths=paths)


def test_editor_search_reports_unavailable_paths_and_keeps_other_chapters(project, tmp_path):
    root, _, call, _ = project
    outside = tmp_path / "outside.tex"
    outside.write_text("Unique outside", encoding="utf-8")
    (root / "linked.tex").symlink_to(outside)
    (root / "credentials.tex").write_text("Unique hidden", encoding="utf-8")
    (root / "directory.tex").mkdir()
    paths = ["../outside.tex", str(outside), "linked.tex", "credentials.tex", "directory.tex", "missing.tex"]
    result = call("latex_source_search", query="Unique", paths=[*paths, "chapters/evidence.tex"])
    assert [hit["path"] for hit in result["matches"]] == ["chapters/evidence.tex"]
    assert result["truncated"] is True and result["skipped_files"] == len(paths)


def test_read_and_search_report_character_match_and_scan_budgets(project, monkeypatch):
    root, _, call, _ = project
    (root / "long.tex").write_text("x" * 15000, encoding="utf-8")
    result = call("latex_retrieval_read", path="long.tex")
    assert len(result["content"]) == 12000 and result["truncated"] is True
    (root / "matches.tex").write_text("match\n" * 25, encoding="utf-8")
    result = call("latex_search", query="match", limit=2)
    assert len(result["matches"]) == 2 and result["truncated"] is True
    monkeypatch.setattr(latex_retrieval, "MAX_ENTRIES", 2)
    listed = call("latex_retrieval_list")
    assert listed["scanned_entries"] == 2 and listed["truncated"] is True
    assert listed["total"] is None and listed["has_more"] is True
    searched = call("latex_search", query="absent")
    assert searched["truncated"] is True


def test_binary_oversize_and_total_byte_budget_are_explicitly_incomplete(project, monkeypatch):
    root, _, call, _ = project
    (root / "binary.tex").write_bytes(b"content\0data")
    (root / "huge.tex").write_bytes(b"x" * (1024 * 1024 + 1))
    for path in ["binary.tex", "huge.tex"]:
        with pytest.raises(ValueError):
            call("latex_retrieval_read", path=path)
    result = call("latex_search", query="absent")
    assert result["truncated"] is True and result["skipped_files"] == 2
    monkeypatch.setattr(latex_retrieval, "MAX_SEARCH_BYTES", 1)
    result = call("latex_search", query="absent")
    assert result["truncated"] is True and result["scanned_files"] == 0 and result["scanned_bytes"] == 0


@pytest.mark.parametrize("action,arguments", [
    ("latex_retrieval_list", {}), ("latex_search", {"query": "evidence"}),
    ("latex_source_search", {"query": "evidence", "paths": ["chapters/evidence.tex"]}),
    ("latex_retrieval_read", {"path": "main.tex"}), ("latex_pdf_text", {"path": "references/source.pdf"}),
])
def test_all_retrieval_actions_require_current_root_and_generation(project, action, arguments):
    _, created, call, library = project
    base = {"library": str(library), "action": action, "id": created["id"], **arguments}
    for binding in [{}, {"expected_root": created["root"]}, {"expected_binding_generation": 0},
                    {"expected_root": created["root"], "expected_binding_generation": True},
                    {"expected_root": created["root"], "expected_binding_generation": 99},
                    {"expected_root": "/wrong/root", "expected_binding_generation": 0}]:
        with pytest.raises(ValueError):
            dispatch({**base, **binding})
    call(action, **arguments)


def test_rebound_project_rejects_a_request_from_the_old_binding(project, tmp_path):
    _, created, call, library = project
    new_root = tmp_path / "replacement"
    new_root.mkdir()
    (new_root / "main.tex").write_text("\\documentclass{article}\nNew binding\n", encoding="utf-8")
    updated = call("latex_project_update", root=str(new_root), main_path="main.tex")["project"]
    assert updated["binding_generation"] > created["binding_generation"]
    with pytest.raises(ValueError, match="项目文件夹已变化"):
        call("latex_retrieval_read", path="main.tex")
    result = dispatch({"library": str(library), "action": "latex_retrieval_read", "id": updated["id"],
                       "expected_root": updated["root"], "expected_binding_generation": updated["binding_generation"], "path": "main.tex"})
    assert "New binding" in result["content"]


@pytest.mark.parametrize("path", ["../outside.tex", "/etc/hosts", "chapters/../../outside.tex", "credentials.txt", ".env", "secrets/data.tex", "settings.cfg"])
def test_text_reads_reject_paths_outside_the_allowed_surface(project, path):
    _, _, call, _ = project
    with pytest.raises(ValueError):
        call("latex_retrieval_read", path=path)


def test_explicit_paths_and_enumeration_never_follow_links_or_fifo(project, tmp_path):
    root, _, call, _ = project
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "private.tex").write_text("never retrieve", encoding="utf-8")
    os.symlink(outside, root / "linked")
    os.symlink(outside / "private.tex", root / "linked.tex")
    os.mkfifo(root / "pipe.tex")
    for action, arguments in [("latex_retrieval_read", {"path": "linked.tex"}), ("latex_search", {"path": "linked", "query": "never"}),
                              ("latex_retrieval_list", {"path": "linked"}), ("latex_retrieval_read", {"path": "pipe.tex"})]:
        with pytest.raises(ValueError):
            call(action, **arguments)
    assert "linked" not in str(call("latex_retrieval_list"))
    assert "pipe.tex" not in str(call("latex_retrieval_list"))


def test_whitespace_cannot_redirect_a_validated_path_to_a_blocked_target(project):
    root, _, call, _ = project
    (root / "credentials.txt").write_text("synthetic credential fixture", encoding="utf-8")
    (root / ".env.tex").write_text("synthetic hidden fixture", encoding="utf-8")
    (root / "linked.tex").symlink_to(root / ".env.tex")
    for path in [" credentials.txt", " .env.tex", "linked.tex "]:
        for action, args in [("latex_retrieval_list", {}), ("latex_retrieval_read", {}), ("latex_search", {"query": "synthetic"})]:
            with pytest.raises(ValueError):
                call(action, path=path, **args)


def test_registering_a_project_below_a_system_path_alias_uses_the_canonical_root(project, tmp_path):
    _, _, _, library = project
    actual_parent = tmp_path / "actual-parent"
    root = actual_parent / "other-manuscript"
    root.mkdir(parents=True)
    (root / "main.tex").write_text("\\documentclass{article}\nSynthetic\n", encoding="utf-8")
    alias = tmp_path / "visible-parent"
    alias.symlink_to(actual_parent, target_is_directory=True)
    created = dispatch({"library": str(library), "action": "latex_project_create", "root": str(alias / root.name)})["project"]
    assert created["root"] == str(root.resolve())
    result = dispatch({"library": str(library), "action": "latex_retrieval_read", "id": created["id"], "path": "main.tex",
                       "expected_root": created["root"], "expected_binding_generation": created["binding_generation"]})
    assert "Synthetic" in result["content"]


def test_file_descriptor_rejects_a_directory_swapped_after_path_validation(project, tmp_path, monkeypatch):
    root, _, call, _ = project
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "evidence.tex").write_text("never retrieve", encoding="utf-8")
    original = latex_retrieval._relative

    def swap(*args, **kwargs):
        validated = original(*args, **kwargs)
        (root / "chapters").rename(root / "old-chapters")
        (root / "chapters").symlink_to(outside, target_is_directory=True)
        return validated

    monkeypatch.setattr(latex_retrieval, "_relative", swap)
    with pytest.raises(ValueError, match="无法读取"):
        call("latex_retrieval_read", path="chapters/evidence.tex")


def test_reference_pdf_pages_are_bounded_versioned_and_do_not_change_original(project):
    root, _, call, _ = project
    path = root / "references/source.pdf"
    original = path.read_bytes()
    result = call("latex_pdf_text", path="references/source.pdf", page=2, pages=3)
    assert result["path"] == "references/source.pdf" and result["kind"] == "project_pdf"
    assert result["page_count"] == 4 and result["pdf_version"] == hashlib.sha256(original).hexdigest()
    assert [page["page"] for page in result["pages"]] == [2, 3, 4]
    assert all(f"Synthetic reference page {page['page']}" in page["text"] for page in result["pages"])
    assert result["truncated"] is False and path.read_bytes() == original
    for arguments in [{"pages": 4}, {"page": 5}, {"page": 0}, {"pages": True}, {"path": "main.tex"}]:
        with pytest.raises(ValueError):
            call("latex_pdf_text", **{"path": "references/source.pdf", **arguments})


def test_pdf_character_budget_is_reported_per_page_and_in_total(project):
    root, _, call, _ = project
    with fitz.open() as doc:
        for _ in range(3):
            page = doc.new_page()
            for line in range(60):
                page.insert_text((20, 20 + line * 12), "Repeated evidence " * 10, fontsize=4)
        doc.save(root / "references/large.pdf")
    result = call("latex_pdf_text", path="references/large.pdf", pages=3)
    assert result["truncated"] is True and all(page["truncated"] for page in result["pages"])
    assert all(len(page["text"]) <= 8000 for page in result["pages"])
    assert sum(len(page["text"]) for page in result["pages"]) == 18000


@pytest.mark.parametrize("arguments", [{"query": ""}, {"query": "x\ny"}, {"query": "x", "limit": 21},
                                       {"query": "x", "glob": "../*.tex"}, {"query": "x", "case_sensitive": 1}])
def test_invalid_search_arguments_are_not_silently_coerced(project, arguments):
    _, _, call, _ = project
    with pytest.raises(ValueError):
        call("latex_search", **arguments)
