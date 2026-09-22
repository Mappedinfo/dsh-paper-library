"""LaTeX projects: one folder holding sources and the PDF they compile to.

A project is a real folder the reader already works in: the `.tex` sources, the
bibliography and the matching PDF live side by side, and this module treats that
folder as the unit of work. Nothing is copied into the library and nothing is
deleted from it; the catalog only records which folder is a project and which
file is its main document.

Boundaries that keep it predictable:

- Every path is resolved inside the project root, symlinks included, so a request
  cannot read or write outside the folder it names.
- Writes are atomic, bounded, and revision-checked against the digest the reader
  saw; every accepted write keeps a bounded text history for diffing and review.
- Compiling runs the user's own `latexmk` in the folder with a hard timeout and a
  separated `PATH`, and reports the log tail instead of pretending a failed build
  succeeded. Auxiliary files are only removed by an explicit `clean`.
"""

from __future__ import annotations

import base64
import difflib
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

MAX_PROJECTS = 200
MAX_TITLE = 200
MAX_FILE_BYTES = 1024 * 1024
MAX_WRITE_BYTES = 2 * 1024 * 1024
MAX_TREE_FILES = 2000
MAX_TREE_DEPTH = 8
MAX_DIFF_CHARACTERS = 200_000
HISTORY_LIMIT = 40
HISTORY_BYTES = 512 * 1024
COMPILE_TIMEOUT = 120
COMPILE_MAX_TIMEOUT = 600
LOG_TAIL_CHARACTERS = 32_000
TEXT_SUFFIXES = {".tex", ".bib", ".cls", ".sty", ".bst", ".cfg", ".def", ".tikz", ".txt", ".md"}
ASSET_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".bmp", ".gif", ".csv", ".drawio", ".xlsx", ".ipynb"}
AUX_SUFFIXES = {".aux", ".log", ".out", ".toc", ".lof", ".lot", ".fls", ".fdb_latexmk", ".synctex.gz", ".bbl", ".blg", ".nav", ".snm", ".vrb", ".run.xml", ".bcf", ".idx", ".ilg", ".ind", ".xdv"}
SKIP_DIRECTORIES = {".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "site-packages", ".Trash", ".DS_Store", ".latex-history", ".latex-build", ".ipynb_checkpoints"}
ENGINES = ("xelatex", "pdflatex", "lualatex")
TEXBIN = "/Library/TeX/texbin"
IDENTIFIER = re.compile(r"^lt-[0-9a-f]{12}$")

STARTER = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{ctex}
\usepackage{booktabs}
\usepackage{hyperref}

\title{未命名}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{引言}

\end{document}
"""


class LatexConflict(ValueError):
    """The file changed since the reader's revision; reload before writing."""

    code = "STATE_CONFLICT"
    status = 409

    def __init__(self, current):
        super().__init__("STATE_CONFLICT: LaTeX 文件已被改动；请重新读取后再保存")
        self.current = current


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value, name, maximum, required=False):
    if value is None:
        if required:
            raise ValueError(f"{name}不能为空")
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name}必须是文本")
    cleaned = value.strip()
    if required and not cleaned:
        raise ValueError(f"{name}不能为空")
    if len(cleaned) > maximum:
        raise ValueError(f"{name}超过 {maximum} 个字符")
    return cleaned


def _identifier(value, name="项目标识"):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError(f"{name}无效")
    return value


def _digest(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _resolve_root(value) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("项目目录不能为空")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("项目目录必须是绝对路径")
    path = Path(os.path.realpath(path))
    if not path.is_dir():
        raise ValueError("项目目录不存在或不是文件夹")
    return path


def _guard_root(library, root: Path) -> Path:
    protected = [library.root / name for name in ("pdfs", "backups", "external", "exports")]
    if root == library.root or any(root == item or root.is_relative_to(item) for item in protected):
        raise ValueError("项目目录不能是文献库的受管目录；请选择你自己的 LaTeX 文件夹")
    return root


def _inside(root: Path, value, name="文件路径", required=True) -> tuple[Path, str]:
    """Resolve one project-relative path, refusing anything that leaves the folder."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ValueError(f"{name}不能为空")
        return None, None
    if not isinstance(value, str):
        raise ValueError(f"{name}必须是文本")
    cleaned = value.strip().replace("\\", "/")
    if len(cleaned) > 500 or "\x00" in cleaned:
        raise ValueError(f"{name}无效")
    candidate = Path(cleaned)
    if candidate.is_absolute():
        raise ValueError(f"{name}必须是项目内的相对路径")
    absolute = Path(os.path.realpath(root / candidate))
    if not absolute.is_relative_to(root):
        raise ValueError(f"{name}超出项目目录")
    relative = absolute.relative_to(root).as_posix()
    if relative in ("", ".") or relative.startswith("../"):
        raise ValueError(f"{name}无效")
    return absolute, relative


def _project(library, project_id, include_archived=False):
    project_id = _identifier(project_id)
    row = library.db.execute(
        "SELECT latex_projects.*, latex_archive.archived_at FROM latex_projects"
        " LEFT JOIN latex_archive ON latex_archive.project_id=latex_projects.id WHERE latex_projects.id=?",
        (project_id,),
    ).fetchone()
    if not row:
        raise ValueError("LaTeX 项目不存在")
    if row["archived_at"] and not include_archived:
        raise ValueError("LaTeX 项目已归档；恢复后才能修改或编译")
    return row


def _row(row, library=None):
    value = {
        "id": row["id"],
        "root": row["root"],
        "title": row["title"],
        "main_path": row["main_path"],
        "pdf_path": row["pdf_path"],
        "created": row["created"],
        "modified": row["modified"],
        "archived": bool(row["archived_at"]) if "archived_at" in row.keys() else False,
        "archived_at": row["archived_at"] if "archived_at" in row.keys() else None,
    }
    value["exists"] = os.path.isdir(row["root"])
    value["main_present"] = bool(row["main_path"]) and os.path.isfile(os.path.join(row["root"], row["main_path"]))
    value["pdf_present"] = bool(row["pdf_path"]) and os.path.isfile(os.path.join(row["root"], row["pdf_path"]))
    return value


def _ordered(rows):
    return sorted(rows, key=lambda row: (row["title"].casefold(), row["id"]))


def _detect_main(root: Path) -> str | None:
    """Prefer a classic `main.tex`, then any file declaring a document class."""
    candidates = []
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRECTORIES and not name.startswith("."))
        for name in sorted(filenames):
            if name.lower().endswith(".tex"):
                full = Path(directory) / name
                try:
                    relative = full.relative_to(root).as_posix()
                    depth = relative.count("/")
                except ValueError:
                    continue
                if depth > MAX_TREE_DEPTH:
                    continue
                candidates.append(relative)
        if len(candidates) > 400:
            break
    if not candidates:
        return None
    for relative in candidates:
        if Path(relative).name.lower() == "main.tex":
            return relative
    for relative in candidates:
        try:
            body = (root / relative).read_text(encoding="utf-8", errors="replace")[:20000]
        except OSError:
            continue
        if "\\documentclass" in body:
            return relative
    return candidates[0]


def _matching_pdf(root: Path, main_path: str) -> str | None:
    if not main_path:
        return None
    candidate = Path(main_path).with_suffix(".pdf")
    if candidate.is_absolute() or ".." in candidate.parts:
        return None
    if (root / candidate).is_file():
        return candidate.as_posix()
    return None


def create(library, root=None, title=None, main_path=None, create_missing=False):
    path = _guard_root(library, _resolve_root(root))
    existing = library.db.execute("SELECT id FROM latex_projects WHERE root=?", (str(path),)).fetchone()
    if existing:
        raise ValueError("这个文件夹已经是 LaTeX 项目")
    live = library.db.execute("SELECT count(*) FROM latex_projects WHERE id NOT IN (SELECT project_id FROM latex_archive)").fetchone()[0]
    if live >= MAX_PROJECTS:
        raise ValueError(f"LaTeX 项目最多 {MAX_PROJECTS} 个")
    main = None
    if main_path is not None:
        absolute, main = _inside(path, main_path, "主文件")
        if absolute.suffix.lower() != ".tex":
            raise ValueError("主文件必须是 .tex")
        if not absolute.is_file():
            raise ValueError("主文件不存在")
    else:
        main = _detect_main(path)
    if main is None:
        if not create_missing:
            raise ValueError("这个文件夹里没有 .tex 文件；可以新建一个主文件或选择其他文件夹")
        target = path / "main.tex"
        if target.exists():
            raise ValueError("main.tex 已存在但不是可用的主文件")
        _atomic_write(target, STARTER)
        main = "main.tex"
    project_id = "lt-" + uuid.uuid4().hex[:12]
    stamp = now()
    clean_title = _text(title, "项目标题", MAX_TITLE) or path.name
    pdf = _matching_pdf(path, main)
    library.db.execute(
        "INSERT INTO latex_projects(id,root,title,main_path,pdf_path,created,modified) VALUES(?,?,?,?,?,?,?)",
        (project_id, str(path), clean_title, main, pdf, stamp, stamp),
    )
    library.db.commit()
    return {"project": _row(_project(library, project_id))}


def listing(library, query=None, include_archived=False, limit=50, offset=0):
    if not isinstance(include_archived, bool):
        raise ValueError("include_archived 必须是布尔值")
    limit = max(1, min(int(limit if limit is not None else 50), 200))
    offset = max(0, min(int(offset if offset is not None else 0), 100000))
    like = None
    if query is not None:
        cleaned = _text(query, "检索词", 200) or ""
        like = f"%{cleaned.casefold()}%" if cleaned else None
    live = "" if include_archived else " WHERE latex_archive.project_id IS NULL"
    match = "" if not like else (" AND " if live else " WHERE ") + "(lower(latex_projects.title) LIKE ? OR lower(latex_projects.root) LIKE ? OR lower(coalesce(latex_projects.main_path,'')) LIKE ?)"
    arguments = () if not like else (like, like, like)
    base = "SELECT latex_projects.*, latex_archive.archived_at FROM latex_projects LEFT JOIN latex_archive ON latex_archive.project_id=latex_projects.id"
    total = library.db.execute(f"SELECT count(*) FROM ({base}{live}{match})", arguments).fetchone()[0]
    rows = library.db.execute(f"{base}{live}{match} ORDER BY latex_projects.title,latex_projects.id LIMIT ? OFFSET ?", (*arguments, limit, offset)).fetchall()
    items = [_row(row) for row in rows]
    return {"projects": items, "total": total, "limit": limit, "offset": offset, "truncated": offset + len(items) < total}


def get(library, id=None, include_archived=False):
    row = _project(library, id, include_archived)
    value = _row(row)
    if value["exists"]:
        value["files"] = len(tree(library, id, include_archived=True)["files"])
    return {"project": value}


def update(library, id=None, title=None, main_path=None, include_archived=False):
    row = _project(library, id, include_archived)
    changes, values = [], []
    if title is not None:
        changes.append("title=?")
        values.append(_text(title, "项目标题", MAX_TITLE, required=True))
    if main_path is not None:
        absolute, relative = _inside(Path(row["root"]), main_path, "主文件")
        if absolute.suffix.lower() != ".tex" or not absolute.is_file():
            raise ValueError("主文件必须存在且是 .tex")
        changes.append("main_path=?")
        values.append(relative)
    if not changes:
        raise ValueError("没有需要修改的字段")
    changes.append("modified=?")
    values.append(now())
    values.append(row["id"])
    library.db.execute(f"UPDATE latex_projects SET {', '.join(changes)} WHERE id=?", values)
    library.db.commit()
    project = _row(_project(library, row["id"], include_archived))
    if main_path is not None:
        pdf = _matching_pdf(Path(row["root"]), project["main_path"])
        if pdf:
            library.db.execute("UPDATE latex_projects SET pdf_path=? WHERE id=?", (pdf, row["id"]))
            library.db.commit()
            project = _row(_project(library, row["id"], include_archived))
    return {"project": project}


def archive(library, id=None):
    row = _project(library, id)
    library.db.execute("INSERT INTO latex_archive(project_id,archived_at) VALUES(?,?) ON CONFLICT(project_id) DO NOTHING", (row["id"], now()))
    library.db.commit()
    return {"project": _row(_project(library, row["id"], include_archived=True)), "folder_kept": row["root"]}


def restore(library, id=None):
    project_id = _identifier(id)
    cursor = library.db.execute("DELETE FROM latex_archive WHERE project_id=?", (project_id,))
    library.db.commit()
    row = _project(library, project_id, include_archived=True)
    return {"project": _row(row), "restored": bool(cursor.rowcount)}


def tree(library, id=None, include_archived=False):
    row = _project(library, id, include_archived)
    root = Path(row["root"])
    files, truncated = [], False
    if root.is_dir():
        for directory, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRECTORIES and not name.startswith("."))
            for name in sorted(filenames):
                full = Path(directory) / name
                if full.is_symlink():
                    continue
                suffix = full.suffix.lower()
                kind = "text" if suffix in TEXT_SUFFIXES else "asset" if suffix in ASSET_SUFFIXES else "other"
                if kind == "other" and suffix in AUX_SUFFIXES:
                    kind = "build"
                elif kind == "other":
                    continue
                try:
                    relative = full.relative_to(root).as_posix()
                    stat = full.stat()
                except (OSError, ValueError):
                    continue
                if relative.count("/") > MAX_TREE_DEPTH:
                    continue
                files.append({
                    "path": relative,
                    "kind": kind,
                    "bytes": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
                    "main": relative == row["main_path"],
                    "pdf": relative == row["pdf_path"],
                })
                if len(files) >= MAX_TREE_FILES:
                    truncated = True
                    break
            if truncated:
                break
    files.sort(key=lambda item: (item["kind"] != "text", item["path"]))
    return {"id": row["id"], "root": row["root"], "main_path": row["main_path"], "pdf_path": row["pdf_path"], "files": files, "truncated": truncated, "limits": {"files": MAX_TREE_FILES, "depth": MAX_TREE_DEPTH}}


def read(library, id=None, path=None, include_archived=False):
    row = _project(library, id, include_archived)
    root = Path(row["root"])
    relative = path if path is not None else row["main_path"]
    absolute, relative = _inside(root, relative, "文件路径")
    if absolute.suffix.lower() not in TEXT_SUFFIXES:
        raise ValueError("只支持读取文本源文件")
    if not absolute.is_file():
        raise ValueError("文件不存在")
    size = absolute.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ValueError(f"文件超过 {MAX_FILE_BYTES // 1024} KiB；请在本地编辑器中打开")
    body = absolute.read_text(encoding="utf-8", errors="replace")
    revision = _digest(body)
    latest = library.db.execute(
        "SELECT id,created,origin,sha256 FROM latex_revisions WHERE project_id=? AND path=? ORDER BY created DESC,id DESC LIMIT 1",
        (row["id"], relative),
    ).fetchone()
    return {
        "id": row["id"], "path": relative, "content": body, "revision": revision, "bytes": size,
        "lines": body.count("\n") + 1, "main": relative == row["main_path"],
        "stored_revision": latest["sha256"] if latest else None,
        "stored_at": latest["created"] if latest else None,
        "modified": datetime.fromtimestamp(absolute.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def _atomic_write(destination: Path, body: str):
    descriptor, temporary = tempfile.mkstemp(prefix=".latex-write-", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, (destination.stat().st_mode & 0o777) if destination.exists() else 0o644)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)



def write(library, id=None, path=None, content=None, expected_revision=None, origin="reader", include_archived=False):
    row = _project(library, id, include_archived)
    root = Path(row["root"])
    absolute, relative = _inside(root, path, "文件路径")
    if absolute.suffix.lower() not in TEXT_SUFFIXES:
        raise ValueError("只支持写入文本源文件")
    if not isinstance(content, str):
        raise ValueError("文件内容必须是文本")
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError(f"文件内容超过 {MAX_WRITE_BYTES // 1024} KiB")
    if absolute.exists():
        if not absolute.is_file():
            raise ValueError("目标不是普通文件")
        current_body = absolute.read_text(encoding="utf-8", errors="replace")
        current = _digest(current_body)
        if expected_revision is not None and expected_revision != current:
            raise LatexConflict({"path": relative, "revision": current, "content": current_body if len(current_body) <= MAX_FILE_BYTES else None})
        if current_body == content:
            return {"id": row["id"], "path": relative, "revision": current, "changed": False, "bytes": len(content.encode("utf-8"))}
        previous = current_body
    else:
        if expected_revision not in (None, ""):
            raise LatexConflict({"path": relative, "revision": None, "content": None})
        previous = None
    if previous is not None:
        _remember(library, row["id"], relative, previous, "before-write")
    _atomic_write(absolute, content)
    revision = _digest(content)
    _remember(library, row["id"], relative, content, origin)
    library.db.execute("UPDATE latex_projects SET modified=? WHERE id=?", (now(), row["id"]))
    library.db.commit()
    return {"id": row["id"], "path": relative, "revision": revision, "changed": True, "bytes": len(content.encode("utf-8")), "previous_revision": _digest(previous) if previous is not None else None}


def _remember(library, project_id: str, path: str, body: str, origin: str):
    if len(body.encode("utf-8")) > HISTORY_BYTES:
        return None
    revision_id = "lr-" + uuid.uuid4().hex[:12]
    library.db.execute(
        "INSERT INTO latex_revisions(id,project_id,path,sha256,body,origin,created) VALUES(?,?,?,?,?,?,?)",
        (revision_id, project_id, path, _digest(body), body, str(origin)[:40], now()),
    )
    stale = library.db.execute(
        "SELECT id FROM latex_revisions WHERE project_id=? AND path=? ORDER BY created DESC,id DESC LIMIT -1 OFFSET ?",
        (project_id, path, HISTORY_LIMIT),
    ).fetchall()
    if stale:
        library.db.executemany("DELETE FROM latex_revisions WHERE id=?", [(item["id"],) for item in stale])
    return revision_id


def history(library, id=None, path=None, limit=20, include_archived=False):
    row = _project(library, id, include_archived)
    _, relative = _inside(Path(row["root"]), path if path is not None else row["main_path"], "文件路径")
    limit = max(1, min(int(limit if limit is not None else 20), HISTORY_LIMIT))
    rows = library.db.execute(
        "SELECT id,sha256,length(body) AS bytes,origin,created FROM latex_revisions WHERE project_id=? AND path=? ORDER BY created DESC,id DESC LIMIT ?",
        (row["id"], relative, limit),
    ).fetchall()
    current = None
    absolute, _ = _inside(Path(row["root"]), relative, "文件路径")
    if absolute.is_file():
        current = _digest(absolute.read_text(encoding="utf-8", errors="replace"))
    return {"id": row["id"], "path": relative, "current_revision": current, "revisions": [{"id": item["id"], "sha256": item["sha256"], "bytes": item["bytes"], "origin": item["origin"], "created": item["created"]} for item in rows]}


def _content_of(library, project_row, relative, reference):
    """Body for a revision id, `current`, or `previous` (the last stored revision)."""
    root = Path(project_row["root"])
    absolute, relative = _inside(root, relative, "文件路径")
    if reference in (None, "current"):
        if not absolute.is_file():
            raise ValueError("文件不存在")
        return absolute.read_text(encoding="utf-8", errors="replace")
    if reference == "previous":
        rows = library.db.execute("SELECT body,sha256 FROM latex_revisions WHERE project_id=? AND path=? ORDER BY created DESC,id DESC LIMIT ?", (project_row["id"], relative, HISTORY_LIMIT)).fetchall()
        if not rows:
            raise ValueError("还没有历史版本可以比较")
        current = None
        if absolute.is_file():
            current = _digest(absolute.read_text(encoding="utf-8", errors="replace"))
        for item in rows:
            if item["sha256"] != current:
                return item["body"]
        return rows[0]["body"]
    if isinstance(reference, str) and re.fullmatch(r"lr-[0-9a-f]{12}", reference):
        row = library.db.execute("SELECT body FROM latex_revisions WHERE id=? AND project_id=? AND path=?", (reference, project_row["id"], relative)).fetchone()
        if not row:
            raise ValueError("历史版本不存在")
        return row["body"]
    raise ValueError("版本引用必须是 current、previous 或历史版本 id")


def _unified(before: str, after: str, label_before: str, label_after: str, path: str):
    diff = list(difflib.unified_diff(before.splitlines(), after.splitlines(), fromfile=f"{label_before}/{path}", tofile=f"{label_after}/{path}", lineterm="", n=3))
    text = "\n".join(diff)
    truncated = len(text) > MAX_DIFF_CHARACTERS
    return {"diff": text[:MAX_DIFF_CHARACTERS], "truncated": truncated, "added": sum(1 for line in diff if line.startswith("+") and not line.startswith("+++")), "removed": sum(1 for line in diff if line.startswith("-") and not line.startswith("---")), "changed": bool(diff)}


def diff(library, id=None, path=None, from_revision="previous", to_revision="current", include_archived=False):
    row = _project(library, id, include_archived)
    _, relative = _inside(Path(row["root"]), path if path is not None else row["main_path"], "文件路径")
    before = _content_of(library, row, relative, from_revision)
    after = _content_of(library, row, relative, to_revision)
    result = _unified(before, after, str(from_revision), str(to_revision), relative)
    return {"id": row["id"], "path": relative, "from": str(from_revision), "to": str(to_revision), **result}


def compare(library, a=None, b=None, path=None, include_archived=False):
    left = _project(library, a, include_archived)
    right = _project(library, b, include_archived)
    if left["id"] == right["id"]:
        raise ValueError("请选择两个不同的项目进行比较")
    relative_left = relative_right = path
    if path is None:
        relative_left, relative_right = left["main_path"], right["main_path"]
        if not relative_left or not relative_right:
            raise ValueError("两个项目都需要主文件，或显式给出要比较的文件")
    before = _content_of(library, left, relative_left, "current")
    after = _content_of(library, right, relative_right or relative_left, "current")
    label = relative_left if relative_left == relative_right else f"{left['title']}:{relative_left}"
    result = _unified(before, after, f"{left['title']}", f"{right['title']}", label or "main.tex")
    return {
        "from": {"id": left["id"], "title": left["title"], "root": left["root"], "path": relative_left},
        "to": {"id": right["id"], "title": right["title"], "root": right["root"], "path": relative_right},
        **result,
    }


def _latexmk() -> str:
    found = shutil.which("latexmk")
    if found:
        return found
    candidate = Path(TEXBIN) / "latexmk"
    if candidate.is_file():
        return str(candidate)
    raise ValueError("找不到 latexmk；请安装 TeX Live / MacTeX 后再编译")


def _compile_env() -> dict:
    env = dict(os.environ)
    path = env.get("PATH", "")
    if TEXBIN not in path.split(":"):
        env["PATH"] = f"{TEXBIN}:{path}" if path else TEXBIN
    # Keep the build non-interactive and reproducible for a hung or missing input.
    env.setdefault("TEXMFVAR", str(Path.home() / ".texlive" / "texmf-var"))
    return env


def compile_project(library, id=None, engine="xelatex", timeout_seconds=None, include_archived=False):
    row = _project(library, id, include_archived)
    if engine not in ENGINES:
        raise ValueError(f"引擎必须是 {', '.join(ENGINES)} 之一")
    root = Path(row["root"])
    main = row["main_path"]
    absolute, main = _inside(root, main, "主文件")
    if not absolute.is_file():
        raise ValueError("主文件不存在；请先设置主文件")
    timeout = COMPILE_TIMEOUT if timeout_seconds is None else int(timeout_seconds)
    if not 5 <= timeout <= COMPILE_MAX_TIMEOUT:
        raise ValueError(f"超时必须在 5–{COMPILE_MAX_TIMEOUT} 秒之间")
    command = [_latexmk(), f"-{engine}", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", absolute.name]
    started = datetime.now(timezone.utc)
    try:
        completed = subprocess.run(
            command, cwd=str(root), env=_compile_env(), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=False,
        )
        output = completed.stdout.decode("utf-8", "replace")
        exit_code = completed.returncode
        timed_out = False
    except subprocess.TimeoutExpired as expired:
        output = (expired.stdout or b"").decode("utf-8", "replace")
        exit_code = None
        timed_out = True
    duration_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    pdf_relative = None
    pages = None
    warnings = []
    candidate = root / Path(main).with_suffix(".pdf")
    if candidate.is_file() and candidate.stat().st_mtime >= started.timestamp() - 1:
        pdf_relative = candidate.relative_to(root).as_posix()
        try:
            with library._open_pdf(candidate) as document:
                pages = document.page_count
        except Exception as error:  # A broken output is reported, not hidden.
            warnings.append(f"生成的 PDF 无法读取：{error}")
    elif candidate.is_file():
        pdf_relative = candidate.relative_to(root).as_posix()
        warnings.append("PDF 没有在这次编译中更新")
    if exit_code not in (0, None) and not warnings:
        warnings.append(f"latexmk 退出码 {exit_code}")
    if timed_out:
        warnings.append(f"latexmk 超过 {timeout} 秒未结束，已停止")
    errors = _parse_errors(output)
    if pdf_relative and row["pdf_path"] != pdf_relative:
        library.db.execute("UPDATE latex_projects SET pdf_path=?,modified=? WHERE id=?", (pdf_relative, now(), row["id"]))
        library.db.commit()
    elif pdf_relative:
        library.db.execute("UPDATE latex_projects SET modified=? WHERE id=?", (now(), row["id"]))
        library.db.commit()
    return {
        "id": row["id"],
        "engine": engine,
        "command": " ".join(command),
        "exit_code": exit_code,
        "ok": exit_code == 0 and not timed_out and bool(pdf_relative),
        "timed_out": timed_out,
        "duration_ms": duration_ms,
        "pdf_path": pdf_relative,
        "pages": pages,
        "errors": errors[:40],
        "warnings": warnings,
        "log_tail": output[-LOG_TAIL_CHARACTERS:],
        "log_characters": len(output),
        "limits": {"timeout_seconds": timeout, "log_tail_characters": LOG_TAIL_CHARACTERS},
    }


def _parse_errors(output: str):
    """`-file-line-error` lines are the actionable failures; keep them verbatim."""
    found = []
    for line in output.splitlines():
        if re.match(r"^.+:\d+:\s", line) or line.startswith("! "):
            cleaned = line.strip()
            if cleaned and cleaned not in found:
                found.append(cleaned[:400])
        if len(found) >= 40:
            break
    return found


def _project_pdf(library, row) -> Path:
    root = Path(row["root"])
    if not row["pdf_path"]:
        raise ValueError("这个项目还没有 PDF；请先编译")
    absolute, _ = _inside(root, row["pdf_path"], "PDF 路径")
    if not absolute.is_file():
        raise ValueError("记录的 PDF 不存在；请重新编译")
    return absolute


def pdf_pages(library, id=None, include_archived=False):
    row = _project(library, id, include_archived)
    path = _project_pdf(library, row)
    pages = []
    with library._open_pdf(path) as document:
        for page in document:
            width, height = page.rect.width, page.rect.height
            if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                raise ValueError(f"PDF 第 {page.number + 1} 页尺寸无效")
            pages.append({"page": page.number + 1, "width": width, "height": height, "rotation": page.rotation})
        count = document.page_count
    return {"id": row["id"], "path": row["pdf_path"], "page_count": count, "pages": pages, "coordinate_system": "displayed-pdf-points", "rotation_applied": True, "truncated": False, "limits": {"pages": 2000}}


def pdf_page(library, id=None, page=1, scale=1.25, include_archived=False):
    import pymupdf as fitz
    row = _project(library, id, include_archived)
    path = _project_pdf(library, row)
    try:
        scale = float(scale)
    except (TypeError, ValueError):
        raise ValueError("渲染比例必须是数字")
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("渲染比例必须是正数")
    scale = min(scale, 2.0)
    with library._open_pdf(path) as document:
        current = library._page(document, page)
        width, height = current.rect.width, current.rect.height
        if width <= 0 or height <= 0:
            raise ValueError("页面尺寸无效")
        scale = min(scale, math.sqrt(1_600_000 / (width * height)), 3000 / width, 3000 / height)
        pix = current.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        return {
            "id": row["id"], "path": row["pdf_path"], "page": int(page), "page_count": document.page_count,
            "width": width, "height": height, "scale": scale, "rotation": current.rotation,
            "image": base64.b64encode(pix.tobytes("png")).decode("ascii"),
        }


def clean(library, id=None, include_archived=False):
    """Remove only well-known build side files; sources, PDFs and bibliography stay."""
    row = _project(library, id, include_archived)
    root = Path(row["root"])
    removed, kept = [], []
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRECTORIES]
        for name in filenames:
            full = Path(directory) / name
            suffix = ".synctex.gz" if full.name.lower().endswith(".synctex.gz") else full.suffix.lower()
            if suffix in AUX_SUFFIXES and not full.is_symlink():
                removed.append(full.relative_to(root).as_posix())
                full.unlink()
            elif suffix in {".pdf", ".tex", ".bib"}:
                kept.append(full.relative_to(root).as_posix())
    library.db.execute("UPDATE latex_projects SET modified=? WHERE id=?", (now(), row["id"]))
    library.db.commit()
    return {"id": row["id"], "removed": sorted(removed)[:500], "removed_count": len(removed), "kept": sorted(kept)[:200], "limits": {"listed": 500}}


ACTIONS = {
    "latex_project_create": (create, ("root", "title", "main_path", "create_missing")),
    "latex_project_list": (listing, ("query", "include_archived", "limit", "offset")),
    "latex_project_get": (get, ("id", "include_archived")),
    "latex_project_update": (update, ("id", "title", "main_path", "include_archived")),
    "latex_project_archive": (archive, ("id",)),
    "latex_project_restore": (restore, ("id",)),
    "latex_tree": (tree, ("id", "include_archived")),
    "latex_read": (read, ("id", "path", "include_archived")),
    "latex_write": (write, ("id", "path", "content", "expected_revision", "origin", "include_archived")),
    "latex_compile": (compile_project, ("id", "engine", "timeout_seconds", "include_archived")),
    "latex_pdf_pages": (pdf_pages, ("id", "include_archived")),
    "latex_pdf_page": (pdf_page, ("id", "page", "scale", "include_archived")),
    "latex_history": (history, ("id", "path", "limit", "include_archived")),
    "latex_diff": (diff, ("id", "path", "from_revision", "to_revision", "include_archived")),
    "latex_compare": (compare, ("a", "b", "path", "include_archived")),
    "latex_clean": (clean, ("id", "include_archived")),
}


def dispatch(library, request):
    action = request.get("action")
    handler = ACTIONS.get(action)
    if handler is None:
        raise ValueError("Unknown LaTeX action")
    function, keys = handler
    return function(library, **{key: request[key] for key in keys if key in request})
