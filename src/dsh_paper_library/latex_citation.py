"""Read a manuscript's local bibliography and append one catalog citation."""
from collections import deque
import hashlib
import json
from pathlib import Path, PureWindowsPath
import re

from filelock import FileLock, Timeout

from .latex_lint import _tex

MAX_SOURCES = 100
MAX_BIB_FILES = 24
MAX_BYTES = 6 * 1024 * 1024
TERM_LIMIT = 18
KEY = re.compile(r"[^\s,{}\\%#\"'=()\[\]]{1,160}")


def search(library, query=""):
    if not isinstance(query, str) or len(query) > 160:
        raise ValueError("引用检索词最多 160 字符。")
    query = query.strip()
    ids = []
    if query:
        prefix = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        rows = library.db.execute(
            "SELECT papers.id FROM papers LEFT JOIN paper_archive ON paper_id=papers.id "
            "WHERE paper_id IS NULL AND citekey LIKE ? ESCAPE '\\' "
            "ORDER BY (citekey = ? COLLATE NOCASE) DESC, length(citekey), citekey LIMIT ?",
            (prefix, query, TERM_LIMIT),
        )
        ids = [row["id"] for row in rows]
    records = {paper_id: library.get(paper_id) for paper_id in ids}
    if len(records) < TERM_LIMIT:
        for item in library.list(query=query, limit=TERM_LIMIT)["items"]:
            records.setdefault(item["id"], item)
    items = []
    for item in records.values():
        if not KEY.fullmatch(item.get("citekey") or ""):
            continue
        authors = [" ".join(part for part in (person.get("given"), person.get("family")) if part)
                   or person.get("literal", "") for person in (item.get("author") or [])[:3]]
        issued = (item.get("issued") or {}).get("date-parts") or [[]]
        year = issued[0][0] if issued[0] else None
        items.append({"id": item["id"], "citekey": item["citekey"], "title": item.get("title", "")[:260],
                      "authors": [name[:100] for name in authors if name], "year": year})
        if len(items) == TERM_LIMIT:
            break
    return {"items": items}


def _read(path, maximum):
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("项目书目或源码超过可核对的读取范围。")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("项目书目或源码不是 UTF-8。") from exc


def _resource(root, base, name, suffix):
    from .latex import _inside

    if (not name or any(char in name for char in "\\#${}\x00") or "://" in name or
            Path(name).is_absolute() or PureWindowsPath(name).drive):
        raise ValueError("当前主文件引用了无法自动核对的非本地或动态书目／源码。")
    name = Path(name)
    if not name.suffix:
        name = name.with_suffix(suffix)
    if name.suffix.lower() != suffix:
        raise ValueError("当前主文件引用了无法自动核对的书目或源码格式。")
    return _inside(root, (base / name).as_posix())


def _fingerprint(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def sources(library, id):
    from .latex import MAX_FILE_BYTES, _inside, _project

    row = _project(library, id)
    root = Path(row["root"])
    _, main = _inside(root, row["main_path"], "编译主文件")
    base = Path(main).parent
    pending, seen, declarations, changes = deque([main]), {main}, {}, []
    remaining = MAX_BYTES
    while pending:
        relative = pending.popleft()
        path, _ = _inside(root, relative)
        if not path.is_file():
            raise ValueError(f"未找到主文件引用的源码「{relative}」。")
        body = _read(path, min(remaining, MAX_FILE_BYTES))
        remaining -= len(body.encode("utf-8"))
        changes.append((relative, _fingerprint(body)))
        _, dependencies, problems, _ = _tex(body.removeprefix("\ufeff"))
        if problems:
            raise ValueError(f"无法完整核对「{relative}」中的 LaTeX 文件引用。")
        for _, command, value in dependencies:
            if command in ("input", "include"):
                _, child = _resource(root, base, value, ".tex")
                if child not in seen:
                    seen.add(child)
                    if len(seen) > MAX_SOURCES:
                        raise ValueError("主文件的源码引用数量超出可核对的范围。")
                    pending.append(child)
                continue
            for name in value.split(",") if command == "bibliography" else [value]:
                _, bib = _resource(root, base, name.strip(), ".bib")
                declarations.setdefault(bib, "bibtex" if command == "bibliography" else "biblatex")
                if command == "addbibresource":
                    declarations[bib] = "biblatex"
                if len(declarations) > MAX_BIB_FILES:
                    raise ValueError("主文件引用的书目文件过多，无法完整核对引用键。")

    resources = []
    for path, format in (declarations or {(base / "references.bib").as_posix(): "biblatex"}).items():
        absolute, _ = _inside(root, path, "书目文件")
        exists = absolute.exists()
        if exists and not absolute.is_file():
            raise ValueError(f"书目「{path}」不是普通文件。")
        text = _read(absolute, min(remaining, MAX_FILE_BYTES)) if exists else ""
        remaining -= len(text.encode("utf-8"))
        changes.append((path, _fingerprint(text) if exists else None))
        resources.append({"path": path, "format": format, "text": text, "revision": _fingerprint(text) if exists else "",
                          "resource": Path(path).relative_to(base).as_posix() if Path(path).is_relative_to(base) else None})
    # Include the declared resource type and all files needed for the duplicate check.
    version = _fingerprint(json.dumps([row["binding_generation"], changes, declarations], ensure_ascii=False))
    return {"resources": resources, "version": version, "linked": bool(declarations)}


class CitationChanged(ValueError):
    code = "LATEX_CITATION_CHANGED"


def append(library, id, path, version, entry, citekey):
    from .latex import MAX_FILE_BYTES, _inside, _project, write

    if (not isinstance(entry, str) or not isinstance(citekey, str) or not KEY.fullmatch(citekey)
            or len(entry.encode("utf-8")) > 64 * 1024 or "\x00" in entry
            or not re.match(r"^@[A-Za-z]+\{\s*" + re.escape(citekey) + r"\s*,", entry)):
        raise ValueError("引用条目与所选的 Paper Library 引用键不匹配。")
    row = _project(library, id)
    root = Path(row["root"])
    absolute, path = _inside(root, path, "书目文件")
    lock = library.root / (".latex-bib-" + _fingerprint(str(absolute)) + ".lock")
    try:
        with FileLock(lock, timeout=4, mode=0o600, fallback_to_soft=False, preserve_lock_file=True):
            snapshot = sources(library, id)
            if snapshot["version"] != version:
                raise CitationChanged("项目书目已变化，请重新选择文献后再插入。")
            target = next((item for item in snapshot["resources"] if item["path"] == path), None)
            if target is None or absolute.suffix.lower() != ".bib":
                raise ValueError("目标书目不属于当前编译主文件。")
            if not absolute.parent.is_dir():
                raise ValueError(f"书目「{path}」的上级目录不存在。")
            text = target["text"]
            line = "\r\n" if "\r\n" in text else "\r" if "\r" in text and "\n" not in text else "\n"
            separator = (line if text.endswith(("\n", "\r")) else line * 2) if text else ""
            body = text + separator + entry.strip().replace("\n", line) + line
            if len(body.encode("utf-8")) > MAX_FILE_BYTES:
                raise ValueError("追加之后的书目超过项目编辑范围。请选择另一份书目。")
            write(library, id, path, body, target["revision"], "paper-library-citation", preserve_newlines=True)
    except Timeout as exc:
        raise ValueError("项目书目正在写入，请稍后重试。") from exc
    return {"path": path, "citekey": citekey, "added": True, "created": not target["revision"], "linked": snapshot["linked"],
            "resource": target["resource"]}
