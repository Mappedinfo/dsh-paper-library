"""写作对话的有界只读文件检索，不执行命令或建立后台索引。"""
from __future__ import annotations

from contextlib import contextmanager
import fnmatch
import hashlib
import os
from pathlib import Path
import stat
import time


TEXT_SUFFIXES = {".tex", ".bib", ".cls", ".sty", ".bst", ".def", ".tikz", ".txt", ".md"}
PRIVATE_NAMES = {"credential", "credentials", "secret", "secrets", "password", "passwords", "id_rsa", "id_ed25519", "private_key", "api_key", "apikey"}
MAX_ENTRIES, MAX_DEPTH, SCAN_SECONDS = 2000, 8, 2.0
MAX_TEXT_BYTES, MAX_SEARCH_BYTES, MAX_PDF_BYTES = 1024 * 1024, 4 * 1024 * 1024, 64 * 1024 * 1024
MAX_READ_CHARACTERS, MAX_SEARCH_CHARACTERS, MAX_PDF_CHARACTERS = 12000, 12000, 18000
MAX_SEARCH_MATCHES, MAX_CONTEXT_CHARACTERS, MAX_PDF_PAGES = 20, 600, 3
CAN_OPEN_WITHOUT_LINKS = os.open in os.supports_dir_fd and os.scandir in os.supports_fd and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")


def _integer(value, default, minimum, maximum, label):
    value = default if value is None else value
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{label}须在 {minimum}–{maximum} 之间")
    return value


def _project(library, id, expected_root, expected_binding_generation):
    from .latex import _project as project
    from .latex_project_guard import check_binding
    row = project(library, id)
    if not isinstance(expected_root, str) or isinstance(expected_binding_generation, bool) or not isinstance(expected_binding_generation, int):
        raise ValueError("只读检索须绑定当前项目文件夹和绑定代次，请重新打开项目")
    check_binding(row, expected_root, expected_binding_generation)
    if not CAN_OPEN_WITHOUT_LINKS:
        raise ValueError("当前平台不支持安全的项目内文件检索")
    return row, Path(row["root"])


def _blocked(part):
    from .latex import SKIP_DIRECTORIES
    name = part.strip().casefold()
    return name.startswith(".") or name in PRIVATE_NAMES or name in SKIP_DIRECTORIES or name in {"node_modules", "__pycache__", "site-packages", "build", "dist"} or Path(name).stem in PRIVATE_NAMES


def _relative(root, value, *, allow_root=False):
    if allow_root and value in (None, "", "."):
        return root, ""
    if not isinstance(value, str) or not value.strip() or len(value) > 500 or "\x00" in value or "\\" in value:
        raise ValueError("检索路径须为项目内的相对路径")
    logical = Path(value)
    if not logical.parts or logical.is_absolute() or any(part in {"..", "."} or _blocked(part) for part in logical.parts):
        raise ValueError("检索路径包含不允许访问的目录或文件")
    if len(logical.parts) > MAX_DEPTH + 1:
        raise ValueError("检索路径超出目录深度限制")
    current = root
    for part in logical.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("只读检索不跟随符号链接")
    # Keep the same path throughout. The editor's resolver trims whitespace
    # and follows links, which would change the path checked by this policy.
    return current, logical.as_posix()


@contextmanager
def _descriptor(root, relative):
    """逐级 openat + nofollow，枚举和读取均不能通过链接离开根目录。"""
    descriptors = []
    try:
        flags = os.O_RDONLY | os.O_NOFOLLOW
        directory = os.open(root.anchor, flags | os.O_DIRECTORY)
        descriptors.append(directory)
        parts = Path(relative).parts
        for part in (*root.parts[1:], *parts[:-1]):
            directory = os.open(part, flags | os.O_DIRECTORY, dir_fd=directory)
            descriptors.append(directory)
        descriptor = directory
        if parts:
            descriptor = os.open(parts[-1], flags | getattr(os, "O_NONBLOCK", 0), dir_fd=directory)
            descriptors.append(descriptor)
        yield descriptor
    except OSError:
        raise ValueError("项目文件无法读取，或包含不允许的链接") from None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


@contextmanager
def _open(root, relative):
    with _descriptor(root, relative) as descriptor:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("只支持项目内的普通文件")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            yield stream


def _bytes(root, relative, maximum):
    with _open(root, relative) as stream:
        before = os.fstat(stream.fileno())
        if before.st_size > maximum:
            raise ValueError("文件超过本次只读检索的字节预算")
        body = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        if len(body) > maximum:
            raise ValueError("文件超过本次只读检索的字节预算")
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("文件在读取期间改变，请重新读取")
        return body


def _text(root, relative, maximum=None):
    raw = _bytes(root, relative, MAX_TEXT_BYTES if maximum is None else min(MAX_TEXT_BYTES, maximum))
    if b"\0" in raw:
        raise ValueError("文本文件包含二进制内容，不用于检索")
    # Match latex.read's UTF-8 and universal-newline revision semantics.
    body = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    return body, hashlib.sha256(body.encode("utf-8")).hexdigest(), len(raw)


def _lines(body):
    lines = body.split("\n")
    if not lines[-1]:
        lines.pop()
    return lines


def _inventory(root, path=None, *, deadline=None):
    location, relative = _relative(root, path, allow_root=True)
    with _descriptor(root, relative) as descriptor:
        metadata = os.fstat(descriptor)
        if stat.S_ISREG(metadata.st_mode):
            kind = "text" if location.suffix.lower() in TEXT_SUFFIXES else "pdf" if location.suffix.lower() == ".pdf" else None
            if not kind:
                raise ValueError("检索只支持保存的文本源码、文献条目和 PDF")
            return [{"path": relative, "kind": kind, "bytes": metadata.st_size}], False, 1
        if not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("检索只支持项目内的普通文件或目录")
    pending, files, scanned, truncated = [relative], [], 0, False
    deadline = deadline if deadline is not None else time.monotonic() + SCAN_SECONDS
    while pending:
        directory = pending.pop()
        try:
            with _descriptor(root, directory) as descriptor, os.scandir(descriptor) as entries:
                for entry in entries:
                    scanned += 1
                    if scanned > MAX_ENTRIES or time.monotonic() > deadline:
                        return sorted(files, key=lambda value: value["path"]), True, min(scanned, MAX_ENTRIES)
                    if _blocked(entry.name) or entry.is_symlink():
                        continue
                    full = Path(directory) / entry.name
                    if len(full.as_posix()) > 500:
                        continue
                    depth = len(full.parts)
                    if entry.is_dir(follow_symlinks=False):
                        if depth <= MAX_DEPTH:
                            pending.append(full.as_posix())
                        else:
                            truncated = True
                    elif entry.is_file(follow_symlinks=False):
                        suffix = full.suffix.lower()
                        kind = "text" if suffix in TEXT_SUFFIXES else "pdf" if suffix == ".pdf" else None
                        if kind:
                            files.append({"path": full.as_posix(), "kind": kind, "bytes": entry.stat(follow_symlinks=False).st_size})
        except (OSError, ValueError):
            truncated = True
    return sorted(files, key=lambda value: value["path"]), truncated, scanned


def listing(library, id=None, path=None, offset=None, limit=None, expected_root=None, expected_binding_generation=None):
    row, root = _project(library, id, expected_root, expected_binding_generation)
    offset = _integer(offset, 0, 0, MAX_ENTRIES, "目录偏移")
    limit = _integer(limit, 20, 1, 50, "目录条数")
    deadline = time.monotonic() + SCAN_SECONDS
    files, truncated, scanned = _inventory(root, path, deadline=deadline)
    return {"id": row["id"], "kind": "project_files", "files": files[offset:offset + limit], "offset": offset, "limit": limit,
            "total": None if truncated else len(files), "known_total": len(files), "has_more": truncated or offset + limit < len(files),
            "truncated": truncated, "scanned_entries": scanned, "limits": {"entries": MAX_ENTRIES, "depth": MAX_DEPTH, "seconds": SCAN_SECONDS}}


def read(library, id=None, path=None, start_line=None, lines=None, expected_root=None, expected_binding_generation=None):
    row, root = _project(library, id, expected_root, expected_binding_generation)
    absolute, relative = _relative(root, path)
    if absolute.suffix.lower() not in TEXT_SUFFIXES:
        raise ValueError("只读文本工具仅支持源码及文本／书目文件")
    start = _integer(start_line, 1, 1, 1000000, "起始行")
    count = _integer(lines, 80, 1, 200, "读取行数")
    body, revision, size = _text(root, relative)
    all_lines = _lines(body)
    end = min(len(all_lines), start - 1 + count)
    selection = "\n".join(all_lines[start - 1:end])
    if start - 1 < end and (end < len(all_lines) or body.endswith("\n")):
        selection += "\n"
    content = selection[:MAX_READ_CHARACTERS]
    actual = len(_lines(content))
    return {"id": row["id"], "kind": "project_text", "path": relative, "revision": revision, "bytes": size,
            "start_line": start, "end_line": start + actual - 1 if actual else None, "total_lines": len(all_lines), "content": content,
            "truncated": len(selection) > len(content) or start - 1 + count < len(all_lines),
            "limits": {"file_bytes": MAX_TEXT_BYTES, "lines": 200, "characters": MAX_READ_CHARACTERS}}


def search(library, id=None, query=None, path=None, glob=None, case_sensitive=False, limit=None, expected_root=None, expected_binding_generation=None):
    row, root = _project(library, id, expected_root, expected_binding_generation)
    if not isinstance(query, str) or not query.strip() or len(query) > 200 or any(char in query for char in "\0\r\n"):
        raise ValueError("检索词须为1–200字符的单行文字，按字面检索")
    if not isinstance(case_sensitive, bool):
        raise ValueError("case_sensitive必须是布尔值")
    if glob is not None and (not isinstance(glob, str) or len(glob) > 200 or glob.startswith("/") or ".." in Path(glob).parts or "\\" in glob or "\0" in glob):
        raise ValueError("文件筛选须为项目内的相对 glob")
    maximum = _integer(limit, 10, 1, MAX_SEARCH_MATCHES, "检索结果条数")
    deadline = time.monotonic() + SCAN_SECONDS
    files, truncated, scanned = _inventory(root, path, deadline=deadline)
    matches, read_files, scanned_bytes, emitted, skipped = [], 0, 0, 0, 0
    needle = query if case_sensitive else query.lower()
    for file in files:
        if file["kind"] != "text" or glob and not fnmatch.fnmatchcase(file["path"], glob):
            continue
        if scanned_bytes + file["bytes"] > MAX_SEARCH_BYTES or time.monotonic() > deadline:
            truncated = True; break
        try:
            body, revision, size = _text(root, file["path"], MAX_SEARCH_BYTES - scanned_bytes)
        except ValueError:
            skipped += 1; truncated = True; continue
        scanned_bytes += size; read_files += 1
        for line, content in enumerate(_lines(body), 1):
            if line % 128 == 0 and time.monotonic() > deadline:
                truncated = True; break
            found = (content if case_sensitive else content.lower()).find(needle)
            if found < 0:
                continue
            begin = max(0, found - 120)
            snippet = content[begin:begin + MAX_CONTEXT_CHARACTERS]
            if emitted + len(snippet) > MAX_SEARCH_CHARACTERS or len(matches) >= maximum:
                truncated = True; break
            matches.append({"kind": "project_text", "path": file["path"], "line": line, "end_line": line, "text": snippet,
                            "revision": revision, "truncated": begin > 0 or begin + len(snippet) < len(content)})
            emitted += len(snippet)
        if len(matches) >= maximum or emitted >= MAX_SEARCH_CHARACTERS or time.monotonic() > deadline:
            truncated = True; break
    return {"id": row["id"], "kind": "project_search", "query": query, "matches": matches, "truncated": truncated,
            "scanned_files": read_files, "candidate_files": sum(file["kind"] == "text" and (not glob or fnmatch.fnmatchcase(file["path"], glob)) for file in files),
            "scanned_entries": scanned, "scanned_bytes": scanned_bytes, "skipped_files": skipped,
            "limits": {"entries": MAX_ENTRIES, "file_bytes": MAX_TEXT_BYTES, "search_bytes": MAX_SEARCH_BYTES,
                       "matches": MAX_SEARCH_MATCHES, "characters": MAX_SEARCH_CHARACTERS, "seconds": SCAN_SECONDS}}


def pdf_text(library, id=None, path=None, page=None, pages=None, expected_root=None, expected_binding_generation=None):
    import pymupdf as fitz
    row, root = _project(library, id, expected_root, expected_binding_generation)
    absolute, relative = _relative(root, path if path is not None else row["pdf_path"])
    if absolute.suffix.lower() != ".pdf":
        raise ValueError("PDF文字工具只支持项目内的PDF文件")
    first, count = _integer(page, 1, 1, 2000, "PDF起始页"), _integer(pages, 1, 1, MAX_PDF_PAGES, "PDF页数")
    raw = _bytes(root, relative, MAX_PDF_BYTES)
    result, emitted, truncated = [], 0, False
    with fitz.open(stream=raw, filetype="pdf") as doc:
        if not doc.is_pdf or doc.needs_pass or doc.is_encrypted or doc.xref_get_key(-1, "Encrypt")[0] != "null":
            raise ValueError("加密PDF不用于只读检索")
        if len(doc) > 2000 or first > len(doc):
            raise ValueError("PDF页码或文档页数超出读取范围")
        for number in range(first, min(len(doc), first + count - 1) + 1):
            text = doc[number - 1].get_text("text", sort=True)
            content = text[:min(8000, MAX_PDF_CHARACTERS - emitted)]
            result.append({"kind": "project_pdf", "path": relative, "page": number, "text": content, "truncated": len(content) < len(text)})
            emitted += len(content); truncated = truncated or len(content) < len(text)
        return {"id": row["id"], "kind": "project_pdf", "path": relative, "pdf_version": hashlib.sha256(raw).hexdigest(),
                "page_count": len(doc), "pages": result, "truncated": truncated,
                "limits": {"pages": MAX_PDF_PAGES, "file_bytes": MAX_PDF_BYTES, "page_characters": 8000, "characters": MAX_PDF_CHARACTERS}}
