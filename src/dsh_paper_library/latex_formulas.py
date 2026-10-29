"""On-demand, read-only formula extraction and lexical checks.

This is a source inventory, not a TeX interpreter or a mathematical proof. It
does not expand macros, evaluate conditional branches or judge formula meaning.
Only project-local saved .tex files are read, within explicit budgets.
"""
from __future__ import annotations

import bisect
import hashlib
import re
from pathlib import Path

MAX_FILES = 100
MAX_BYTES = 8 * 1024 * 1024
MAX_FORMULAS = 500
MAX_ISSUES = 500
MAX_FORMULA_CHARACTERS = 4000
MAX_OUTPUT_CHARACTERS = 256_000
MAX_REFERENCES = 5000
MATH_ENVIRONMENTS = {"equation", "align", "alignat", "flalign", "gather", "multline", "eqnarray", "displaymath", "math"}
LITERALS = {"verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*"}
TOKENS = re.compile(r"\\(?:begin|end)\s*\{[^{}]*\}|\\(?:[a-zA-Z@]+|[^\n])|\$\$?")
LEXICAL = re.compile(r"%[^\n]*|\\(?:[a-zA-Z@]+|[^\n])")
GROUP = re.compile(r"\s*\{([^{}]*)\}")
LABELS = re.compile(r"\\(label|eqref)\s*\{([^{}]*)\}")


def _labels(body, start=0, end=None):
    end = len(body) if end is None else end
    for token in LEXICAL.finditer(body, start, end):
        if token[0] in (r"\label", r"\eqref"):
            group = GROUP.match(body, token.end(), end)
            if group:
                yield token.start(), token[0][1:], group[1]


def _mask(body):
    """Mask comments and literal/code regions while retaining every offset."""
    chars = list(body)
    cursor = 0
    problems = []

    def blank(start, end):
        chars[start:end] = ["\n" if char == "\n" else " " for char in body[start:end]]

    while match := LEXICAL.search(body, cursor):
        cursor = match.end()
        token = match[0]
        if token.startswith("%"):
            blank(match.start(), cursor)
            continue
        command = token[1:]
        if command == "begin":
            group = GROUP.match(body, cursor)
            if group and group[1] in LITERALS:
                end = re.compile(r"\\end\s*\{" + re.escape(group[1]) + r"\}").search(body, group.end())
                cursor = end.end() if end else len(body)
                blank(match.start(), cursor)
                if not end:
                    problems.append((match.start(), "逐字／代码环境未闭合，后续公式未检查。"))
        elif command in {"verb", "Verb", "lstinline", "mintinline"}:
            pos = cursor
            if pos < len(body) and body[pos] == "*":
                pos += 1
            while pos < len(body) and body[pos].isspace() and body[pos] != "\n":
                pos += 1
            option = re.match(r"\[[^\]\n]*\]", body[pos:])
            if option and command in {"lstinline", "mintinline"}:
                pos += option.end()
                while pos < len(body) and body[pos].isspace() and body[pos] != "\n":
                    pos += 1
            language = GROUP.match(body, pos) if command == "mintinline" else None
            if language:
                pos = language.end()
                while pos < len(body) and body[pos].isspace() and body[pos] != "\n":
                    pos += 1
            if pos < len(body) and body[pos] != "\n":
                if body[pos] == "{" and command in {"lstinline", "mintinline"}:
                    depth, end = 1, pos + 1
                    while end < len(body) and depth:
                        if body[end] == "\\":
                            end += 2
                            continue
                        depth += (body[end] == "{") - (body[end] == "}")
                        end += 1
                    if depth:
                        problems.append((match.start(), "行内代码参数未闭合，后续公式未检查。"))
                else:
                    newline = body.find("\n", pos)
                    boundary = len(body) if newline < 0 else newline
                    ending = body.find(body[pos], pos + 1, boundary)
                    end = ending + 1 if ending >= 0 else boundary
                    if ending < 0:
                        problems.append((match.start(), "行内逐字／代码文本未闭合，此行公式未完整检查。"))
                cursor = end
                blank(match.start(), cursor)
        elif command in {"url", "path", "nolinkurl", "detokenize"}:
            group = GROUP.match(body, cursor)
            if group:
                cursor = group.end()
                blank(match.start(), cursor)
    return "".join(chars), problems


def _scan(body, path, emit_formula, emit_issue, labels, references, label_budget):
    masked, problems = _mask(body)
    starts = [0] + [match.end() for match in re.finditer("\n", body)]

    def line(offset):
        return bisect.bisect_right(starts, offset)

    for offset, message in problems:
        emit_issue("warning", "literal_unclosed", path, line(offset), message)

    opened = None

    def finish(end, inner_end, closed=True):
        nonlocal opened
        start, inner_start, closing, kind = opened
        identifier = "formula-" + hashlib.sha256(f"{path}:{start}:{body[start:end]}".encode()).hexdigest()[:16]
        formula = dict(id=identifier, path=path, line=line(start), end_line=line(max(start, end - 1)),
                       kind=kind, source=body[start:end], labels=[], closed=closed)
        for _, command, value in _labels(masked, inner_start, inner_end):
            if command == "label" and value.strip():
                formula["labels"].append(value.strip()[:200])
                if len(formula["labels"]) >= 20:
                    break
        emit_formula(formula)
        # Check real grouping braces, allowing escaped braces such as \{ and \}.
        balance = []
        for token in re.finditer(r"\\(?:[a-zA-Z@]+|[^\n])|[{}]", masked[inner_start:inner_end]):
            position = inner_start + token.start()
            if token[0] == "{":
                balance.append(position)
            elif token[0] == "}":
                if balance:
                    balance.pop()
                else:
                    emit_issue("error", "brace_unmatched", path, line(position), "公式中有未配对的右花括号 }。", identifier)
        if balance:
            emit_issue("error", "brace_unclosed", path, line(balance[0]), "公式中有未闭合的花括号 {。", identifier)
        contents = masked[inner_start:inner_end]
        left = len(re.findall(r"\\left(?![a-zA-Z@])", contents))
        right = len(re.findall(r"\\right(?![a-zA-Z@])", contents))
        if left != right:
            emit_issue("warning", "left_right_count", path, line(start), "\\left 与 \\right 数量不一致；请结合 TeX 编译结果核对。", identifier)
        if not LABELS.sub("", contents).strip():
            emit_issue("warning", "formula_empty", path, line(start), "公式内容为空。", identifier)
        if not closed:
            emit_issue("error", "math_unclosed", path, line(start), f"公式未闭合，缺少 {closing}。", identifier)
        opened = None

    for match in TOKENS.finditer(masked):
        token = match[0]
        environment = re.match(r"\\(begin|end)\s*\{([^{}]*)\}", token)
        kind, closing, is_start, is_end = None, None, False, False
        if environment and environment[2].removesuffix("*") in MATH_ENVIRONMENTS:
            kind = environment[2]
            closing = f"\\end{{{kind}}}"
            is_start, is_end = environment[1] == "begin", environment[1] == "end"
            token = f"\\{environment[1]}{{{kind}}}"
        elif token in ("$", "$$"):
            kind, closing = ("inline" if token == "$" else "display"), token
            is_end = opened is not None and opened[2] == token
            is_start = not is_end
        elif token in (r"\(", r"\["):
            kind, closing, is_start = ("inline" if token == r"\(" else "display"), r"\)" if token == r"\(" else r"\]", True
        elif token in (r"\)", r"\]"):
            is_end = True
        else:
            continue
        if opened is None:
            if is_start:
                opened = (match.start(), match.end(), closing, kind)
            else:
                emit_issue("error", "math_unmatched_close", path, line(match.start()), f"发现没有对应起点的公式结束符 {token}。")
        elif is_end and token == opened[2]:
            finish(match.end(), match.start())
        else:
            emit_issue("error", "math_delimiter_mismatch", path, line(match.start()), f"公式分隔符不匹配；此处应先结束 {opened[2]}。")
    if opened is not None:
        finish(len(body), len(body), False)

    for offset, command, value in _labels(masked):
        if label_budget[0] >= MAX_REFERENCES:
            emit_issue("warning", "reference_limit", path, line(offset), "标签与公式引用达到静态检查上限，其余引用尚未核对。")
            break
        label_budget[0] += 1
        target = value.strip()
        if not target or any(char in target for char in "\\#"):
            emit_issue("warning", "label_dynamic", path, line(offset), "标签或公式引用需宏展开，无法静态核对。")
            continue
        record = dict(path=path, line=line(offset), label=target[:200])
        if len(target) > 200:
            emit_issue("warning", "label_long", path, record["line"], "标签超过 200 字符，未纳入静态引用检查。")
        elif command == "label":
            labels.setdefault(target, []).append(record)
        else:
            references.append(record)


def latex_formula_check(library, id=None):
    """Extract saved project formulas and return local syntax/reference findings."""
    from .latex import MAX_FILE_BYTES, _digest, _inside, _project, tree

    project = _project(library, id)
    root = Path(project["root"])
    if not root.is_dir():
        raise ValueError("LaTeX 项目目录不存在")
    snapshot = tree(library, id)
    candidates = [file for file in snapshot["files"] if Path(file["path"]).suffix.lower() == ".tex"]
    formulas, issues, files, labels, references = [], [], [], {}, []
    label_budget = [0]
    consumed = output_characters = formula_count = issue_count = 0
    errors = warnings = 0
    limited = bool(snapshot["truncated"])

    def issue(severity, code, path, line, message, formula_id=None):
        nonlocal issue_count, errors, warnings, limited
        issue_count += 1
        errors += severity == "error"
        warnings += severity == "warning"
        if code in {"reference_limit", "literal_unclosed"}:
            limited = True
        if len(issues) < MAX_ISSUES:
            item = dict(severity=severity, code=code, path=path, line=line, message=message)
            if formula_id:
                item["formula_id"] = formula_id
            issues.append(item)
        else:
            limited = True

    def formula(value):
        nonlocal formula_count, output_characters, limited
        formula_count += 1
        if len(formulas) >= MAX_FORMULAS or output_characters >= MAX_OUTPUT_CHARACTERS:
            limited = True
            return
        text = value["source"][:min(MAX_FORMULA_CHARACTERS, MAX_OUTPUT_CHARACTERS - output_characters)]
        value["source_truncated"] = len(text) != len(value["source"])
        if value["source_truncated"]:
            limited = True
        value["source"] = text
        output_characters += len(text)
        formulas.append(value)

    if snapshot["truncated"]:
        issue("warning", "tree_limit", project["main_path"], 1, "文件树达到上限；公式清单未覆盖全部项目文件。")
    for candidate in candidates:
        relative = candidate["path"]
        if len(files) >= MAX_FILES:
            limited = True
            issue("warning", "file_limit", relative, 1, f"最多检查 {MAX_FILES} 个 .tex 文件；其余文件尚未检查。")
            break
        try:
            absolute, relative = _inside(root, relative)
            if not absolute.is_file():
                raise ValueError("not a regular file")
            with absolute.open("rb") as handle:
                data = handle.read(min(MAX_FILE_BYTES, max(0, MAX_BYTES - consumed)) + 1)
            if len(data) > MAX_FILE_BYTES or consumed + len(data) > MAX_BYTES:
                limited = True
                issue("warning", "byte_limit", relative, 1, "源文件超过单文件或总字节预算，尚未检查。")
                continue
            consumed += len(data)
            body = data.decode("utf-8")
        except (OSError, ValueError):
            limited = True
            issue("warning", "file_unreadable", relative, 1, "项目内源文件不可读、不是 UTF-8 或路径不安全，尚未检查。")
            continue
        files.append(dict(path=relative, revision=_digest(body), bytes=len(data)))
        _scan(body, relative, formula, issue, labels, references, label_budget)
    for name, definitions in labels.items():
        if len(definitions) > 1:
            for definition in definitions:
                issue("warning", "label_duplicate", definition["path"], definition["line"], f"标签 {name} 在项目中出现 {len(definitions)} 次。")
    for reference in references:
        if reference["label"] not in labels:
            issue("warning", "eqref_undefined", reference["path"], reference["line"], f"未找到公式引用 {reference['label']} 的静态标签；可能需要宏展开或外部引用。")
    return dict(schema="paper-library-latex-formulas.v1", project_id=project["id"], files_checked=len(files), files=files,
                formulas=formulas, issues=issues, limited=limited, complete=not limited,
                summary=dict(formulas=formula_count, errors=errors, warnings=warnings, issues=issue_count),
                scope="saved_project_tex", semantic_check=False,
                limits=dict(files=MAX_FILES, bytes=MAX_BYTES, file_bytes=MAX_FILE_BYTES, formulas=MAX_FORMULAS,
                            issues=MAX_ISSUES, formula_characters=MAX_FORMULA_CHARACTERS, output_characters=MAX_OUTPUT_CHARACTERS,
                            references=MAX_REFERENCES))
