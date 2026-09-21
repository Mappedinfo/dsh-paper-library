"""Index PDF corpora that another tool syncs, by staging symlinks instead of copies.

A synced corpus (for example the folders a backup/sync service keeps in step across
machines) already contains the files. This module gives the library one address for
them: every indexed PDF appears as a symlink under `<library>/external/<source>/…`,
so the reader, the analysis pipeline and a file manager all open the same tree, and
nothing is copied until the user actually annotates a paper.

Boundaries that keep this honest and cheap:

- The library never writes through a staged link. The first write to an external
  paper copies it into `pdfs/` first, and only then edits the managed copy, so a
  synced source directory is never modified.
- A scan is explicit and bounded: it reads directory entries and file stats, never
  PDF contents and never a hash of every file. Unchanged files are skipped from a
  size/mtime record, so a second scan of a large corpus is a walk plus lookups.
- Disappeared files are flagged, not deleted: the catalog record, its annotations
  and its graph survive, and the link is restored when the file comes back.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat as stat_module
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

MAX_SOURCES = 8
MAX_INDEX_PER_RUN = 2000
DEFAULT_INDEX_PER_RUN = 200
MAX_WALK_ENTRIES = 200000
MAX_RELATIVE_DEPTH = 12
MAX_TITLE = 500
MAX_AUTHOR = 200
SOURCE_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
SKIP_DIRECTORIES = {".git", ".svn", ".hg", ".obsidian", ".trash", ".Trash", ".stversions", ".research-cache", "node_modules", "__pycache__", ".venv", "site-packages"}
STAGED_DIRECTORY = "external"
SYNC_TAG = "外部同步"
INSTRUCTIONS = """# 外部文献源（由插件维护）

这个目录里的条目全部是**符号链接**，指向另一个数据同步服务维护的 PDF 目录。
插件不会复制、移动或修改这些 PDF；删掉这里的一个链接只影响本插件的索引，
不会影响源目录里的原文件。

- 源目录保持只读：第一次给某篇论文写批注时，插件才把该 PDF 复制到 `../pdfs/`，
  之后所有写入都落在复制件上。
- 备份／同步服务应当跳过这个目录：其中的链接不是独立文件，跟随链接会重复上传
  几千个 PDF。常见的同步工具默认不跟随符号链接，因此这里通常不需要额外配置。
- 这个目录可以整个删除；下一次「扫描外部文献源」会重建它。

本文件由插件自动生成，手工修改会在下次扫描时被覆盖。
"""


def _now():
    return datetime.now(timezone.utc).isoformat()


def _clamp(value, default, maximum):
    return max(1, min(int(default if value is None else value), maximum))


def normalize_sources(raw):
    """Validate deployment-supplied external sources; request JSON never invents roots."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("sources must be an array")
    if len(raw) > MAX_SOURCES:
        raise ValueError(f"at most {MAX_SOURCES} external sources are supported")
    out, ids, roots = [], set(), set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("each external source must be an object")
        identifier = str(entry.get("id") or "").strip().lower()
        if not SOURCE_ID.fullmatch(identifier):
            raise ValueError("external source id must be lowercase letters, digits, dot, dash or underscore")
        if identifier in ids:
            raise ValueError(f"duplicate external source id {identifier!r}")
        root = entry.get("root")
        if not isinstance(root, str) or not root.strip():
            raise ValueError("external source root must be a non-empty path")
        resolved = Path(root).expanduser()
        if not resolved.is_absolute():
            raise ValueError("external source root must be absolute")
        resolved = Path(os.path.normpath(str(resolved)))
        if str(resolved) in roots:
            raise ValueError(f"two external sources point at {resolved}")
        label = entry.get("label")
        if label is not None and (not isinstance(label, str) or not label.strip() or len(label) > 200):
            raise ValueError("external source label must be text of at most 200 characters")
        ids.add(identifier)
        roots.add(str(resolved))
        out.append({"id": identifier, "root": resolved, "label": (label or "").strip() or identifier})
    return out


def _check_roots(library, sources):
    staged = library.root / STAGED_DIRECTORY
    for source in sources:
        root = source["root"]
        if root == library.root or root.is_relative_to(library.root):
            raise ValueError(f"external source {source['id']!r} is inside the managed library; choose the synced directory itself")
        if staged == root or staged.is_relative_to(root):
            raise ValueError(f"external source {source['id']!r} contains the library's staged directory")
    return sources


def staged_root(library):
    return library.root / STAGED_DIRECTORY


def staged_path(library, source_id, relative):
    """The staged link for one file; refuses anything that could escape the tree."""
    root = staged_root(library) / source_id
    path = Path(os.path.normpath(str(root / relative)))
    if not path.is_relative_to(root) or path == root:
        raise ValueError("external relative path escapes its staged directory")
    return path


def is_external_path(library, value):
    """True for a catalog path that points into the staged (symlink) tree."""
    if not value:
        return False
    return Path(os.path.normpath(str(library.root / value))).is_relative_to(staged_root(library))


def parse_filename(stem):
    """Read the evidence a filename carries. Never invents an author or a date."""
    text = re.sub(r"\s+", " ", str(stem)).strip()
    authors, year, title = "", None, text
    parts = [part.strip() for part in text.split(" - ") if part.strip()]
    if len(parts) >= 3 and re.fullmatch(r"\d{4}", parts[1]):
        authors, year, title = parts[0], int(parts[1]), " - ".join(parts[2:])
    elif len(parts) >= 2 and re.fullmatch(r"\d{4}", parts[0]):
        year, title = int(parts[0]), " - ".join(parts[1:])
    elif len(parts) >= 3:
        authors, title = parts[0], " - ".join(parts[2:])
    elif len(parts) == 2:
        authors, title = parts[0], parts[1]
    else:
        for pattern in (r"\((?:19|20)\d{2}\)", r"\b(?:19|20)\d{2}\b"):
            match = re.search(pattern, text)
            if match:
                year = int(re.search(r"(?:19|20)\d{2}", match.group()).group())
                title = (text[:match.start()] + " " + text[match.end():]).strip(" -_")
                break
    fields = {}
    title = re.sub(r"[\s_-]+$", "", title).strip() or text
    if title:
        fields["title"] = title[:MAX_TITLE]
    cleaned = re.sub(r"\s*(?:等|et\s+al\.?)$", "", authors, flags=re.I).strip()
    if cleaned and cleaned.casefold() != fields.get("title", "").casefold():
        people = []
        for name in re.split(r"\s*(?:和|与|&|;|\band\b)\s*", cleaned):
            name = name.strip(" ,;")
            if not name or len(name) > MAX_AUTHOR:
                continue
            if "," in name:
                family, _, given = name.partition(",")
                entry = {key: value.strip() for key, value in (("family", family), ("given", given)) if value.strip()}
            else:
                entry = {"family": name}
            if entry:
                people.append(entry)
        if people:
            fields["author"] = people[:32]
    if year and 1000 <= year <= 2999:
        fields["issued"] = {"date-parts": [[year]]}
    return fields


def _depth(relative):
    return relative.count(os.sep) + 1


def _record(library, source_id, relative):
    return library.db.execute("SELECT * FROM external_files WHERE source=? AND relative=?", (source_id, relative)).fetchone()


def _known(library, source_id):
    return {row["relative"]: row for row in library.db.execute("SELECT * FROM external_files WHERE source=?", (source_id,)).fetchall()}


def _write_link(library, source_id, relative, target):
    """Create or refresh one staged symlink; never replaces an unexpected regular file."""
    link = staged_path(library, source_id, relative)
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        if os.readlink(link) == str(target):
            return link
        os.unlink(link)
    elif link.exists():
        raise ValueError(f"staged path already holds a regular file: {link.name}")
    temporary = link.parent / (".link-" + os.urandom(6).hex())
    try:
        os.symlink(str(target), temporary)
        os.replace(temporary, link)
    finally:
        if temporary.is_symlink():
            temporary.unlink(missing_ok=True)
    return link


def _drop_link(library, source_id, relative):
    link = staged_path(library, source_id, relative)
    if link.is_symlink():
        os.unlink(link)
    return link


def _item(source, relative, details, fields):
    author = fields.get("author") or []
    item = {"title": fields.get("title") or Path(relative).stem, "citekey": "ext-" + source["id"] + "-" + _digest(relative), "type": "article", "tags": [SYNC_TAG]}
    if author:
        item["author"] = author
    if fields.get("issued"):
        item["issued"] = fields["issued"]
    field_sources = {"title": "synced-filename"}
    if author:
        field_sources["author"] = "synced-filename"
    if fields.get("issued"):
        field_sources["issued"] = "synced-filename"
    item["parse"] = {
        "status": "external-index",
        "source": "synced-directory",
        "needs_review": True,
        "field_sources": field_sources,
        "warnings": ["Metadata was read from the synced filename; open the paper and complete it before citing"],
        "limits": {"pdf_opened": False, "hash_computed": False},
    }
    item["external_source"] = {
        "id": source["id"],
        "label": source["label"],
        "root": str(source["root"]),
        "relative": relative,
        "staged": f"{STAGED_DIRECTORY}/{source['id']}/{relative}",
        "size": details.st_size,
        "mtime_ns": details.st_mtime_ns,
        "synced": True,
    }
    item["provenance"] = {"source": "external-index", "imported": _now()}
    return item


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _insert(library, source, relative, details, fields):
    item = _item(source, relative, details, fields)
    paper_id = uuid.uuid4().hex
    stamp = _now()
    with library.lock():
        library.db.execute(
            "INSERT INTO papers VALUES(?,?,?,?,?,?,?,?)",
            (paper_id, json.dumps(item, ensure_ascii=False), item["title"], None, item["citekey"], item["external_source"]["staged"], stamp, stamp),
        )
    return paper_id


def _update(library, paper_id, source, relative, details, fields):
    """Refresh filename-derived metadata without demoting an already promoted copy."""
    with library.lock():
        row = library.db.execute("SELECT pdf_path,metadata FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            return None
        value = json.loads(row["metadata"])
        for key in ("title", "author", "issued"):
            if fields.get(key):
                value[key] = fields[key]
        external = _item(source, relative, details, fields)["external_source"]
        if is_external_path(library, row["pdf_path"]):
            value["external_source"] = external
            pdf_path = external["staged"]
        else:
            external["promoted"] = external.get("promoted") or "managed-copy-kept"
            value["external_source"] = external
            pdf_path = row["pdf_path"]
        parse = dict(value.get("parse") or {})
        sources = dict(parse.get("field_sources") or {})
        for key in ("title", "author", "issued"):
            if fields.get(key):
                sources.setdefault(key, "synced-filename")
        parse["field_sources"] = sources
        parse.setdefault("status", "external-index")
        value["parse"] = parse
        library.db.execute(
            "UPDATE papers SET metadata=?,title=?,pdf_path=?,modified=? WHERE id=?",
            (json.dumps(value, ensure_ascii=False), value["title"], pdf_path, _now(), paper_id),
        )
    return paper_id


def _mark_missing(library, source_id, relative):
    record = _record(library, source_id, relative)
    _drop_link(library, source_id, relative)
    library.db.execute("UPDATE external_files SET missing=1,updated=? WHERE source=? AND relative=?", (_now(), source_id, relative))
    paper_id = record["paper_id"] if record else None
    if not paper_id:
        return
    row = library.db.execute("SELECT metadata FROM papers WHERE id=?", (paper_id,)).fetchone()
    if not row:
        return
    value = json.loads(row["metadata"])
    external = value.get("external_source")
    if isinstance(external, dict):
        external["missing"] = True
        library.db.execute("UPDATE papers SET metadata=?,modified=? WHERE id=?", (json.dumps(value, ensure_ascii=False), _now(), paper_id))


def _remember(library, source_id, relative, paper_id, details):
    library.db.execute(
        "INSERT INTO external_files(source,relative,paper_id,size,mtime_ns,missing,updated,parent,name) VALUES(?,?,?,?,?,0,?,?,?) "
        "ON CONFLICT(source,relative) DO UPDATE SET paper_id=excluded.paper_id,size=excluded.size,mtime_ns=excluded.mtime_ns,missing=0,updated=excluded.updated,parent=excluded.parent,name=excluded.name",
        (source_id, relative, paper_id, details.st_size, details.st_mtime_ns, _now(), os.path.dirname(relative), os.path.basename(relative)),
    )


def _forget(library, source_id, relative):
    library.db.execute("DELETE FROM external_files WHERE source=? AND relative=?", (source_id, relative))


def _rename_candidate(library, source, relative, details):
    """One disappeared file of the same size and name is a rename, not a new paper."""
    rows = library.db.execute(
        "SELECT * FROM external_files WHERE source=? AND parent=? AND size=? AND relative<>? LIMIT 8",
        (source["id"], os.path.dirname(relative), details.st_size, relative),
    ).fetchall()
    candidates = [
        row for row in rows
        if not (source["root"] / row["relative"]).exists()
        and row["paper_id"]
        and library.db.execute("SELECT 1 FROM papers WHERE id=?", (row["paper_id"],)).fetchone()
    ]
    return candidates[0] if len(candidates) == 1 else None


def scan(library, request):
    sources = _check_roots(library, normalize_sources(request.get("sources")))
    only = request.get("source")
    if only is not None and only not in {source["id"] for source in sources}:
        raise ValueError("unknown external source")
    limit = _clamp(request.get("limit"), DEFAULT_INDEX_PER_RUN, MAX_INDEX_PER_RUN)
    staged_root(library).mkdir(parents=True, exist_ok=True)
    instructions = staged_root(library) / "README.md"
    if not instructions.exists() or instructions.read_text(encoding="utf-8") != INSTRUCTIONS:
        instructions.write_text(INSTRUCTIONS, encoding="utf-8")
    os.chmod(instructions, 0o600)
    reports = [_scan_source(library, source, limit) for source in sources if not only or source["id"] == only]
    library.db.commit()
    return {"sources": reports, "staged_root": str(staged_root(library))}


def _walk(source, report):
    """One bounded walk: the file list and its stats, with no catalog work yet."""
    found, entry_budget, stop_walk = {}, MAX_WALK_ENTRIES, False
    for directory, dirnames, filenames in os.walk(source["root"], followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRECTORIES and not name.startswith("."))
        for name in sorted(filenames):
            if not name.lower().endswith(".pdf"):
                continue
            if entry_budget <= 0:
                report["truncated"] = stop_walk = True
                break
            entry_budget -= 1
            full = Path(directory) / name
            relative = str(full.relative_to(source["root"]))
            if _depth(relative) > MAX_RELATIVE_DEPTH:
                continue
            try:
                details = os.stat(full, follow_symlinks=False)
            except OSError as error:
                report["failures"].append(f"{relative}: {error.strerror or error}")
                continue
            if not stat_module.S_ISREG(details.st_mode):
                continue  # A staged link or a directory-shaped entry is not a source file.
            report["walked"] += 1
            found[relative] = (full, details)
        if stop_walk:
            break
    return found


def _disappeared(known, found):
    """Rows whose file is gone, grouped by the directory and size a rename would keep."""
    gone, places = {}, {}
    for relative, row in known.items():
        if relative in found or row["missing"]:
            continue
        gone[relative] = row
        key = (row["parent"] if row["parent"] is not None else os.path.dirname(relative), row["size"])
        places.setdefault(key, []).append(row)
    return gone, places


def _scan_source(library, source, limit):
    known = _known(library, source["id"])
    report = {"id": source["id"], "root": str(source["root"]), "exists": source["root"].is_dir(), "indexed": 0, "refreshed": 0, "renamed": 0, "skipped": 0, "missing": 0, "walked": 0, "failures": [], "truncated": False, "pending": 0}
    if not report["exists"]:
        report["failures"].append("source directory is not readable")
        return report
    found = _walk(source, report)
    gone, places = _disappeared(known, found)
    budget = limit
    for relative in sorted(found):
        full, details = found[relative]
        row = known.get(relative)
        link = staged_path(library, source["id"], relative)
        if row and not row["missing"] and row["size"] == details.st_size and row["mtime_ns"] == details.st_mtime_ns and link.is_symlink() and os.readlink(link) == str(full):
            report["skipped"] += 1
            continue
        if budget <= 0:
            report["pending"] += 1
            report["truncated"] = True
            continue
        budget -= 1
        try:
            _index_one(library, source, relative, full, details, row, places, gone, report)
        except (OSError, ValueError) as error:
            report["failures"].append(f"{relative}: {error}")
    for relative in sorted(gone):
        # A row consumed by a rename is gone from `gone`; the rest are genuinely missing.
        if relative in gone:
            _mark_missing(library, source["id"], relative)
            report["missing"] += 1
    library.db.execute(
        "INSERT INTO external_sources(id,root,label,scanned_at,files,indexed) VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET root=excluded.root,label=excluded.label,scanned_at=excluded.scanned_at,files=excluded.files,indexed=excluded.indexed",
        (source["id"], str(source["root"]), source["label"], _now(), report["walked"], report["indexed"] + report["refreshed"] + report["renamed"]),
    )
    return report


def _take_rename(library, source, relative, details, places, gone):
    """One disappeared file of the same size in the same directory is a rename."""
    key = (os.path.dirname(relative), details.st_size)
    candidates = [row for row in places.get(key, []) if row["relative"] in gone and row["paper_id"] and library.db.execute("SELECT 1 FROM papers WHERE id=?", (row["paper_id"],)).fetchone()]
    if len(candidates) != 1:
        return None
    row = candidates[0]
    moved = gone.pop(row["relative"], None)
    if moved is not None:
        places[key].remove(row)
    return row


def _index_one(library, source, relative, full, details, row, places, gone, report):
    fields = parse_filename(Path(relative).stem)
    if row:
        _write_link(library, source["id"], relative, full)
        library.db.execute("UPDATE external_files SET size=?,mtime_ns=?,missing=0,updated=?,parent=?,name=? WHERE source=? AND relative=?", (details.st_size, details.st_mtime_ns, _now(), os.path.dirname(relative), os.path.basename(relative), source["id"], relative))
        if row["paper_id"]:
            _update(library, row["paper_id"], source, relative, details, fields)
        report["refreshed"] += 1
        return
    moved = _take_rename(library, source, relative, details, places, gone)
    if moved:
        _drop_link(library, source["id"], moved["relative"])
        _write_link(library, source["id"], relative, full)
        _forget(library, source["id"], moved["relative"])
        _remember(library, source["id"], relative, moved["paper_id"], details)
        if moved["paper_id"]:
            _update(library, moved["paper_id"], source, relative, details, fields)
        report["renamed"] += 1
        return
    _write_link(library, source["id"], relative, full)
    paper_id = _insert(library, source, relative, details, fields)
    _remember(library, source["id"], relative, paper_id, details)
    report["indexed"] += 1


def status(library, request):
    sources = _check_roots(library, normalize_sources(request.get("sources")))
    counts = {row["source"]: row for row in library.db.execute("SELECT source,count(*) AS files,sum(missing) AS missing FROM external_files GROUP BY source").fetchall()}
    records = {row["id"]: row for row in library.db.execute("SELECT * FROM external_sources").fetchall()}
    staged = staged_root(library)
    return {
        "staged_root": str(staged),
        "staged_present": staged.is_dir(),
        "sources": [
            {
                "id": source["id"],
                "label": source["label"],
                "root": str(source["root"]),
                "exists": source["root"].is_dir(),
                "indexed": int(counts[source["id"]]["files"]) if source["id"] in counts else 0,
                "missing": int(counts[source["id"]]["missing"] or 0) if source["id"] in counts else 0,
                "scanned_at": records[source["id"]]["scanned_at"] if source["id"] in records else None,
            }
            for source in sources
        ],
    }


def prune(library, request):
    """Drop stale links for a source; catalog records and their work stay."""
    sources = _check_roots(library, normalize_sources(request.get("sources")))
    source_id = request.get("source")
    if not isinstance(source_id, str) or source_id not in {source["id"] for source in sources}:
        raise ValueError("unknown external source")
    removed = 0
    for row in library.db.execute("SELECT relative FROM external_files WHERE source=? AND missing=1", (source_id,)).fetchall():
        _drop_link(library, source_id, row["relative"])
        removed += 1
    directory = staged_root(library) / source_id
    if directory.is_dir():
        for path in sorted(directory.rglob("*"), key=lambda value: len(value.parts), reverse=True):
            if path.is_dir() and not any(path.iterdir()):
                path.rmdir()
    library.db.commit()
    return {"id": source_id, "removed": removed}


def promote(library, paper_id):
    """Copy a staged external PDF into the managed tree before the first write."""
    row = library.db.execute("SELECT pdf_path,metadata FROM papers WHERE id=?", (paper_id,)).fetchone()
    if not row:
        raise ValueError("Paper not found")
    if not row["pdf_path"] or not is_external_path(library, row["pdf_path"]):
        return library.pdf_path(paper_id)
    link = library.root / row["pdf_path"]
    if not link.is_symlink() or not link.is_file():
        raise ValueError("Synced PDF is missing; restore it in the source directory, then rescan")
    value = json.loads(row["metadata"])
    from .core import managed_filename
    destination = library.root / "pdfs" / managed_filename(value, paper_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and library.db.execute("SELECT 1 FROM papers WHERE pdf_path=? AND id<>?", (str(destination.relative_to(library.root)), paper_id)).fetchone():
        destination = library.root / "pdfs" / managed_filename(value, paper_id, full_id=True)
    size = os.stat(link).st_size
    if destination.exists() and destination.stat().st_size != size:
        raise ValueError("A different managed PDF already occupies the promoted name; rename it before promoting")
    descriptor, temporary = tempfile.mkstemp(prefix=".promote-", suffix=".pdf", dir=destination.parent)
    os.close(descriptor)
    try:
        with open(link, "rb") as source_handle, open(temporary, "wb") as target_handle:
            shutil.copyfileobj(source_handle, target_handle, 1024 * 1024)
            target_handle.flush()
            os.fsync(target_handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        with open(destination, "rb") as verify:
            if verify.read(5) != b"%PDF-":
                raise ValueError("Synced PDF is not a PDF document")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    external = value.get("external_source")
    if isinstance(external, dict):
        external["promoted"] = _now()
        external["promoted_path"] = str(destination.relative_to(library.root))
    if isinstance(external, dict) and _record(library, external["id"], external["relative"]) is not None:
        _drop_link(library, external["id"], external["relative"])
    library.db.execute("UPDATE papers SET pdf_path=?,metadata=?,modified=? WHERE id=?", (str(destination.relative_to(library.root)), json.dumps(value, ensure_ascii=False), _now(), paper_id))
    library.db.commit()
    return destination


def dispatch(library, request):
    action = request.get("action")
    if action == "external_status":
        return status(library, request)
    if action == "external_scan":
        return scan(library, request)
    if action == "external_prune":
        return prune(library, request)
    if action == "external_promote":
        paper_id = request.get("id")
        if not isinstance(paper_id, str) or not paper_id:
            raise ValueError("id must be a paper id")
        path = promote(library, paper_id)
        return {"id": paper_id, "path": str(path), "managed": True}
    raise ValueError("Unknown external action")
