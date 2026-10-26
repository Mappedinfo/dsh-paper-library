"""Synthetic manuscripts only: placeholder semantics, scope and read-only checks."""
import json
import shutil
from pathlib import Path

import pytest

from dsh_paper_library import latex_lint
from dsh_paper_library.core import dispatch


def project(tmp_path, body="AI methods are discussed.\n", extra=None):
    root = tmp_path / "manuscript"
    root.mkdir()
    for name, text in {"main.tex": body, **(extra or {})}.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    library = str(tmp_path / "library")
    registered = dispatch(dict(library=library, action="latex_project_create", root=str(root)))["project"]

    def call(**kwargs):
        return dispatch(dict(library=library, action="latex_lint", id=registered["id"], **kwargs))

    return root, registered, call


@pytest.mark.parametrize(("text", "category", "marker", "column"), [
    ("todo: finish", "todo", "todo", 1),
    ("  ToDo", "todo", "ToDo", 3),
    (r"\todo{finish}", "todo_command", r"\todo", 1),
    (r"\TODO[inline]{finish}", "todo_command", r"\TODO", 1),
    ("结果xxxx待补", "xxxx", "xxxx", 3),
    ("(XXXXX)", "xxxx", "XXXXX", 2),
    ("% TODO finish", "todo", "TODO", 3),
    (r"Text \% xxxx", "xxxx", "xxxx", 9),
])
def test_markers_have_one_based_unicode_positions(tmp_path, text, category, marker, column):
    _, _, call = project(tmp_path, "First line\n" + text + "\n")
    result = call()
    assert result["schema"] == "paper-library-latex-lint.v1"
    assert result["ok"] and result["status"] == "warnings"
    assert not result["submission_ready"]
    assert result["counts"][category] == 1
    assert result["counts"]["warn"] == 1
    assert result["counts"]["submission_blocker"] == 0
    finding = result["findings"][0]
    assert (finding["path"], finding["line"], finding["column"]) == ("main.tex", 2, column)
    assert finding["marker"] == marker and finding["category"] == category
    assert finding["context"] == text
    submitted = call(mode="submission")
    assert not submitted["ok"] and submitted["status"] == "failed"
    assert submitted["counts"]["submission_blocker"] == 1 and submitted["counts"]["warn"] == 0


def test_word_boundaries_normal_ai_and_literal_examples(tmp_path):
    body = r"""AI and artificial intelligence; methodology; todos; mytodo; todo_list; abcxxxx; xxxx_value; xxxxxY.
\usepackage{todonotes}
\newcommand{\todo}[1]{#1}
\def\TODO#1{#1}
\verb|todo xxxx| \verb*+TODO XXXX+
\verb%todo xxxx% \lstinline%todo% \mintinline{tex}%xxxx%
\lstinline[language=TeX]!todo xxxx! \mintinline{tex}{\todo{xxxx}}
\detokenize{todo xxxx} \url{https://example.org/todo/xxxx}
\href{https://example.org/todo}{AI result}
\begin{verbatim}
todo xxxx \input{outside}
\end{verbatim}
\begin{lstlisting}[language=TeX]
\todo{xxxx}
\end{lstlisting}
\begin{minted}{tex}
todo xxxx
\end{minted}
\begin{comment} todo xxxx \end{comment}
"""
    _, _, call = project(tmp_path, body)
    result = call(mode="submission")
    assert result["ok"] and result["submission_ready"] and result["complete"]
    assert result["counts"]["findings"] == 0


def test_comments_macro_bodies_and_visible_href_text_are_checked(tmp_path):
    _, _, call = project(tmp_path, r"""% todo xxxx
\newcommand{\unfinished}{xxxx}
\href{https://example.org}{todo}
\input % TODO resolve wording
 {sections/intro}
""", {"sections/intro.tex": "AI result.\n"})
    result = call()
    assert result["counts"]["markers"] == 5
    assert result["counts"]["scope"] == 0
    assert [f["line"] for f in result["findings"]] == [1, 1, 2, 3, 4]


@pytest.mark.parametrize("definition", [
    r"\newcommand{\todo}[1]{\textcolor{red}{\texttt{todo:} #1}}",
    r"\renewcommand*{\TODO}[1][default]{TODO: #1}",
    r"\providecommand\todo[1]{TODO: #1}",
    r"\DeclareRobustCommand{\todo}[1]{todo: #1}",
    r"\def\todo#1{TODO: #1}",
])
def test_placeholder_renderer_labels_are_not_unfinished_uses(tmp_path, definition):
    _, _, call = project(tmp_path, definition + "\n")
    assert call(mode="submission")["ok"]


def test_actual_calls_macro_body_placeholders_and_comments_are_never_hidden(tmp_path):
    _, _, call = project(tmp_path, r"""\newcommand{\todo}[1]{\texttt{todo:} #1 % TODO check renderer
xxxx}
\newcommand{\deferred}{\todo{pending}}
\todo{complete this}
\TODO{also pending}
""")
    result = call(mode="submission")
    assert not result["ok"] and result["complete"]
    assert result["counts"]["todo"] == 1
    assert result["counts"]["todo_command"] == 3
    assert result["counts"]["xxxx"] == 1


def test_line_ignores_are_explicit_local_and_do_not_hide_dependencies(tmp_path):
    _, _, call = project(tmp_path, r"""\texttt{todo xxxx} % latex-lint: ignore-line -- literal convention
% latex-lint: ignore-next-line -- example sentence
We call the marker todo or xxxx.
% TODO still recorded
\input{absent} % latex-lint: ignore-line
""")
    result = call()
    assert result["counts"]["todo"] == 1
    assert not result["complete"] and result["counts"]["scope"] == 1
    assert result["findings"][-1]["category"] == "file_unreadable"


def test_follow_graph_shared_bib_nested_cycles_and_dual_entries(tmp_path):
    root, registered, call = project(tmp_path, r"\input{draft}" + "\n", {
        "draft.tex": "Draft todo\n\\input{sections/intro}\n\\bibliography{refs}\n",
        "formal.tex": "Formal xxxx\n\\include{sections/intro}\n\\addbibresource[location=local]{refs.bib}\n",
        "sections/intro.tex": "AI text.\\input{sections/method}\n",
        "sections/method.tex": "\\input{sections/intro}\n",
        "refs.bib": "@article{synthetic,title={xxxx},author={Example, A.}}\n",
        "media/formal/figure.txt": "Unused xxxx\n",
        "notes.txt": "Unused todo\n",
        "README.md": "todo xxxx (outside default graph)\n",
    })
    before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    first = call()
    assert first["counts"]["markers"] == 2
    assert [f["path"] for f in first["files"]] == ["main.tex", "draft.tex", "sections/intro.tex", "refs.bib", "sections/method.tex"]
    formal = call(main_path="formal.tex", mode="submission")
    assert formal["main_path"] == "formal.tex" and formal["counts"]["xxxx"] == 2
    assert "draft.tex" not in {f["path"] for f in formal["files"]}
    selected = call(main_path="formal.tex", paths=["notes.txt", "notes.txt"])
    assert selected["counts"]["todo"] == 1
    assert len(selected["files"]) == 5
    assert before == {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    current = dispatch(dict(library=str(tmp_path / "library"), action="latex_project_get", id=registered["id"]))
    assert current["project"]["main_path"] == "main.tex"
    history = dispatch(dict(library=str(tmp_path / "library"), action="latex_history", id=registered["id"]))
    assert history["revisions"] == []


def test_explicit_markdown_notes_ignore_fenced_and_inline_code(tmp_path):
    _, _, call = project(tmp_path, extra={"notes.md": "AI, `todo xxxx`, and ``a ` todo``.\n```tex\n\\todo{xxxx}\n```\n~~~\nTODO\n~~~\nFinish: todo\n"})
    result = call(paths=["notes.md"], mode="submission")
    assert result["counts"]["markers"] == 1 and result["findings"][0]["line"] == 8


def test_unsafe_paths_never_read_or_echo_external_targets(tmp_path):
    root, _, call = project(tmp_path)
    outside = tmp_path / "private.tex"
    outside.write_text("SECRET todo xxxx", encoding="utf-8")
    (root / "linked.tex").symlink_to(outside)
    (root / "main.tex").write_text("\\input{../private}\n\\include{" + str(outside) + "}\n\\input{linked}\n", encoding="utf-8")
    result = call(mode="submission")
    assert result["status"] == "incomplete" and not result["ok"]
    assert result["counts"]["scope"] == 3
    assert {f["category"] for f in result["findings"]} == {"dependency_unsafe"}
    assert len(result["files"]) == 1
    serialized = json.dumps(result)
    assert str(tmp_path) not in serialized and "SECRET" not in serialized
    for path in ("../private.tex", str(outside), "linked.tex"):
        with pytest.raises(ValueError):
            call(paths=[path])
        with pytest.raises(ValueError):
            call(main_path=path)


@pytest.mark.parametrize("body,category", [
    (r"\input{\sectionfile}", "dependency_unresolved"),
    (r"\include{missing}", "file_unreadable"),
    (r"\input{unfinished", "syntax_unclosed"),
    ("\\begin{verbatim}\ntodo", "literal_unclosed"),
    (r"\verb|todo", "literal_unclosed"),
])
def test_incomplete_scope_cannot_pass_submission(tmp_path, body, category):
    _, _, call = project(tmp_path, body)
    result = call(mode="submission")
    assert not result["ok"] and not result["complete"] and not result["submission_ready"]
    assert result["status"] == "incomplete"
    assert category in {f["category"] for f in result["findings"]}


def test_bare_multiline_commented_and_duplicate_inputs(tmp_path):
    _, _, call = project(tmp_path, "\\input intro\n\\include\n{intro}\n% \\input{missing}\n\\input{in% comment\n tro}\n", {"intro.tex": "todo\n"})
    result = call()
    assert result["complete"] and len(result["files"]) == 2 and result["counts"]["todo"] == 1


def test_bound_report_counts_and_context_without_truncating_the_scan(tmp_path):
    _, _, call = project(tmp_path, " " * 500 + "todo " * 30 + "\n")
    # Bound the report while still counting all markers and locating later ones.
    original = latex_lint.MAX_FINDINGS
    try:
        latex_lint.MAX_FINDINGS = 3
        result = call(mode="submission")
    finally:
        latex_lint.MAX_FINDINGS = original
    assert result["truncated"] and result["complete"] and not result["ok"]
    assert result["counts"]["markers"] == 30 and len(result["findings"]) == 3
    assert all(len(f["context"]) <= 200 for f in result["findings"])


@pytest.mark.parametrize(("limit", "value", "category"), [
    ("MAX_FILES", 1, "file_limit"), ("MAX_DEPTH", 0, "depth_limit"),
    ("MAX_BYTES", 35, "byte_limit"), ("MAX_REFERENCES", 1, "reference_limit"),
])
def test_coverage_budgets_are_visible(tmp_path, monkeypatch, limit, value, category):
    _, _, call = project(tmp_path, "\\input{sections/part}\n\\input{sections/part}\n", {"sections/part.tex": "AI evidence.\n" * 20})
    monkeypatch.setattr(latex_lint, limit, value)
    result = call(mode="submission")
    assert not result["complete"] and not result["ok"]
    assert category in {f["category"] for f in result["findings"]}


def test_bad_encoding_and_oversize_files_are_reported(tmp_path):
    root, _, call = project(tmp_path)
    (root / "main.tex").write_bytes(b"\xfftodo")
    assert call()["findings"][0]["category"] == "encoding"
    (root / "main.tex").write_bytes(b"x" * (1024 * 1024 + 1))
    assert call()["findings"][0]["category"] == "byte_limit"


def test_paths_in_marker_context_are_redacted(tmp_path):
    _, _, call = project(tmp_path, "\\input{/synthetic/private/file} % TODO\n% xxxx /synthetic/private/notes\n")
    result = call()
    assert result["counts"]["markers"] == 2
    assert "/synthetic/private" not in json.dumps(result)


def test_crlf_revision_matches_the_editor_read(tmp_path):
    root, registered, call = project(tmp_path)
    (root / "main.tex").write_bytes(b"AI\r\nTodo\r\n")
    result = call()
    read = dispatch(dict(library=str(tmp_path / "library"), action="latex_read", id=registered["id"]))
    assert result["files"][0]["revision"] == read["revision"]
    assert result["findings"][0]["line"] == 2


@pytest.mark.skipif(not (shutil.which("latexmk") or Path("/Library/TeX/texbin/latexmk").is_file()), reason="local latexmk required")
def test_lint_failure_does_not_block_saving_or_compiling(tmp_path):
    root, registered, call = project(tmp_path, "\\documentclass{article}\n\\begin{document}\ntodo xxxx\n\\end{document}\n")
    assert not call(mode="submission")["ok"]
    args = dict(library=str(tmp_path / "library"), id=registered["id"])
    read = dispatch(dict(args, action="latex_read"))
    saved = dispatch(dict(args, action="latex_write", path="main.tex", content=read["content"] + "% todo\n", expected_revision=read["revision"]))
    assert saved["changed"]
    compiled = dispatch(dict(args, action="latex_compile"))
    assert compiled["ok"], compiled["log_tail"]
    assert (root / "main.pdf").is_file()


@pytest.mark.parametrize("kwargs", [
    {"mode": "formal"}, {"mode": None}, {"paths": "main.tex"}, {"paths": [None]},
    {"paths": ["main.tex"] * 101}, {"paths": ["asset.png"]}, {"main_path": "notes.txt"},
])
def test_invalid_requests_fail_validation(tmp_path, kwargs):
    _, _, call = project(tmp_path)
    with pytest.raises(ValueError):
        call(**kwargs)
