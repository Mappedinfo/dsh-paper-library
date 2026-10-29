"""Synthetic, read-only formula inventories; no TeX execution or model calls."""
import hashlib

import pytest

from dsh_paper_library import latex_formulas
from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.latex import create


def fixture(tmp_path, files):
    root = tmp_path / "synthetic"
    root.mkdir()
    for path, body in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
    library = Library(str(tmp_path / "library"))
    project = create(library, root=str(root))["project"]
    return root, library, project["id"]


def check(tmp_path, files):
    root, library, project_id = fixture(tmp_path, files)
    try:
        before = {file.relative_to(root): hashlib.sha256(file.read_bytes()).hexdigest() for file in root.rglob("*") if file.is_file()}
        result = latex_formulas.latex_formula_check(library, project_id)
        assert before == {file.relative_to(root): hashlib.sha256(file.read_bytes()).hexdigest() for file in root.rglob("*") if file.is_file()}
        assert result["semantic_check"] is False
        return result
    finally:
        library.close()


def test_extracts_multifile_inline_display_and_ams_math_with_unicode_lines(tmp_path):
    result = check(tmp_path, {
        "main.tex": "\\documentclass{article}\n中文 $x+1$，以及 \\(y\\)。\n\\[z^2\\]\n$$a=b$$\n\\input{parts/formulas}\n",
        "parts/formulas.tex": "First\n\\begin{align}\na &= b \\\\\n c &= d \\label{eq:shared}\n\\end{align}\nSee \\eqref{eq:shared}.\n",
    })
    assert result["summary"] == dict(formulas=5, errors=0, warnings=0, issues=0)
    assert result["files_checked"] == 2
    assert result["formulas"][0]["line"] == 2
    assert result["formulas"][-1]["labels"] == ["eq:shared"]
    assert result["formulas"][-1]["end_line"] == 5
    assert result["complete"]


def test_ignores_comments_escaped_dollars_literals_and_urls(tmp_path):
    result = check(tmp_path, {"main.tex": r"""\documentclass{article}
% $fake$ \eqref{missing}
\$5 is a price. \% actual $real$.
\verb|$fake$ \eqref{missing}|
\verb%$fake$%
\begin{verbatim}
$fake$ \label{nope}
\end{verbatim}
\begin{minted}{python}
$fake$
\end{minted}
\lstinline[language=TeX]{$fake$}
\mintinline{latex}|$fake$|
\url{https://example.test/$fake$}
\\label{escaped}
"""})
    assert result["summary"]["formulas"] == 1
    assert result["formulas"][0]["source"] == "$real$"
    assert result["summary"]["issues"] == 0


@pytest.mark.parametrize(("body", "code"), [
    (r"$x", "math_unclosed"), (r"\[x\)", "math_delimiter_mismatch"),
    (r"\]", "math_unmatched_close"), (r"$x_{1$", "brace_unclosed"),
    (r"$x}+$", "brace_unmatched"), (r"$\left(x$", "left_right_count"),
    (r"\[\]", "formula_empty"),
])
def test_formula_syntax_problems_have_source_locations(tmp_path, body, code):
    result = check(tmp_path, {"main.tex": "first\n" + body})
    finding = next(item for item in result["issues"] if item["code"] == code)
    assert finding["path"] == "main.tex" and finding["line"] == 2


def test_labels_cross_files_duplicates_and_dynamic_refs_are_cautions(tmp_path):
    result = check(tmp_path, {"main.tex": r"$x\label{same}$ \eqref{same} \eqref{missing} \eqref{\dynamic}", "other.tex": r"\begin{equation*}y\label{same}\end{equation*}"})
    assert result["summary"]["errors"] == 0
    assert [item["code"] for item in result["issues"]].count("label_duplicate") == 2
    assert [item["code"] for item in result["issues"]].count("eqref_undefined") == 1
    assert [item["code"] for item in result["issues"]].count("label_dynamic") == 1


def test_escaped_braces_and_nested_non_math_ams_environment_are_valid(tmp_path):
    result = check(tmp_path, {"main.tex": r"\[\left\{\begin{aligned}x &= {y} \\ z &= 1\end{aligned}\right.\]"})
    assert result["summary"]["errors"] == 0
    assert result["summary"]["formulas"] == 1


def test_output_and_reading_budgets_are_explicit(tmp_path, monkeypatch):
    monkeypatch.setattr(latex_formulas, "MAX_FORMULAS", 2)
    monkeypatch.setattr(latex_formulas, "MAX_FORMULA_CHARACTERS", 4)
    result = check(tmp_path, {"main.tex": "$longformula$ $b$ $c$"})
    assert result["summary"]["formulas"] == 3
    assert len(result["formulas"]) == 2
    assert result["formulas"][0]["source_truncated"]
    assert result["limited"] and not result["complete"]


def test_symlink_outside_project_is_not_read(tmp_path):
    root, library, project_id = fixture(tmp_path, {"main.tex": "$safe$"})
    outside = tmp_path / "outside.tex"
    outside.write_text("$private$", encoding="utf-8")
    (root / "outside.tex").symlink_to(outside)
    try:
        result = latex_formulas.latex_formula_check(library, project_id)
        assert result["files_checked"] == 1
        assert result["formulas"][0]["source"] == "$safe$"
    finally:
        library.close()


def test_file_and_reference_budgets_mark_incomplete(tmp_path, monkeypatch):
    monkeypatch.setattr(latex_formulas, "MAX_FILES", 1)
    monkeypatch.setattr(latex_formulas, "MAX_REFERENCES", 1)
    result = check(tmp_path, {"main.tex": r"$a\label{x}$ \eqref{x}", "z.tex": "$b$"})
    assert result["limited"]
    assert {item["code"] for item in result["issues"]} >= {"file_limit", "reference_limit"}


def test_unclosed_literal_reports_incomplete_formula_coverage(tmp_path):
    result = check(tmp_path, {"main.tex": "$real$\n\\begin{verbatim}\n$not-math$"})
    assert result["summary"]["formulas"] == 1
    assert result["limited"]
    assert result["issues"][0]["code"] == "literal_unclosed"


def test_formula_action_uses_normal_library_dispatch(tmp_path):
    _, library, project_id = fixture(tmp_path, {"main.tex": r"\[a=b\]"})
    directory = str(library.root)
    library.close()
    result = dispatch(dict(library=directory, action="latex_formula_check", id=project_id))
    assert result["project_id"] == project_id
    assert result["summary"]["formulas"] == 1
