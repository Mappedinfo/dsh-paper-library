"""Bounded source-order navigation, deliberately a lexical view rather than TeX.

No macros, conditionals, package lookup or shell execution. Every occurrence of
a static input is expanded in place; a recursion stack breaks cycles, while a
separate read cache bounds IO without losing repeated/shared chapter positions.
"""
from __future__ import annotations

import re
from pathlib import Path

from .latex_lint import TOKEN, LITERALS, DECLARATIONS, _group, _space

MAX_FILES = 100
MAX_BYTES = 8 * 1024 * 1024
MAX_EVENTS = 1200
MAX_DEPTH = 24
LEVELS = {"part": 0, "chapter": 1, "section": 2, "subsection": 3, "subsubsection": 4, "paragraph": 5, "subparagraph": 6}


def tokens(body):
    """Yield relevant commands, ignoring comments, definitions and literal code."""
    cursor = 0
    while match := TOKEN.search(body, cursor):
        cursor = match.end()
        if match[0].startswith("%"):
            continue
        command = match[0][1:]
        pos = _space(body, cursor)
        if command in DECLARATIONS:
            # Skip the declared command, optional parameters, and its body.
            if pos < len(body) and body[pos] == "*":
                pos = _space(body, pos + 1)
            name = _group(body, pos)
            bare = re.match(r"\\[A-Za-z@]+", body[pos:]) if not name else None
            pos = name[1] if name else pos + len(bare[0]) if bare else pos
            if command in {"def", "gdef", "edef", "xdef"}:
                opening = body.find("{", pos)
                pos = opening if opening >= 0 else len(body)
            else:
                for _ in range(2):
                    option = _group(body, pos, "[", "]")
                    if option:
                        pos = option[1]
            definition = _group(body, pos)
            cursor = definition[1] if definition else len(body)
            continue
        if command in {"verb", "Verb", "lstinline", "mintinline"}:
            pos = match.end()
            if pos < len(body) and body[pos] == "*":
                pos += 1
            option = _group(body, pos, "[", "]")
            if option:
                pos = option[1]
            if command == "mintinline":
                language = _group(body, pos)
                pos = language[1] if language else pos
            group = _group(body, pos) if command in {"lstinline", "mintinline"} else None
            if group:
                cursor = group[1]
            elif pos < len(body):
                end = body.find(body[pos], pos + 1)
                newline = body.find("\n", pos)
                cursor = end + 1 if end >= 0 and (newline < 0 or end < newline) else (newline if newline >= 0 else len(body))
            continue
        if command in LEVELS and pos < len(body) and body[pos] == "*":
            pos = _space(body, pos + 1)
        if command in LEVELS:
            option = _group(body, pos, "[", "]")
            if option:
                pos = option[1]
        group = _group(body, pos)
        if command == "begin" and group and group[0] in LITERALS:
            ending = re.compile(r"\\end\s*\{" + re.escape(group[0]) + r"\}").search(body, group[1])
            cursor = ending.end() if ending else len(body)
            continue
        if command in {"url", "path", "detokenize", "nolinkurl", "href"} and group:
            cursor = group[1]
            continue
        if command in {"input", "include"} or command in LEVELS or command in {"begin", "end", "documentclass"}:
            bare = re.match(r"[^\s%{}]+", body[pos:]) if command == "input" and not group else None
            value = group[0] if group else bare[0] if bare else None
            cursor = group[1] if group else pos + len(bare[0]) if bare else cursor
            yield match.start(), command, value
        elif command.startswith("if") or command in {"includeonly", "import", "subimport", "subfile", "endinput"}:
            yield match.start(), "unsupported", command


def outline(root: Path, main_path, files):
    from .latex import MAX_FILE_BYTES, _inside

    _, main = _inside(root, main_path, "主文件")
    cache, referenced, events, entries = {}, set(), [], []
    used_bytes, limited = 0, False

    def emit(kind, path, line, **data):
        nonlocal limited
        if len(events) >= MAX_EVENTS:
            limited = True
            return
        events.append({"kind": kind, "path": path, "line": line, **data})

    def source(path):
        nonlocal used_bytes
        if path in cache:
            return cache[path]
        absolute, relative = _inside(root, path)
        if absolute.suffix.lower() != ".tex" or not absolute.is_file():
            raise ValueError("引用的 .tex 文件不存在")
        size = absolute.stat().st_size
        if len(cache) >= MAX_FILES or size > MAX_FILE_BYTES or used_bytes + size > MAX_BYTES:
            raise ValueError("章节读取超出预算")
        body = absolute.read_text(encoding="utf-8", errors="replace")
        used_bytes += size
        cache[relative] = body
        return body

    def visit(path, stack, origin=None):
        if limited:
            return
        if path in stack or len(stack) >= MAX_DEPTH:
            emit("warning", *(origin or (path, 1)), title="循环引用" if path in stack else "引用嵌套超出预算", target=path)
            return
        try:
            body = source(path)
        except (ValueError, OSError) as error:
            emit("warning", *(origin or (path, 1)), title=str(error), target=path)
            return
        repeated = path in referenced
        referenced.add(path)
        emit("file", path, 1, title=path, depth=len(stack), repeated=repeated)
        for offset, command, value in tokens(body):
            if limited:
                break
            line = body.count("\n", 0, offset) + 1
            if command == "end" and value == "document":
                break
            if command in {"input", "include"}:
                value = re.sub(r"%[^\n]*(?:\n\s*)?", "", value or "").strip()
                if not value or re.search(r"[\\#{}$~]", value):
                    emit("warning", path, line, title="动态引用未解析", target=value[:200])
                    continue
                candidate = value if Path(value).suffix else value + ".tex"
                try:
                    absolute, target = _inside(root, candidate)
                    if not absolute.is_file() and Path(path).parent != Path("."):
                        absolute, target = _inside(root, (Path(path).parent / candidate).as_posix())
                    visit(target, [*stack, path], (path, line))
                except ValueError:
                    emit("warning", path, line, title="引用超出项目或路径无效", target=value[:200])
            elif command in LEVELS or (command == "begin" and value == "abstract"):
                title = re.sub(r"%[^\n]*", "", value or "").strip()
                title = re.sub(r"\s+", " ", title)
                emit("heading", path, line, title=("摘要 / Abstract" if command == "begin" else title or f"（无标题 {command}）")[:240], level=LEVELS.get(command, 2))
            elif command == "unsupported":
                emit("warning", path, line, title=f"\\{value} 未解释，以下为静态源码顺序")

    visit(main, [])
    # Entry candidates are bounded too; never read every project file unboundedly.
    candidate_scan_complete = True
    for item in files:
        if not item["path"].endswith(".tex"):
            continue
        try:
            if any(command == "documentclass" for _, command, _ in tokens(source(item["path"]))):
                entries.append(item["path"])
        except (ValueError, OSError):
            candidate_scan_complete = False
    return {"main_path": main, "events": events, "entries": entries,
            "referenced": sorted(referenced),
            "unreferenced": [item["path"] for item in files if item["kind"] == "text" and item["path"] not in referenced],
            "truncated": limited, "entry_scan_complete": candidate_scan_complete,
            "limited_interpretation": True, "limits": {"files": MAX_FILES, "bytes": MAX_BYTES, "events": MAX_EVENTS, "depth": MAX_DEPTH}}
