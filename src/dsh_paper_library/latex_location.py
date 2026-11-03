"""Keep project-local histories and review data isolated when its root changes."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import uuid


def _key(root):
    return hashlib.sha256(root.encode()).hexdigest()


def _prefix(root):
    # A path rejected by _inside; it can never be mistaken for a live source.
    return f"../.latex-location/{_key(root)}/"


def _project_path(old_root, new_root, relative):
    absolute = Path(os.path.realpath(old_root / relative))
    return absolute.relative_to(new_root).as_posix() if absolute.is_relative_to(new_root) else None


def relocate(library, row, new_root, new_main, same_main):
    """Rebind catalog data without modifying original sources or existing review PDFs.

    Caller holds the project lock. Namespace registration and revision changes are
    committed with the project update; an unused copied directory is harmless if
    the transaction fails and is never overwritten on retry.
    """
    from .latex_review import directory, read_json, write_json, pdf_notes, HEX
    old_root = Path(row["root"])
    old = directory(library, row)
    library.db.execute("INSERT OR IGNORE INTO latex_review_locations VALUES(?,?,?)", (row["id"], row["root"], ""))
    existing = library.db.execute("SELECT namespace FROM latex_review_locations WHERE project_id=? AND root=?", (row["id"], str(new_root))).fetchone()
    new_namespace = existing[0] if existing else uuid.uuid4().hex + uuid.uuid4().hex
    library.db.execute("INSERT OR IGNORE INTO latex_review_locations VALUES(?,?,?)", (row["id"], str(new_root), new_namespace))
    projected = dict(row)
    projected.update(root=str(new_root), main_path=new_main)
    target = directory(library, projected)
    # Only transfer review state when the entry is exactly the same file. Other
    # old entries and PDF snapshots stay in their original namespace.
    if same_main and old.is_dir() and not target.exists():
        directory(library, projected, True)
        try:
            for item in old.iterdir():
                if item.is_symlink() or not item.is_file():
                    raise ValueError("自审目录包含不安全的文件")
                shutil.copy2(item, target / item.name)
            notes_path = target / "source.json"
            if notes_path.exists():
                notes = read_json(notes_path, [])
                for note in notes:
                    anchor = note.get("anchor", {})
                    if anchor.get("kind") == "source" and isinstance(anchor.get("path"), str):
                        anchor["path"] = _project_path(old_root, new_root, anchor["path"]) or "../" + anchor["path"]
                write_json(notes_path, notes)
            stale_annotations = [note["id"] for pdf in target.glob("*.pdf") if HEX.fullmatch(pdf.stem)
                                 for note in pdf_notes(library, pdf, pdf.stem)]
            write_json(target / "migrated-pdf-annotations.json", stale_annotations)
        except Exception:
            # Only the newly created copy is removed; the original is untouched.
            shutil.rmtree(target)
            raise
    revisions = library.db.execute("SELECT id,path,sha256,body,origin,created FROM latex_revisions WHERE project_id=?", (row["id"],)).fetchall()
    active = [revision for revision in revisions if not revision["path"].startswith("../.latex-location/")]
    for revision in active:
        library.db.execute("UPDATE latex_revisions SET path=? WHERE id=?", (_prefix(row["root"]) + revision["path"], revision["id"]))
    previous_prefix = _prefix(str(new_root))
    restored = [revision for revision in revisions if revision["path"].startswith(previous_prefix)]
    for revision in restored:
        library.db.execute("UPDATE latex_revisions SET path=? WHERE id=?", (revision["path"][len(previous_prefix):], revision["id"]))
    if same_main and not restored:
        for revision in active:
            mapped = _project_path(old_root, new_root, revision["path"])
            if mapped:
                library.db.execute("INSERT INTO latex_revisions(id,project_id,path,sha256,body,origin,created) VALUES(?,?,?,?,?,?,?)",
                                   ("lr-" + uuid.uuid4().hex[:12], row["id"], mapped, revision["sha256"], revision["body"], revision["origin"], revision["created"]))
