"""Immutable manual-build versions shared by the manuscript and reading project.

Each version is committed only after all bounded files have been copied. Original
sources, compiled PDFs and per-build review PDFs remain authoritative and untouched.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import uuid

MAX_SOURCES = 300
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_SOURCE_FILE = 1024 * 1024
VERSION_ID = re.compile(r"^lv-[a-f0-9]{32}$")
_MISSING = object()


def capture_sources(library, row):
    from .latex import _inside, tree
    scan = tree(library, row["id"])
    if scan["truncated"]:
        raise ValueError("项目文件列表达到上限，无法保存完整源码版本")
    sources, size = {}, 0
    for item in scan["files"]:
        if item["kind"] != "text":
            continue
        if len(sources) >= MAX_SOURCES or item["bytes"] > MAX_SOURCE_FILE:
            raise ValueError("源码版本超过文件数量或单文件大小上限")
        path, relative = _inside(Path(row["root"]), item["path"])
        body = path.read_bytes()
        size += len(body)
        if len(body) > MAX_SOURCE_FILE or size > MAX_SOURCE_BYTES:
            raise ValueError("源码版本超过大小上限")
        sources[relative] = body
    if row["main_path"] not in sources:
        raise ValueError("主文件不在版本源码中")
    return sources


def _base(library, create=False):
    path = library.root / "latex-versions"
    if path.is_symlink():
        raise ValueError("版本目录不能是符号链接")
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    elif not path.is_dir():
        raise ValueError("版本目录不存在")
    return path


def _id(value):
    if not isinstance(value, str) or not VERSION_ID.fullmatch(value):
        raise ValueError("版本标识无效")
    return value


def link(library, id=None, reading_project_id=_MISSING):
    from .latex import _project, _row
    from .projects import _identifier, _project as reading_project
    row = _project(library, id)
    if reading_project_id is _MISSING:
        raise ValueError("必须明确指定阅读项目标识，或传 null 解除关联")
    with library.lock():
        if reading_project_id is None:
            library.db.execute("DELETE FROM latex_project_reading WHERE project_id=?", (row["id"],))
        else:
            reading_project_id = _identifier(reading_project_id, "阅读项目标识")
            reading_project(library, reading_project_id)
            library.db.execute("INSERT INTO latex_project_reading VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET reading_project_id=excluded.reading_project_id", (row["id"], reading_project_id))
            # Existing builds are the same records in the newly selected project.
            library.db.execute("UPDATE latex_versions SET reading_project_id=? WHERE project_id=?", (reading_project_id, row["id"]))
    return {"id": row["id"], "reading_project_id": reading_project_id, "project": _row(_project(library, id), library)}


def create(library, row, engine, before):
    from .latex import _project, _project_pdf, now
    from .latex_review import directory, file_digest, listing, preview_path, HEX, MAX_PDF_BYTES
    from .projects import MAX_PROJECTS, _project as reading_project
    version_id = "lv-" + uuid.uuid4().hex
    final = _base(library, create=True) / version_id
    stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=final.parent))
    moved = False
    committed = False
    try:
        with library.lock():
            def copy_pdf(source, destination):
                expected = file_digest(source)
                shutil.copyfile(source, destination)
                if file_digest(source) != expected or file_digest(destination) != expected:
                    raise ValueError("PDF 审阅副本在保存期间改变；未保存版本")
                with library._open_pdf(destination):
                    pass

            current = _project(library, row["id"])
            if current["main_path"] != row["main_path"]:
                raise ValueError("主入口已改变；未保存版本")
            if capture_sources(library, current) != before:
                raise ValueError("源码在编译期间改变；未保存版本")
            original = _project_pdf(library, current)
            pdf_hash = file_digest(original)
            notes = listing(library, current["id"])
            if notes["truncated"]:
                raise ValueError("自审记录超过读取上限；未保存不完整版本")
            preview = preview_path(library, current, original, pdf_hash)
            copy_pdf(preview, stage / "preview.pdf")
            if file_digest(original) != pdf_hash:
                raise ValueError("编译 PDF 在保存期间改变；未保存版本")
            source_root = stage / "sources"
            source_root.mkdir(mode=0o700)
            for relative, body in before.items():
                target = source_root / relative
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.write_bytes(body)
            review_dir = directory(library, current)
            review_pdfs, total = [], 0
            for path in sorted(review_dir.glob("*.pdf")) if review_dir.is_dir() else []:
                if not HEX.fullmatch(path.stem):
                    continue
                if path.is_symlink() or not path.is_file():
                    raise ValueError("审阅副本不安全；未保存版本")
                total += path.stat().st_size
                if total > MAX_PDF_BYTES:
                    raise ValueError("审阅副本超过版本保存预算")
                destination = stage / "review" / path.name
                destination.parent.mkdir(mode=0o700, exist_ok=True)
                copy_pdf(path, destination)
                review_pdfs.append({"pdf_version": path.stem, "current": path.stem == pdf_hash})
            review_json = json.dumps(notes, ensure_ascii=False)
            if len(review_json.encode("utf-8")) > 8 * 1024 * 1024:
                raise ValueError("自审记录超过版本保存预算")
            (stage / "review.json").write_text(review_json, encoding="utf-8")
            if capture_sources(library, current) != before or file_digest(original) != pdf_hash:
                raise ValueError("源码或 PDF 在保存期间改变；未保存版本")
            existing = library.db.execute("SELECT reading_project_id FROM latex_project_reading WHERE project_id=?", (current["id"],)).fetchone()
            if existing:
                reading_id = existing[0]
                reading_project(library, reading_id)
            else:
                count = library.db.execute("SELECT count(*) FROM projects WHERE id NOT IN (SELECT project_id FROM project_archive)").fetchone()[0]
                if count >= MAX_PROJECTS:
                    raise ValueError("阅读项目已达数量上限，无法关联版本")
                reading_id = "p-" + uuid.uuid4().hex[:12]
                stamp = now()
                library.db.execute("INSERT INTO projects(id,title,description,tags,created,modified) VALUES(?,?,?,?,?,?)", (reading_id, current["title"], "", "", stamp, stamp))
                library.db.execute("INSERT INTO latex_project_reading VALUES(?,?)", (current["id"], reading_id))
            stamp = now()
            metadata = {"project_title": current["title"], "source_count": len(before), "sources": [{"path": path, "bytes": len(body)} for path, body in sorted(before.items())],
                        "review_count": len(notes["annotations"]), "review_pdfs": review_pdfs,
                        "stale_review_count": sum(bool(note.get("stale")) for note in notes["annotations"]),
                        "current_pdf_annotated": preview != original}
            os.replace(stage, final)
            moved = True
            library.db.execute("INSERT INTO latex_versions(id,project_id,reading_project_id,main_path,created,engine,pdf_version,metadata) VALUES(?,?,?,?,?,?,?,?)",
                               (version_id, current["id"], reading_id, current["main_path"], stamp, engine, pdf_hash, json.dumps(metadata, ensure_ascii=False)))
        committed = True
        return get(library, version_id)["version"]
    except Exception:
        if moved and not committed and final.is_dir() and not final.is_symlink():
            shutil.rmtree(final)
        raise
    finally:
        if stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)


def _version(row, full=False):
    metadata = json.loads(row["metadata"])
    if not full:
        metadata.pop("sources", None)
    return {"id": row["id"], "project_id": row["project_id"], "reading_project_id": row["reading_project_id"],
            "main_path": row["main_path"], "created": row["created"], "engine": row["engine"],
            "pdf_version": row["pdf_version"], **metadata}


def listing(library, id=None, reading_project_id=None, limit=50, offset=0):
    from .latex import _identifier
    from .projects import _identifier as reading_id
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise ValueError("limit 必须是 1–200")
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 100000:
        raise ValueError("offset 必须是 0–100000")
    filters, args = [], []
    if id is not None:
        filters.append("project_id=?"); args.append(_identifier(id))
    if reading_project_id is not None:
        filters.append("reading_project_id=?"); args.append(reading_id(reading_project_id, "阅读项目标识"))
    where = " WHERE " + " AND ".join(filters) if filters else ""
    total = library.db.execute(f"SELECT count(*) FROM latex_versions{where}", args).fetchone()[0]
    rows = library.db.execute(f"SELECT * FROM latex_versions{where} ORDER BY created DESC,id DESC LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
    return {"versions": [_version(row) for row in rows], "total": total, "limit": limit, "offset": offset, "truncated": offset + len(rows) < total}


def get(library, version_id=None, review_pdf_version=None):
    version_id = _id(version_id)
    row = library.db.execute("SELECT * FROM latex_versions WHERE id=?", (version_id,)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    root = _base(library) / version_id
    value = _version(row, full=True)
    if review_pdf_version is None:
        pdf = root / "preview.pdf"
    else:
        if not isinstance(review_pdf_version, str) or not re.fullmatch(r"[a-f0-9]{64}", review_pdf_version) or not any(item["pdf_version"] == review_pdf_version for item in value["review_pdfs"]):
            raise ValueError("审阅 PDF 不属于此版本")
        if (root / "review").is_symlink():
            raise ValueError("版本审阅目录不能是符号链接")
        pdf = root / "review" / f"{review_pdf_version}.pdf"
    if root.is_symlink() or pdf.is_symlink() or not pdf.is_file():
        raise ValueError("版本 PDF 缺失或路径不安全")
    return {"version": value, "pdf_path": str(pdf), "sources": value["sources"], "review_pdfs": value["review_pdfs"]}


def source(library, version_id=None, path=None):
    from .latex import _digest
    found = get(library, version_id)
    if not isinstance(path, str) or Path(path).is_absolute() or any(part in {".", ".."} for part in path.split("/")) or not any(item["path"] == path for item in found["sources"]):
        raise ValueError("源码不属于此版本")
    root = _base(library) / _id(version_id) / "sources"
    target = root / path
    if root.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != root and root in parent.parents) or target.is_symlink() or not target.is_file():
        raise ValueError("版本源码缺失或路径不安全")
    body = target.read_bytes()
    if len(body) > MAX_SOURCE_FILE:
        raise ValueError("版本源码超过大小上限")
    content = body.decode("utf-8", "replace")
    return {"version_id": version_id, "path": path, "content": content, "bytes": len(body), "revision": _digest(content)}


def review(library, version_id=None):
    get(library, version_id)
    root = _base(library) / _id(version_id)
    path = root / "review.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("版本自审记录缺失或超过大小上限")
    return json.loads(path.read_text(encoding="utf-8"))


def pdf_pages(library, version_id=None, review_pdf_version=None):
    found = get(library, version_id, review_pdf_version)
    path = Path(found["pdf_path"])
    pages = []
    with library._open_pdf(path) as document:
        for page in document:
            width, height = page.rect.width, page.rect.height
            if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                raise ValueError(f"PDF 第 {page.number + 1} 页尺寸无效")
            pages.append({"page": page.number + 1, "width": width, "height": height, "rotation": page.rotation})
        count = document.page_count
    return {"id": found["version"]["project_id"], "version": version_id + ":" + (review_pdf_version or "current"),
            "build": {"verified": False, "reason": "历史版本只读；不使用当前源码的 SyncTeX 映射"},
            "page_count": count, "pages": pages, "coordinate_system": "displayed-pdf-points", "rotation_applied": True,
            "truncated": False, "limits": {"pages": 2000}}


def pdf_page(library, version_id=None, review_pdf_version=None, page=1, scale=1.25):
    from itertools import islice
    from .latex_media import render
    found = get(library, version_id, review_pdf_version)
    with library._open_pdf(found["pdf_path"]) as document:
        if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= document.page_count:
            raise ValueError("页码超出范围")
        current = document[page - 1]
        words = [[*list(library._rect(word[:4], current)), *word[4:]] for word in current.get_text("words")[:20000]]
        annotations = []
        for annotation in islice(current.annots() or [], 300):
            value = library._annotation(current, annotation)
            annotations.append({key: value[key] for key in ("id", "type", "rects", "color")})
        return {"id": found["version"]["project_id"], **render(document, page, scale), "words": words, "annotations": annotations}
