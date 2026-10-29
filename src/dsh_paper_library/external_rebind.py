"""Explicit, revision-checked repair of indexed links; PDF bytes are never read.

The management-only entry opens an existing catalog directly, so a dry run does
not initialize schemas, create lock files or modify the library. Apply preserves
paper identities and promoted copies, with a private receipt and link rollback.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
import uuid
from pathlib import Path
from types import SimpleNamespace

from . import external
from .papers import Papers

MAX_MAPPINGS = 2000


class RebindConflict(ValueError):
    code = "STATE_CONFLICT"
    status = 409

    def __init__(self, message, revision=None):
        super().__init__(message)
        self.current = {"revision": revision} if revision else None


def _relative(value):
    if (not isinstance(value, str) or not value or len(value) > 2000
            or "\\" in value or "\x00" in value or Path(value).is_absolute()
            or any(part in ("", ".", "..") for part in value.split("/"))
            or not value.lower().endswith(".pdf") or external._depth(value) > external.MAX_RELATIVE_DEPTH):
        raise ValueError("Rebind requires a bounded PDF path relative to its source")
    return value


def _directories(path, root):
    """Reject symlink ancestors in the owned tree or selected source subtree."""
    if not path.is_relative_to(root):
        raise ValueError("Rebind path escapes its selected directory")
    current = root
    for part in ("", *path.relative_to(root).parts):
        if part:
            current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError("Rebind directory is not an independent ordinary directory")


def _link_identity(path, root):
    _directories(path.parent, root)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISLNK(info.st_mode):
        raise RebindConflict("An indexed link path holds an unexpected ordinary file")
    target = os.readlink(path)
    latest = path.lstat()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mtime_ns)
    if identity(latest) != identity(info) or not stat.S_ISLNK(latest.st_mode):
        raise RebindConflict("An indexed link changed while its identity was read")
    return {"target": target, "dev": info.st_dev, "ino": info.st_ino, "mtime_ns": info.st_mtime_ns}


def _file_stat(path, root):
    _directories(path.parent, root)
    try:
        info = path.lstat()
    except OSError:
        raise RebindConflict("A selected target PDF is unavailable; its bytes were not read") from None
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("Rebind target must be an ordinary PDF file")
    return info


def _plan(library, request):
    source_id = request.get("source")
    if not isinstance(source_id, str) or not external.SOURCE_ID.fullmatch(source_id):
        raise ValueError("Rebind needs an existing source id")
    old_source = library.db.execute("SELECT * FROM external_sources WHERE id=?", (source_id,)).fetchone()
    if not old_source:
        raise RebindConflict("The original external source no longer exists")
    target = request.get("target_source")
    if not isinstance(target, dict):
        raise ValueError("Rebind needs a selected target source")
    target = external._check_roots(library, external.normalize_sources([target]))[0]
    if target["id"] == source_id:
        raise ValueError("Partial rebind needs a distinct target source; unmatched old rows stay in place")
    if not target["root"].is_dir():
        raise ValueError("The selected target source directory does not exist")
    existing_target = library.db.execute("SELECT * FROM external_sources WHERE id=?", (target["id"],)).fetchone()
    if existing_target and existing_target["root"] != str(target["root"]):
        raise RebindConflict("The target source id already owns another root")
    other = library.db.execute("SELECT id FROM external_sources WHERE root=? AND id<>?", (str(target["root"]), target["id"])).fetchone()
    if other:
        raise RebindConflict("The target root already has another source identity")
    mappings = request.get("mappings")
    if not isinstance(mappings, list) or not 1 <= len(mappings) <= MAX_MAPPINGS:
        raise ValueError("Rebind needs 1–2000 explicit mappings")
    rows, snapshots, ids, destinations = [], [], set(), set()
    for mapping in mappings:
        if not isinstance(mapping, dict):
            raise ValueError("Every rebind mapping must be an object")
        paper_id = mapping.get("paper_id")
        old_relative, new_relative = _relative(mapping.get("old_relative")), _relative(mapping.get("new_relative"))
        expected_size = mapping.get("expected_size")
        if not isinstance(paper_id, str) or not paper_id or paper_id in ids or new_relative.casefold() in destinations:
            raise ValueError("Rebind paper identities and destination paths must be unique")
        if type(expected_size) is not int or expected_size <= 0:
            raise ValueError("Rebind needs the known positive file size")
        ids.add(paper_id); destinations.add(new_relative.casefold())
        old = external._record(library, source_id, old_relative)
        paper = library.db.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not old or old["paper_id"] != paper_id or old["size"] != expected_size or not paper:
            raise RebindConflict("The original indexed identity or size has changed")
        owners = library.db.execute("SELECT count(*) FROM external_files WHERE paper_id=?", (paper_id,)).fetchone()[0]
        if owners != 1 or external._record(library, target["id"], new_relative):
            raise RebindConflict("The indexed paper or destination has conflicting ownership")
        value = json.loads(paper["metadata"])
        before_external = value.get("external_source")
        if not isinstance(before_external, dict) or before_external.get("id") != source_id or before_external.get("relative") != old_relative:
            raise RebindConflict("The paper no longer belongs to the selected source row")
        old_link = external.staged_path(library, source_id, old_relative)
        new_link = external.staged_path(library, target["id"], new_relative)
        old_identity, new_identity = _link_identity(old_link, library.root), _link_identity(new_link, library.root)
        old_state = old_identity["target"] if old_identity else None
        expected_old_target = str(Path(old_source["root"]) / old_relative)
        if old_state is not None and old_state != expected_old_target:
            raise RebindConflict("The original link no longer points to its registered target")
        if new_identity is not None:
            raise RebindConflict("The destination link is not owned by this repair")
        staged = f"external/{source_id}/{old_relative}"
        promoted = paper["pdf_path"] != staged
        if promoted and (not paper["pdf_path"] or not str(paper["pdf_path"]).startswith("pdfs/")):
            raise RebindConflict("The paper PDF path is neither its indexed link nor a managed copy")
        path = target["root"] / new_relative
        details = _file_stat(path, target["root"])
        if details.st_size != expected_size:
            raise RebindConflict("The target PDF size has changed; its bytes were not read")
        row = {"paper_id": paper_id, "old_relative": old_relative, "new_relative": new_relative,
               "old_target": expected_old_target, "new_target": str(path), "old_staged": str(old_link.relative_to(library.root)),
               "new_staged": str(new_link.relative_to(library.root)), "expected_size": expected_size,
               "old_link_present": old_identity is not None, "promoted_copy_preserved": promoted}
        rows.append(row)
        snapshots.append({"mapping": row, "old_row": dict(old), "paper": dict(paper), "old_link": old_identity,
                          "new_link": new_identity, "target_stat": [details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns]})
    rows.sort(key=lambda item: item["paper_id"]); snapshots.sort(key=lambda item: item["mapping"]["paper_id"])
    snapshot = {"old_source": dict(old_source), "target_source": {**target, "root": str(target["root"])},
                "existing_target": dict(existing_target) if existing_target else None, "rows": snapshots}
    revision = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    remaining = library.db.execute("SELECT count(*) FROM external_files WHERE source=?", (source_id,)).fetchone()[0] - len(rows)
    return {"revision": revision, "source": source_id, "source_before": dict(old_source),
            "target_before": dict(existing_target) if existing_target else None,
            "target_source": {**target, "root": str(target["root"])},
            "matched": len(rows), "unmatched_old_rows_preserved": remaining,
            "promoted_copies_preserved": sum(row["promoted_copy_preserved"] for row in rows), "mappings": rows}, snapshots


def _restore_link(path, value, root, expected=None):
    _directories(path.parent, root)
    if value is None:
        current = _link_identity(path, root)
        if current is None:
            return None
        if expected is None or current != expected:
            raise RebindConflict("A staged link was replaced by another owner; it has been preserved")
        path.unlink()
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    # The syscall itself refuses a file or link created since preflight. Never
    # replace a later owner's entry while creating or restoring a staged link.
    os.symlink(value, path)
    return _link_identity(path, root)


def _receipt(library, plan):
    directory = library.root / "backups"
    _directories(directory, library.root)
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / ("external-rebind-" + uuid.uuid4().hex + ".json")
    content = {"kind": "paper-library-external-rebind.v1", "state": "prepared", "created_at": external._now(), **plan}
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags, 0o600), "w", encoding="utf-8") as handle:
        json.dump(content, handle, ensure_ascii=False, indent=2); handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
    return path, content


def dispatch(directory, request):
    """Preview or apply explicit link mappings against an existing library."""
    if len(json.dumps(request, ensure_ascii=False).encode()) > 2 * 1024 * 1024:
        raise ValueError("Rebind request exceeds 2 MiB; use fewer explicit mappings")
    root = Path(directory).expanduser().resolve()
    database = root / "catalog.sqlite3"
    info = database.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Rebind requires an independent existing catalog")
    apply = request.get("apply", False)
    if type(apply) is not bool:
        raise ValueError("Rebind apply must be a boolean")
    if not apply and Path(str(database) + "-wal").exists():
        raise RebindConflict("A catalog writer is active; retry the read-only preview when it closes")
    mode = "mode=rw" if apply else "mode=ro&immutable=1"
    connection = sqlite3.connect(database.as_uri() + "?" + mode, uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    library = SimpleNamespace(root=root, db=connection)
    try:
        if not apply:
            connection.execute("PRAGMA query_only=ON")
            plan, _ = _plan(library, request)
            latest = database.lstat()
            if (Path(str(database) + "-wal").exists()
                    or (latest.st_dev, latest.st_ino, latest.st_size, latest.st_mtime_ns)
                    != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)):
                raise RebindConflict("The catalog changed during the read-only preview; retry")
            return {"applied": False, **plan, "pdf_bytes_read": 0}
        with Papers.lock(library):
            connection.execute("BEGIN IMMEDIATE")
            changes = []
            try:
                plan, snapshots = _plan(library, request)
                if request.get("expected_revision") != plan["revision"]:
                    raise RebindConflict("The catalog, mappings, links or target file stats changed; preview again", plan["revision"])
                receipt, content = _receipt(library, plan)
                target = plan["target_source"]
                connection.execute("INSERT OR IGNORE INTO external_sources(id,root,label,files,indexed) VALUES(?,?,?,0,0)", (target["id"], target["root"], target["label"]))
                for snapshot in snapshots:
                    row, before = snapshot["mapping"], snapshot["paper"]
                    old_link, new_link = root / row["old_staged"], root / row["new_staged"]
                    if _link_identity(old_link, root) != snapshot["old_link"] or _link_identity(new_link, root) is not None:
                        raise RebindConflict("An owned staged link changed while the repair was being applied")
                    details = _file_stat(Path(row["new_target"]), Path(target["root"]))
                    if [details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns] != snapshot["target_stat"]:
                        raise RebindConflict("A target PDF changed while the repair was being applied")
                    created = _restore_link(new_link, row["new_target"], root)
                    changes.append((new_link, None, created))
                    _restore_link(old_link, None, root, expected=snapshot["old_link"])
                    changes.append((old_link, snapshot["old_link"], None))
                    value = json.loads(before["metadata"])
                    updated_external = dict(value["external_source"])
                    updated_external.update(id=target["id"], label=target["label"], root=target["root"], relative=row["new_relative"], staged=row["new_staged"], size=row["expected_size"], mtime_ns=snapshot["target_stat"][3], synced=True)
                    updated_external.pop("missing", None)
                    if row["promoted_copy_preserved"]: updated_external.setdefault("promoted", "managed-copy-kept")
                    value["external_source"] = updated_external
                    pdf_path = before["pdf_path"] if row["promoted_copy_preserved"] else row["new_staged"]
                    connection.execute("UPDATE papers SET metadata=?,pdf_path=?,modified=? WHERE id=?", (json.dumps(value, ensure_ascii=False), pdf_path, external._now(), row["paper_id"]))
                    connection.execute("DELETE FROM external_files WHERE source=? AND relative=?", (plan["source"], row["old_relative"]))
                    connection.execute("INSERT INTO external_files(source,relative,paper_id,size,mtime_ns,missing,updated,parent,name) VALUES(?,?,?,?,?,0,?,?,?)", (target["id"], row["new_relative"], row["paper_id"], row["expected_size"], snapshot["target_stat"][3], external._now(), os.path.dirname(row["new_relative"]), os.path.basename(row["new_relative"])))
                for identifier in (plan["source"], target["id"]):
                    connection.execute("UPDATE external_sources SET files=(SELECT count(*) FROM external_files WHERE source=?),indexed=0 WHERE id=?", (identifier, identifier))
                connection.commit()
            except BaseException:
                connection.rollback()
                failures = []
                for path, before, after in reversed(changes):
                    try: _restore_link(path, before["target"] if before else None, root, expected=after)
                    except Exception as error: failures.append(type(error).__name__)
                if failures: raise RuntimeError("Index repair rolled back, but some staged links require manual recovery")
                raise
            content["state"] = "applied"
            try:
                temporary = receipt.with_suffix(".tmp")
                with temporary.open("x", encoding="utf-8") as handle:
                    os.chmod(temporary, 0o600); json.dump(content, handle, ensure_ascii=False, indent=2); handle.flush(); os.fsync(handle.fileno())
                os.replace(temporary, receipt)
                receipt_status = "applied"
            except OSError:
                receipt_status = "prepared-receipt-kept"
            return {"applied": True, "revision": plan["revision"], "matched": plan["matched"],
                    "unmatched_old_rows_preserved": plan["unmatched_old_rows_preserved"],
                    "promoted_copies_preserved": plan["promoted_copies_preserved"], "receipt": str(receipt),
                    "receipt_state": receipt_status, "pdf_bytes_read": 0}
    finally:
        connection.close()
