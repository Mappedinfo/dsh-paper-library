"""Explicit repair uses only synthetic catalog rows and file stat metadata."""
import json
import importlib.util
import os
import sqlite3
from pathlib import Path

import pytest

from dsh_paper_library import external_rebind
from dsh_paper_library.core import dispatch
from dsh_paper_library.papers import Papers


def call(root, action, **kwargs):
    return dispatch({"library": str(root / "library"), "action": action, **kwargs})


def prepare(root):
    old = root / "old"
    target = root / "PaperAssets"
    for relative in ("folder/a.pdf", "folder/b.pdf", "unmatched.pdf"):
        path = old / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(("%PDF synthetic " + relative).encode())
    source = {"id": "legacy", "root": str(old)}
    call(root, "external_scan", sources=[source])
    con = sqlite3.connect(root / "library/catalog.sqlite3")
    rows = con.execute("SELECT paper_id,relative,size FROM external_files ORDER BY relative").fetchall()
    con.close()
    mappings = []
    for paper_id, relative, size in rows[:2]:
        path = target / ("moved/" + relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((old / relative).read_bytes())
        mappings.append({"paper_id": paper_id, "old_relative": relative, "new_relative": "moved/" + relative, "expected_size": size})
    request = {"source": "legacy", "target_source": {"id": "paperassets", "root": str(target)}, "mappings": mappings}
    return old, target, request


def query(root, sql, parameters=()):
    connection = sqlite3.connect((root / "library/catalog.sqlite3").as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        return connection.execute(sql, parameters).fetchall()
    finally:
        connection.close()


def test_preview_does_not_initialize_schema_or_create_receipt_and_rebind_preserves_ids(tmp_path, monkeypatch):
    old, target, request = prepare(tmp_path)
    library = tmp_path / "library"
    original_ids = query(tmp_path, "SELECT id FROM papers ORDER BY id")
    before = {str(path.relative_to(library)): path.lstat().st_mtime_ns for path in library.rglob("*")}
    with monkeypatch.context() as guard:
        guard.setattr(Papers, "_initialize_schema", lambda _: pytest.fail("Preview initialized schema"))
        preview = call(tmp_path, "external_rebind", **request)
    assert preview["applied"] is False and preview["matched"] == 2
    assert preview["unmatched_old_rows_preserved"] == 1 and preview["pdf_bytes_read"] == 0
    assert {str(path.relative_to(library)): path.lstat().st_mtime_ns for path in library.rglob("*")} == before
    result = call(tmp_path, "external_rebind", **request, apply=True, expected_revision=preview["revision"])
    assert result["applied"] and result["matched"] == 2
    receipt = Path(result["receipt"])
    assert receipt.is_relative_to(library / "backups") and (receipt.stat().st_mode & 0o777) == 0o600
    assert json.loads(receipt.read_text())["state"] == "applied"
    assert query(tmp_path, "SELECT id FROM papers ORDER BY id") == original_ids
    assert query(tmp_path, "SELECT count(*) FROM external_files WHERE source='legacy'") == [(1,)]
    for mapping in request["mappings"]:
        assert not (library / "external/legacy" / mapping["old_relative"]).is_symlink()
        assert os.readlink(library / "external/paperassets" / mapping["new_relative"]) == str(target / mapping["new_relative"])
    scanned = call(tmp_path, "external_scan", sources=[request["target_source"]])["sources"][0]
    assert scanned["indexed"] == 0 and scanned["skipped"] == 2
    assert query(tmp_path, "SELECT id FROM papers ORDER BY id") == original_ids
    assert query(tmp_path, "SELECT relative FROM external_files WHERE source='legacy'") == [("unmatched.pdf",)]


def test_promoted_pdf_and_private_metadata_are_preserved(tmp_path):
    _, _, request = prepare(tmp_path)
    paper_id = request["mappings"][0]["paper_id"]
    managed = tmp_path / "library/pdfs/annotated-synthetic.pdf"
    managed.write_bytes(b"%PDF synthetic annotated copy")
    con = sqlite3.connect(tmp_path / "library/catalog.sqlite3")
    metadata = json.loads(con.execute("SELECT metadata FROM papers WHERE id=?", (paper_id,)).fetchone()[0])
    metadata["private_note"] = "Synthetic private note kept by its identity"
    metadata["external_source"]["promoted"] = "kept"
    con.execute("UPDATE papers SET metadata=?,pdf_path=? WHERE id=?", (json.dumps(metadata), "pdfs/annotated-synthetic.pdf", paper_id)); con.commit(); con.close()
    preview = call(tmp_path, "external_rebind", **request)
    result = call(tmp_path, "external_rebind", **request, apply=True, expected_revision=preview["revision"])
    assert result["promoted_copies_preserved"] == 1
    value, path = query(tmp_path, "SELECT metadata,pdf_path FROM papers WHERE id=?", (paper_id,))[0]
    assert path == "pdfs/annotated-synthetic.pdf" and managed.read_bytes() == b"%PDF synthetic annotated copy"
    value = json.loads(value)
    assert value["private_note"] == metadata["private_note"] and value["external_source"]["promoted"] == "kept"


def test_stale_catalog_or_target_stats_reject_before_any_link_changes(tmp_path):
    _, target, request = prepare(tmp_path)
    preview = call(tmp_path, "external_rebind", **request)
    con = sqlite3.connect(tmp_path / "library/catalog.sqlite3")
    con.execute("UPDATE papers SET modified='changed' WHERE id=?", (request["mappings"][0]["paper_id"],)); con.commit(); con.close()
    with pytest.raises(external_rebind.RebindConflict):
        call(tmp_path, "external_rebind", **request, apply=True, expected_revision=preview["revision"])
    assert query(tmp_path, "SELECT count(*) FROM external_files WHERE source='paperassets'") == [(0,)]
    next_preview = call(tmp_path, "external_rebind", **request)
    path = target / request["mappings"][0]["new_relative"]
    path.write_bytes(path.read_bytes() + b"changed")
    with pytest.raises(external_rebind.RebindConflict):
        call(tmp_path, "external_rebind", **request, apply=True, expected_revision=next_preview["revision"])


@pytest.mark.parametrize("relative", ["../outside.pdf", "/absolute.pdf", "folder/../outside.pdf", "folder\\outside.pdf"])
def test_rebind_refuses_path_escape(tmp_path, relative):
    _, _, request = prepare(tmp_path)
    request["mappings"][0]["new_relative"] = relative
    with pytest.raises(ValueError):
        call(tmp_path, "external_rebind", **request)


def test_rebind_refuses_foreign_file_and_wrong_source_identity(tmp_path):
    _, _, request = prepare(tmp_path)
    path = tmp_path / "library/external/paperassets" / request["mappings"][0]["new_relative"]
    path.parent.mkdir(parents=True); path.write_bytes(b"unrelated sentinel")
    with pytest.raises(external_rebind.RebindConflict):
        call(tmp_path, "external_rebind", **request)
    assert path.read_bytes() == b"unrelated sentinel"
    path.unlink()
    request["target_source"]["id"] = request["source"]
    with pytest.raises(ValueError):
        call(tmp_path, "external_rebind", **request)


def test_mid_apply_failure_rolls_back_catalog_and_owned_links(tmp_path, monkeypatch):
    _, _, request = prepare(tmp_path)
    preview = call(tmp_path, "external_rebind", **request)
    original = external_rebind._restore_link
    failed = False
    def fail_once(path, value, root, **kwargs):
        nonlocal failed
        if not failed and "paperassets" in path.parts and path.name == "b.pdf" and value is not None:
            failed = True
            raise OSError("synthetic link failure")
        return original(path, value, root, **kwargs)
    monkeypatch.setattr(external_rebind, "_restore_link", fail_once)
    with pytest.raises(OSError, match="synthetic"):
        call(tmp_path, "external_rebind", **request, apply=True, expected_revision=preview["revision"])
    assert query(tmp_path, "SELECT count(*) FROM external_files WHERE source='paperassets'") == [(0,)]
    for mapping in request["mappings"]:
        assert (tmp_path / "library/external/legacy" / mapping["old_relative"]).is_symlink()
        assert not (tmp_path / "library/external/paperassets" / mapping["new_relative"]).is_symlink()


def test_index_builder_excludes_stale_entries_and_reports_the_gap(tmp_path):
    _, target, request = prepare(tmp_path)
    spec = importlib.util.spec_from_file_location("rebind_management", Path(__file__).parents[1] / "scripts/rebind-external.py")
    management = importlib.util.module_from_spec(spec); spec.loader.exec_module(management)
    entries = [{"path": str(target / item["new_relative"]), "size": item["expected_size"]} for item in request["mappings"]]
    missing_size = query(tmp_path, "SELECT size FROM external_files WHERE relative='unmatched.pdf'")[0][0]
    entries.append({"path": str(target / "unmatched.pdf"), "size": missing_size})
    index = tmp_path / "index.json"; index.write_text(json.dumps({"files": entries}))
    built, selection = management.build_request(tmp_path / "library", index, "legacy", "paperassets", target)
    assert selection["indexed_candidates"] == 3 and selection["candidate_mappings"] == 2
    assert selection["live_unavailable"] == 1 and selection["unmatched"] == 0
    assert len(built["mappings"]) == 2


def test_conflicting_target_identity_and_target_symlinks_are_rejected(tmp_path):
    _, target, request = prepare(tmp_path)
    con = sqlite3.connect(tmp_path / "library/catalog.sqlite3")
    con.execute("INSERT INTO external_sources(id,root) VALUES('another',?)", (str(target),)); con.commit(); con.close()
    with pytest.raises(external_rebind.RebindConflict):
        call(tmp_path, "external_rebind", **request)
    con = sqlite3.connect(tmp_path / "library/catalog.sqlite3")
    con.execute("DELETE FROM external_sources WHERE id='another'"); con.commit(); con.close()
    path = target / request["mappings"][0]["new_relative"]
    outside = tmp_path / "outside.pdf"; outside.write_bytes(path.read_bytes()); path.unlink(); path.symlink_to(outside)
    with pytest.raises(ValueError):
        call(tmp_path, "external_rebind", **request)


def test_link_created_after_preflight_is_never_overwritten(tmp_path, monkeypatch):
    _, _, request = prepare(tmp_path)
    preview = call(tmp_path, "external_rebind", **request)
    real_symlink = os.symlink
    destination = tmp_path / "library/external/paperassets" / request["mappings"][0]["new_relative"]
    injected = False
    def race(value, path, *args, **kwargs):
        nonlocal injected
        if Path(path) == destination and not injected:
            injected = True
            Path(path).write_bytes(b"ordinary file created after preflight")
        return real_symlink(value, path, *args, **kwargs)
    monkeypatch.setattr(os, "symlink", race)
    with pytest.raises(FileExistsError):
        call(tmp_path, "external_rebind", **request, apply=True, expected_revision=preview["revision"])
    assert destination.read_bytes() == b"ordinary file created after preflight"
    assert query(tmp_path, "SELECT count(*) FROM external_files WHERE source='paperassets'") == [(0,)]
    assert all((tmp_path / "library/external/legacy" / item["old_relative"]).is_symlink() for item in request["mappings"])


@pytest.mark.parametrize("replacement", ["symlink", "ordinary"])
def test_rollback_preserves_entries_replaced_by_another_owner(tmp_path, monkeypatch, replacement):
    _, _, request = prepare(tmp_path)
    preview = call(tmp_path, "external_rebind", **request)
    original = external_rebind._restore_link
    created = []
    replaced = None
    def interrupted(path, value, root, **kwargs):
        nonlocal replaced
        if "paperassets" in path.parts and value is not None:
            if created:
                replaced = created[0]; replaced.unlink()
                if replacement == "symlink": replaced.symlink_to("/synthetic-other-owner.pdf")
                else: replaced.write_bytes(b"other owner's ordinary file")
                raise OSError("synthetic interruption after ownership changed")
            identity = original(path, value, root, **kwargs)
            created.append(path)
            return identity
        return original(path, value, root, **kwargs)
    monkeypatch.setattr(external_rebind, "_restore_link", interrupted)
    with pytest.raises(RuntimeError, match="manual recovery"):
        call(tmp_path, "external_rebind", **request, apply=True, expected_revision=preview["revision"])
    if replacement == "symlink": assert os.readlink(replaced) == "/synthetic-other-owner.pdf"
    else: assert replaced.read_bytes() == b"other owner's ordinary file"
    assert query(tmp_path, "SELECT count(*) FROM external_files WHERE source='paperassets'") == [(0,)]
