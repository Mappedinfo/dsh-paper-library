"""Single-reader manuscript review built on Paper Library's native PDF objects.

PDF notes live in per-entry/per-build review copies, never in annotation rows or
the compiler output. Source notes use the existing LaTeX atomic/CAS conventions.
Both project into the existing annotation export vocabulary.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid

MAX_BYTES = 2 * 1024 * 1024
MAX_NOTES = 300
MAX_BUILDS = 12
MAX_PDF_BYTES = 250 * 1024 * 1024
HEX = re.compile(r"^[0-9a-f]{64}$")
NOTE = re.compile(r"^[0-9a-f]{32}$")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_digest(path, maximum=MAX_PDF_BYTES):
    if path.stat().st_size > maximum:
        raise ValueError("文件超过自审读取预算")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def directory(library, row, create=False):
    path = library.root / "latex-review" / row["id"] / hashlib.sha256(row["main_path"].encode()).hexdigest()[:20]
    for parent in [library.root / "latex-review", path.parent, path]:
        if parent.is_symlink():
            raise ValueError("自审目录不能是符号链接")
        if create:
            parent.mkdir(exist_ok=True, mode=0o700)
    return path


def read_json(path, default):
    if not path.exists():
        return default
    if path.is_symlink() or path.stat().st_size > MAX_BYTES:
        raise ValueError("自审记录不安全或超过 2 MiB；原文件已保留")
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    from .latex import _atomic_write
    body = json.dumps(value, ensure_ascii=False, sort_keys=True)
    if len(body.encode()) > MAX_BYTES:
        raise ValueError("自审记录达到 2 MiB 上限；请先导出")
    if path.name == "source.json" and path.is_file():
        _atomic_write(path.with_suffix(".json.bak"), path.read_text(encoding="utf-8"))
    _atomic_write(path, body)


def source_snapshot(library, row):
    from .latex import tree, _inside
    result, total = {}, 0
    for item in tree(library, row["id"])["files"]:
        if item["kind"] != "text":
            continue
        total += item["bytes"]
        if len(result) >= 300 or total > 16 * 1024 * 1024:
            break
        path, relative = _inside(Path(row["root"]), item["path"])
        result[relative] = file_digest(path, 1024 * 1024)
    return result


def record_build(library, row, before):
    from .latex import _project_pdf, _synctex_sidecar, _inside, TEXT_SUFFIXES
    pdf = _project_pdf(library, row)
    sidecar = _synctex_sidecar(pdf)
    actual = {row["main_path"]}
    if not sidecar.is_file():
        return
    with gzip.open(sidecar, "rb") as stream:
        data = stream.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("SyncTeX 记录超过 8 MiB，无法核验映射")
    for line in data.decode("utf-8", "replace").splitlines():
        if not line.startswith("Input:"):
            continue
        name = line.split(":", 2)[-1]
        path = Path(name)
        path = path if path.is_absolute() else pdf.parent / path
        path = path.resolve()
        if path.is_relative_to(Path(row["root"])) and path.suffix.lower() in TEXT_SUFFIXES:
            actual.add(path.relative_to(Path(row["root"])).as_posix())
    # Bibliographies are not necessarily listed in SyncTeX's Input records.
    from .latex_lint import _tex
    for relative in list(actual):
        path, _ = _inside(Path(row["root"]), relative)
        if path.suffix == ".tex" and path.stat().st_size <= 1024 * 1024:
            for _, command, value in _tex(path.read_text(encoding="utf-8", errors="replace"))[1]:
                if command not in {"bibliography", "addbibresource"}:
                    continue
                for value in value.split(","):
                    if re.search(r"[\\#{}$]", value):
                        continue
                    value = value.strip()
                    if value:
                        actual.add(value if value.endswith(".bib") else value + ".bib")
    sources, verified = {}, True
    for relative in sorted(actual):
        try:
            path, relative = _inside(Path(row["root"]), relative)
            sha = file_digest(path, 1024 * 1024)
            sources[relative] = sha
            verified = verified and before.get(relative) == sha
        except (OSError, ValueError):
            verified = False
    value = {"pdf": file_digest(pdf), "synctex": file_digest(sidecar, 8 * 1024 * 1024), "sources": sources,
             "main_path": row["main_path"], "verified": verified}
    write_json(directory(library, row, True) / "build.json", value)


def build_status(library, row, pdf=None):
    from .latex import _project_pdf, _synctex_sidecar, _inside
    pdf = pdf or _project_pdf(library, row)
    sha = file_digest(pdf)
    result = {"pdf_version": sha, "verified": False, "reason": "当前 PDF 没有已核验的编译记录；请在工作台编译一次以启用精确定位"}
    manifest = read_json(directory(library, row) / "build.json", {})
    sidecar = _synctex_sidecar(pdf)
    if not sidecar.is_file():
        result["reason"] = "缺少 SyncTeX 数据；请在工作台编译一次（保留原稿后再编译）"
        return result
    if manifest.get("pdf") != sha or not manifest.get("verified") or manifest.get("main_path") != row["main_path"]:
        return result
    if manifest.get("synctex") != file_digest(sidecar, 8 * 1024 * 1024):
        result["reason"] = "SyncTeX 已变化，当前映射待重新核验；请重新编译"
        return result
    try:
        changed = [path for path, expected in manifest["sources"].items() if file_digest(_inside(Path(row["root"]), path)[0], 1024 * 1024) != expected]
    except (OSError, ValueError):
        changed = ["源文件缺失或读取受限"]
    result.update(source_revisions=manifest.get("sources", {}), verified=not changed)
    result["reason"] = "源码已改，PDF 仍是旧编译；请保存并重新编译" if changed else "SyncTeX 已核验；双击正文定位源码"
    return result


def preview_path(library, row, original, sha=None):
    path = directory(library, row) / f"{sha or file_digest(original)}.pdf"
    if path.is_symlink():
        raise ValueError("审阅 PDF 不能是符号链接")
    return path if path.is_file() else original


def source_anchor(library, row, value):
    from .latex import read
    if not isinstance(value, dict):
        raise ValueError("请选择一段源码或当前行")
    current = read(library, row["id"], value.get("path"))
    if value.get("revision") != current["revision"]:
        raise ValueError("源码修订不一致；请先保存，再重新选择批注范围。你的文字未改动")
    start, end = value.get("start"), value.get("end")
    if any(isinstance(n, bool) or not isinstance(n, int) for n in (start, end)) or not 0 <= start < end <= len(current["content"]) or end - start > 20000:
        raise ValueError("源码选段无效或超过 20000 字符")
    quote = current["content"][start:end]
    if value.get("text") != quote:
        raise ValueError("源码选段已变化；请重新选择")
    return {"kind": "source", "path": current["path"], "revision": current["revision"], "start": start, "end": end,
            "line": current["content"].count("\n", 0, start) + 1, "text": quote}


def view(library, row, note, pdf_version):
    from .latex import read
    value = {**note, "main_path": row["main_path"]}
    value["version"] = digest(note)
    anchor = note["anchor"]
    if anchor["kind"] == "source":
        try:
            stale = read(library, row["id"], anchor["path"])["revision"] != anchor["revision"]
        except (ValueError, OSError):
            stale = True
    else:
        stale = anchor["pdf_version"] != pdf_version
        if not stale and anchor.get("sources"):
            try:
                from .latex import _inside
                stale = any(file_digest(_inside(Path(row["root"]), path)[0], 1024 * 1024) != sha for path, sha in anchor["sources"].items())
            except (ValueError, OSError):
                stale = True
    value["stale"] = stale
    return value


def pdf_notes(library, path, sha):
    result = []
    with library._open_pdf(path) as doc:
        for page in doc:
            for annotation in page.annots() or []:
                extra = library._annotation_metadata(annotation)
                meta = extra.get("latex_review")
                if not isinstance(meta, dict):
                    continue  # External annotations remain in the copy and export.
                projected = library._annotation(page, annotation)
                note = {"id": f"pdf:{sha}:{projected['id']}", "type": projected["type"], "text": projected["text"],
                        "comment": projected["comment"], "status": meta.get("status", "open"), "anchor": meta["anchor"],
                        "created": meta["created"], "modified": meta["modified"], "page": projected["page"], "rects": projected["rects"]}
                result.append(note)
                if len(result) >= MAX_NOTES:
                    return result
    return result


def listing(library, id=None):
    from .latex import _project, _project_pdf
    row = _project(library, id)
    root = directory(library, row)
    sha = file_digest(_project_pdf(library, row)) if row["pdf_path"] else None
    source = read_json(root / "source.json", [])
    notes = [view(library, row, note, sha) for note in source]
    for path in sorted(root.glob("*.pdf")) if root.is_dir() else []:
        if HEX.fullmatch(path.stem) and not path.is_symlink():
            notes.extend(view(library, row, note, sha) for note in pdf_notes(library, path, path.stem))
        if len(notes) >= MAX_NOTES:
            break
    notes.sort(key=lambda note: (note["status"] == "resolved", note["created"]), reverse=False)
    return {"id": id, "main_path": row["main_path"], "pdf_version": sha, "annotations": notes[:MAX_NOTES], "truncated": len(notes) > MAX_NOTES,
            "limits": {"annotations": MAX_NOTES, "builds": MAX_BUILDS}}


def put(library, id=None, note_id=None, anchor=None, comment="", status="open", expected_version=None, type="note", request_id=None):
    from .latex import _project, _project_pdf, now, LatexConflict
    row = _project(library, id)
    if not isinstance(comment, str) or len(comment) > 8000 or status not in {"open", "resolved"}:
        raise ValueError("批注最多 8000 字符，状态只能是 open/resolved")
    if request_id is not None and (not isinstance(request_id, str) or not NOTE.fullmatch(request_id)):
        raise ValueError("批注请求标识无效")
    with library.lock():
        root = directory(library, row, True)
        all_notes = listing(library, id)["annotations"]
        existing = next((n for n in all_notes if n["id"] == note_id), None) if note_id else None
        if note_id and not existing:
            raise ValueError("批注不存在于当前主入口；请刷新列表")
        if existing and expected_version != existing["version"]:
            raise LatexConflict(existing)
        if not existing and request_id:
            retry = next((n for n in all_notes if n["id"].split(":")[-1] == request_id), None)
            if retry:
                if retry["comment"] == comment and retry["status"] == status and isinstance(anchor, dict) and all(retry["anchor"].get(k) == v for k, v in anchor.items()):
                    return {"annotation": retry, "duplicate": True}
                raise ValueError("请求标识已用于另一条批注")
        if not existing and len(all_notes) >= MAX_NOTES:
            raise ValueError("当前入口达到 300 条批注上限；请先导出")
        if existing and anchor is not None:
            raise ValueError("旧锚点不会自动移动；请在新位置建立新批注并解决旧批注")
        anchor = existing["anchor"] if existing else anchor
        if not isinstance(anchor, dict) or anchor.get("kind") not in {"source", "pdf"}:
            raise ValueError("批注需要源码或 PDF 锚点")
        timestamp = now()
        if anchor["kind"] == "source":
            notes = read_json(root / "source.json", [])
            verified = anchor if existing else source_anchor(library, row, anchor)
            identifier = existing["id"] if existing else "source:" + (request_id or uuid.uuid4().hex)
            note = {"id": identifier, "type": "source-note", "text": verified["text"], "comment": comment, "status": status,
                    "anchor": verified, "created": existing["created"] if existing else timestamp, "modified": timestamp, "page": None, "rects": []}
            old = next((n for n in notes if n["id"] == identifier), None)
            if old and not existing:
                if old["anchor"] == verified and old["comment"] == comment:
                    return {"annotation": view(library, row, old, None), "duplicate": True}
                raise ValueError("请求标识已用于另一条批注")
            notes = [note if n["id"] == identifier else n for n in notes] if existing else [*notes, note]
            write_json(root / "source.json", notes)
            return {"annotation": view(library, row, note, None)}
        original = _project_pdf(library, row)
        sha = existing["anchor"]["pdf_version"] if existing else file_digest(original)
        if not HEX.fullmatch(sha):
            raise ValueError("PDF 版本标识无效")
        if not existing and anchor.get("pdf_version") != sha:
            raise ValueError("PDF 编译版本已变化；请重新载入预览再批注")
        destination = root / f"{sha}.pdf"
        if destination.is_symlink():
            raise ValueError("审阅副本不能是符号链接")
        if not destination.exists():
            copies = list(root.glob("*.pdf"))
            if len(copies) >= MAX_BUILDS or sum(p.stat().st_size for p in copies) + original.stat().st_size > MAX_PDF_BYTES:
                raise ValueError("审阅副本达到版本或 250 MiB 预算；请先导出")
            shutil.copyfile(original, destination)
        with library._open_pdf(destination, writing=True) as doc:
            if existing:
                page, native = library._find_annotation(doc, existing["id"].split(":")[-1])
                extra = library._annotation_metadata(native)
                extra["latex_review"].update(status=status, modified=timestamp)
                native.set_info(content=comment, subject="paper-library:" + json.dumps(extra, ensure_ascii=False))
                native.update()
            else:
                from .latex import _inside
                if type not in {"highlight", "note", "underline"}:
                    raise ValueError("自审支持高亮、下划线或区域便笺")
                page = anchor.get("page")
                if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= doc.page_count:
                    raise ValueError("PDF 页码无效")
                rects = anchor.get("rects")
                quote = str(anchor.get("text", ""))[:20000]
                state = build_status(library, row, original)
                sources = state.get("source_revisions", {})
                if not sources:
                    from .latex import outline
                    snapshot = source_snapshot(library, row)
                    referenced = outline(library, row["id"])["referenced"]
                    sources = {path: snapshot[path] for path in referenced if path in snapshot}
                verified = {"kind": "pdf", "pdf_version": sha, "page": page, "rects": rects, "text": quote,
                            "sources": sources, "mapping_verified": state["verified"]}
                identifier = request_id or uuid.uuid4().hex
                matches = [(p, a) for p in doc for a in p.annots() or [] if a.info.get("id") == identifier]
                if matches:
                    extra = library._annotation_metadata(matches[0][1])
                    if extra.get("latex_review", {}).get("anchor") == verified and matches[0][1].info.get("content") == comment:
                        return {"duplicate": True}
                    raise ValueError("请求标识已用于另一条批注")
                library._add_annotation(doc, page=page, type=type, rects=rects, text=quote, comment=comment, author="Reader",
                                        annotation_id=identifier, extra={"kind": "latex-review", "latex_review": {"status": status, "anchor": verified, "created": timestamp, "modified": timestamp}})
            library._atomic_save(doc, destination, backup_key=f"latex-{row['id']}-{sha[:12]}")
        return {"saved": True, "pdf_version": sha}


def export(library, id=None, format="json"):
    from .latex import _project, _project_pdf
    row = _project(library, id)
    result = listing(library, id)
    value = {"schema": "paper-library.annotations.v1", "item": {"title": row["title"], "citekey": row["id"]}, **result}
    if format == "json":
        return {"text": json.dumps(value, ensure_ascii=False, indent=2), "mime": "application/json", "filename": "manuscript-review.json"}
    if format == "markdown":
        lines = [f"# {row['title']} — {row['main_path']}", ""]
        for note in result["annotations"]:
            anchor = note["anchor"]
            location = f"{anchor['path']}:{anchor['line']}" if anchor["kind"] == "source" else f"PDF p.{anchor['page']} / {anchor['pdf_version'][:12]}"
            lines.extend([f"## {location} · {note['status']}{' · 待重定位' if note['stale'] else ''}", "", "> " + note["text"].replace("\n", "\n> "), "", note["comment"], ""])
        return {"text": "\n".join(lines), "mime": "text/markdown", "filename": "manuscript-review.md"}
    if format != "pdf":
        raise ValueError("批注导出支持 json、markdown、pdf")
    original = _project_pdf(library, row)
    source = preview_path(library, row, original)
    destination = library.root / "exports" / f"{row['id']}-{hashlib.sha256(row['main_path'].encode()).hexdigest()[:12]}-review.pdf"
    if destination.parent.is_symlink() or destination.is_symlink():
        raise ValueError("导出路径不能是符号链接")
    destination.parent.mkdir(exist_ok=True, mode=0o700)
    with library.lock(), library._open_pdf(source) as doc:
        name = "paper-library.latex-review.json"
        if name in doc.embfile_names():
            doc.embfile_del(name)
        doc.embfile_add(name, json.dumps(value, ensure_ascii=False).encode(), filename=name)
        library._atomic_save(doc, destination, backup_key=f"latex-export-{row['id']}")
    return {"path": str(destination), "filename": "manuscript-review.pdf", "original_unchanged": True}


def delete(library, id=None, note_id=None, expected_version=None):
    """Delete only one explicitly identified owned note; PDF backups stay intact."""
    from .latex import _project, LatexConflict
    row = _project(library, id)
    with library.lock():
        existing = next((n for n in listing(library, id)["annotations"] if n["id"] == note_id), None)
        if not existing:
            raise ValueError("批注不存在于当前主入口")
        if existing["version"] != expected_version:
            raise LatexConflict(existing)
        root = directory(library, row)
        if existing["anchor"]["kind"] == "source":
            path = root / "source.json"
            write_json(path, [n for n in read_json(path, []) if n["id"] != note_id])
        else:
            sha = existing["anchor"]["pdf_version"]
            path = root / f"{sha}.pdf"
            with library._open_pdf(path, writing=True) as doc:
                page, annotation = library._find_annotation(doc, note_id.split(":")[-1])
                # MuPDF deletes replies with their parent. An explicit single
                # note deletion must preserve externally added reply objects.
                for reply in page.annots() or []:
                    if reply.xref != annotation.xref and reply.irt_xref == annotation.xref:
                        doc.xref_set_key(reply.xref, "IRT", "null")
                page.delete_annot(annotation)
                library._atomic_save(doc, path, backup_key=f"latex-{row['id']}-{sha[:12]}")
        return {"deleted": True, "note_id": note_id, "backup_kept": True}
