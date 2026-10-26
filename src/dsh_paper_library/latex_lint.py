"""Bounded, lexical placeholder lint. Never executes TeX or writes a source file.

This deliberately does not expand macros or infer TeX conditionals. Static local
dependencies are followed once; unsupported/dynamic dependencies fail coverage
explicitly. Positions are one-based Unicode character offsets in the saved text.
"""
from __future__ import annotations

import bisect
import re
from collections import deque
from pathlib import Path

MAX_FILES = 100
MAX_BYTES = 8 * 1024 * 1024
MAX_DEPTH = 32
MAX_FINDINGS = 1000
MAX_REFERENCES = 2000
CONTEXT_CHARACTERS = 200
MARKER = re.compile(r"(?<![a-z0-9_])(?:todo|x{4,})(?![a-z0-9_])", re.I | re.ASCII)
TOKEN = re.compile(r"%[^\n]*|\\(?:[a-zA-Z@]+|[^\n])")
BARE_INPUT = re.compile(r"[^\s%{}]+")
DECLARED_NAME = re.compile(r"\\[a-zA-Z@]+")
ABSOLUTE_LITERAL = re.compile(r"(?:[a-zA-Z]:[\\/]|(?<![\w:])/)[^\s{}<>\"']+")
IGNORE = re.compile(r"^%\s*latex-lint:\s*(ignore-line|ignore-next-line)\s*(?:--.*)?$", re.I)
LITERALS = {"verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*"}
DEPENDENCIES = {"input": ".tex", "include": ".tex", "bibliography": ".bib", "addbibresource": ".bib"}
DECLARATIONS = {"newcommand", "renewcommand", "providecommand", "DeclareRobustCommand", "def", "gdef", "edef", "xdef"}
GROUP_COMMANDS = {"begin", "detokenize", "url", "path", "nolinkurl", "href", *DECLARATIONS, *DEPENDENCIES}


def _space(body, pos):
    while pos < len(body):
        if body[pos].isspace():
            pos += 1
        elif body[pos] == "%":
            end = body.find("\n", pos)
            pos = len(body) if end < 0 else end + 1
        else:
            break
    return pos


def _group(body, pos, opening="{", closing="}"):
    """A balanced group without recursive parsing; return its content and end."""
    pos = _space(body, pos)
    if pos >= len(body) or body[pos] != opening:
        return None
    start, depth, cursor = pos + 1, 1, pos + 1
    while cursor < len(body):
        char = body[cursor]
        if char == "\\":
            cursor += 2
            continue
        if char == "%":
            end = body.find("\n", cursor)
            cursor = len(body) if end < 0 else end + 1
            continue
        if char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return body[start:cursor], cursor + 1
        cursor += 1
    return None


def _definition_labels(body, command, name, pos):
    """Only a placeholder renderer's own bare label is implementation text.

    Keep actual command calls, comments and other placeholders in the definition.
    Ordinary macros' bodies are checked in full, including deferred todo calls.
    """
    name = name.strip().removeprefix("\\")
    if not MARKER.fullmatch(name):
        return []
    if command in {"def", "gdef", "edef", "xdef"}:
        pos = body.find("{", pos)
        if pos < 0:
            return []
    else:
        for _ in range(2):  # Optional argument count and optional default value.
            option = _group(body, pos, "[", "]")
            if not option:
                break
            pos = option[1]
    definition = _group(body, pos)
    if not definition:
        return []
    start = definition[1] - len(definition[0]) - 1
    comments = [(m.start(), m.end()) for m in TOKEN.finditer(body, start, definition[1]) if m[0].startswith("%")]
    comment_starts = [a for a, _ in comments]
    labels = []
    for marker in MARKER.finditer(body, start, definition[1] - 1):
        comment = bisect.bisect_right(comment_starts, marker.start()) - 1
        if comment >= 0 and marker.start() < comments[comment][1]:
            continue
        if marker.start() and body[marker.start() - 1] == "\\":
            continue
        if (name.lower() == "todo") == (marker[0].lower() == "todo"):
            labels.append(marker.span())
    return labels


def _tex(body):
    """Mask literal examples, retaining comments for markers but not includes."""
    mask = list(body)
    dependencies, problems, ignored_lines = [], [], set()
    cursor = 0

    def comment(match):
        directive = IGNORE.fullmatch(match.group())
        if directive:
            ignored_lines.add((match.start(), directive[1].lower() == "ignore-next-line"))
        return directive

    def blank(start, end, keep_comments=False):
        mask[start:end] = ["\n" if c == "\n" else " " for c in body[start:end]]
        if keep_comments:
            for token in TOKEN.finditer(body, start, end):
                if token[0].startswith("%") and not comment(token):
                    mask[token.start():token.end()] = body[token.start():token.end()]

    while match := TOKEN.search(body, cursor):
        start, end = match.span()
        token = match.group()
        cursor = end
        if token.startswith("%"):
            if comment(match):
                blank(start, end)
            continue
        command = token[1:]
        pos = _space(body, end)
        if command in GROUP_COMMANDS and pos < len(body) and body[pos] == "{" and _group(body, pos) is None:
            problems.append((start, "syntax_unclosed", "命令参数未闭合，检查范围不完整"))
            break
        if command == "begin":
            group = _group(body, pos)
            if group and group[0] in LITERALS:
                ending = re.compile(r"\\end\s*\{" + re.escape(group[0]) + r"\}").search(body, group[1])
                cursor = ending.end() if ending else len(body)
                blank(start, cursor)
                if not ending:
                    problems.append((start, "literal_unclosed", "逐字／代码环境未闭合，检查范围不完整"))
                continue
        if command in {"verb", "Verb", "lstinline", "mintinline"}:
            if command in {"verb", "Verb", "lstinline"}:
                # Percent is a valid verb delimiter, rather than a TeX comment.
                pos = end
                while pos < len(body) and body[pos].isspace():
                    pos += 1
            if pos < len(body) and body[pos] == "*":
                pos += 1
            option = _group(body, pos, "[", "]")
            if option:
                pos = option[1]
                while pos < len(body) and body[pos].isspace():
                    pos += 1
            if command == "mintinline":
                language = _group(body, pos)
                if language:
                    pos = language[1]
                    while pos < len(body) and body[pos].isspace():
                        pos += 1
            group = _group(body, pos) if command in {"lstinline", "mintinline"} else None
            if group:
                cursor = group[1]
            elif pos < len(body) and not body[pos].isspace():
                closing = body.find(body[pos], pos + 1)
                newline = body.find("\n", pos)
                cursor = closing + 1 if closing >= 0 and (newline < 0 or closing < newline) else (newline if newline >= 0 else len(body))
                if closing < 0 or (newline >= 0 and closing > newline):
                    problems.append((start, "literal_unclosed", "行内逐字／代码文本未闭合，检查范围不完整"))
            else:
                problems.append((start, "literal_unclosed", "行内逐字／代码文本缺少分隔符"))
            blank(start, cursor)
            continue
        if command in {"detokenize", "url", "path", "nolinkurl", "href"}:
            group = _group(body, pos)
            if group:
                cursor = group[1]
                blank(start, cursor)  # href's visible second argument is still checked.
                continue
        if command in DECLARATIONS:
            if pos < len(body) and body[pos] == "*":
                pos = _space(body, pos + 1)
            group = _group(body, pos)
            declared = DECLARED_NAME.match(body, pos) if not group else None
            if group or declared:
                cursor = group[1] if group else declared.end()
                for a, b in _definition_labels(body, command, group[0] if group else declared[0], cursor):
                    blank(a, b)
                blank(start, cursor, keep_comments=True)
                continue
        if command not in DEPENDENCIES:
            continue
        if command == "addbibresource":
            option = _group(body, pos, "[", "]")
            if option:
                pos = _space(body, option[1])
        group = _group(body, pos)
        bare = BARE_INPUT.match(body, pos) if command == "input" and not group else None
        if group or bare:
            value = group[0] if group else bare[0]
            cursor = group[1] if group else bare.end()
            # A commented newline may separate a static filename's characters.
            value = re.sub(r"%[^\n]*\n\s*", "", value).strip()
            dependencies.append((start, command, value))
            blank(start, cursor, keep_comments=True)  # Filenames are identifiers, not prose.
            if len(dependencies) > MAX_REFERENCES:
                dependencies.pop()
                problems.append((start, "reference_limit", "文件引用数量超出 lint 预算，检查范围不完整"))
                break
        else:
            problems.append((start, "dependency_unresolved", "文件引用无法静态解析"))
    return "".join(mask), dependencies, problems, ignored_lines


def _markdown(body):
    # Explicitly selected notes may contain examples of the marker convention.
    mask, fence, inline = [], None, None
    for line in body.splitlines(keepends=True):
        match = re.match(r" {0,3}(`{3,}|~{3,})", line)
        if fence:
            mask.append("".join("\n" if c == "\n" else " " for c in line))
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not line[match.end():].strip():
                fence = None
        elif match:
            fence = match[1]
            mask.append("".join("\n" if c == "\n" else " " for c in line))
        else:
            cursor = 0
            for ticks in re.finditer(r"`+", line):
                part = line[cursor:ticks.end()]
                if inline:
                    mask.append(" " * len(part))
                    if ticks[0] == inline:
                        inline = None
                else:
                    mask.append(line[cursor:ticks.start()] + " " * len(ticks[0]))
                    inline = ticks[0]
                cursor = ticks.end()
            tail = line[cursor:]
            mask.append("".join("\n" if c == "\n" else " " for c in tail) if inline else tail)
    problems = [(0, "literal_unclosed", "Markdown 代码示例未闭合，检查范围不完整")] if fence or inline else []
    return "".join(mask), [], problems, set()


def lint_project(root: Path, main_path, mode="editing", paths=None):
    from .latex import MAX_FILE_BYTES, TEXT_SUFFIXES, _digest, _inside

    if mode not in ("editing", "submission"):
        raise ValueError("lint mode 必须是 editing 或 submission")
    if paths is not None and (not isinstance(paths, list) or len(paths) > MAX_FILES):
        raise ValueError(f"lint paths 必须是最多 {MAX_FILES} 个项目内文本路径的列表")
    main_absolute, main = _inside(root, main_path, "主文件")
    if main_absolute.suffix.lower() != ".tex":
        raise ValueError("lint 主文件必须是 .tex")
    selected = []
    for path in paths or []:
        absolute, relative = _inside(root, path)
        if absolute.suffix.lower() not in TEXT_SUFFIXES:
            raise ValueError("lint 只支持文本源文件")
        selected.append(relative)

    severity = "warn" if mode == "editing" else "submission_blocker"
    counts = dict(findings=0, markers=0, todo=0, todo_command=0, xxxx=0, scope=0, warn=0, submission_blocker=0)
    findings, files, queued = [], [], {main, *selected}
    pending = deque((path, 0, None) for path in dict.fromkeys([main, *selected]))
    consumed, references, complete = 0, 0, True

    def record(path, category, message, line=1, column=1, context=None, marker=None):
        counts["findings"] += 1
        counts[severity] += 1
        counts[category if category in ("todo", "todo_command", "xxxx") else "scope"] += 1
        if marker is not None:
            counts["markers"] += 1
        if len(findings) < MAX_FINDINGS:
            findings.append(dict(path=path, line=line, column=column, context=context, category=category,
                                 severity=severity, message=message, marker=marker))

    def problem(path, category, message, at=None):
        nonlocal complete
        complete = False
        record(path, category, message, **(at or {}))

    while pending:
        relative, depth, source = pending.popleft()
        at_path, at = source if source else (relative, None)
        if len(files) >= MAX_FILES:
            problem(at_path, "file_limit", "文件数量超出 lint 预算", at)
            break
        if depth > MAX_DEPTH:
            problem(at_path, "depth_limit", "文件引用深度超出 lint 预算", at)
            continue
        try:
            absolute, relative = _inside(root, relative)
            if not absolute.is_file():
                raise ValueError("not a regular file")
            with absolute.open("rb") as handle:
                data = handle.read(min(MAX_FILE_BYTES, MAX_BYTES - consumed) + 1)
        except (OSError, ValueError):
            problem(at_path, "file_unreadable", "项目内文本文件不存在、不可读或路径不安全", at)
            continue
        if len(data) > MAX_FILE_BYTES or consumed + len(data) > MAX_BYTES:
            problem(at_path, "byte_limit", "文本文件超出 lint 字节预算", at)
            continue
        consumed += len(data)
        try:
            body = data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        except UnicodeDecodeError:
            problem(at_path, "encoding", "文本不是有效 UTF-8，检查范围不完整", at)
            continue
        files.append(dict(path=relative, revision=_digest(body), bytes=len(data)))
        masked, dependencies, problems, directives = _markdown(body) if absolute.suffix.lower() == ".md" else _tex(body)
        starts = [0] + [m.end() for m in re.finditer("\n", body)]

        def position(offset, with_context=True):
            line = bisect.bisect_right(starts, offset)
            column = offset - starts[line - 1] + 1
            if not with_context:
                return dict(line=line, column=column)
            end = body.find("\n", offset)
            end = len(body) if end < 0 else end
            begin = max(starts[line - 1], offset - CONTEXT_CHARACTERS // 2)
            snippet = masked[begin:min(end, begin + CONTEXT_CHARACTERS)]
            return dict(line=line, column=column, context=ABSOLUTE_LITERAL.sub("<path>", snippet)[:CONTEXT_CHARACTERS])

        ignores = {bisect.bisect_right(starts, offset) + int(next_line) for offset, next_line in directives}
        for match in MARKER.finditer(masked):
            location = position(match.start())
            if location["line"] in ignores:
                continue
            category = "xxxx" if match[0][0].lower() == "x" else "todo_command" if match.start() and masked[match.start() - 1] == "\\" else "todo"
            if category == "todo_command":
                location = position(match.start() - 1)
            record(relative, category, "未完成内容占位符", **location, marker=("\\" if category == "todo_command" else "") + match[0])
        for offset, category, message in problems:
            problem(relative, category, message, position(offset, False))
        for offset, command, value in dependencies:
            references += 1
            location = position(offset, False)
            if references > MAX_REFERENCES:
                problem(relative, "reference_limit", "文件引用数量超出 lint 预算", location)
                break
            values = value.split(",", MAX_REFERENCES) if command == "bibliography" else [value]
            if len(values) > MAX_REFERENCES:
                problem(relative, "reference_limit", "书目引用数量超出 lint 预算", location)
                values = values[:MAX_REFERENCES]
            for target in values:
                target = target.strip()
                if not target or any(c in target for c in "\\#${}") or "://" in target:
                    problem(relative, "dependency_unresolved", "文件引用需宏展开或不是静态本地路径", location)
                    continue
                if not Path(target).suffix:
                    target += DEPENDENCIES[command]
                try:
                    child, target = _inside(root, target)
                    if child.suffix.lower() not in TEXT_SUFFIXES:
                        raise ValueError("non-text")
                except ValueError:
                    # Never echo an unsafe target, resolved absolute path or OS error.
                    problem(relative, "dependency_unsafe", "文件引用必须是项目内的相对文本路径", location)
                    continue
                if target not in queued:
                    if len(queued) >= MAX_FILES:
                        problem(relative, "file_limit", "文件数量超出 lint 预算", location)
                        continue
                    queued.add(target)
                    pending.append((target, depth + 1, (relative, location)))
    ready = complete and counts["markers"] == 0
    ok = complete if mode == "editing" else ready
    return dict(schema="paper-library-latex-lint.v1", mode=mode, main_path=main, paths=selected,
                ok=ok, submission_ready=ready, complete=complete,
                status=("incomplete" if not complete else "failed" if not ok else "warnings" if counts["warn"] else "passed"),
                counts=counts, findings=findings, files=files, bytes=consumed,
                truncated=counts["findings"] > len(findings),
                limits=dict(files=MAX_FILES, file_bytes=MAX_FILE_BYTES, bytes=MAX_BYTES, depth=MAX_DEPTH,
                            references=MAX_REFERENCES, findings=MAX_FINDINGS, context_characters=CONTEXT_CHARACTERS))
