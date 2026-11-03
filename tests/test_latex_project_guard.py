"""Synthetic checks for root binding and project-scoped serialization."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.latex_project_guard import project_lock


def test_stale_window_cannot_read_write_or_compile_in_rebound_folder(tmp_path):
    old = tmp_path / "old"
    new = tmp_path / "new"
    old.mkdir()
    new.mkdir()
    for root in (old, new):
        (root / "main.tex").write_text("same source\n", encoding="utf-8")
    config = {"library": str(tmp_path / "library")}
    project = dispatch({**config, "action": "latex_project_create", "root": str(old)})["project"]
    read = dispatch({**config, "action": "latex_read", "id": project["id"], "expected_root": str(old)})
    db = Library(config["library"])
    try:
        db.db.execute("UPDATE latex_projects SET root=? WHERE id=?", (str(new), project["id"]))
        db.db.commit()
    finally:
        db.close()
    for action, args in [
        ("latex_read", {}),
        ("latex_write", {"path": "main.tex", "content": "stale edit", "expected_revision": read["revision"]}),
        ("latex_compile", {}),
    ]:
        with pytest.raises(ValueError, match="项目文件夹已变化"):
            dispatch({**config, "action": action, "id": project["id"], "expected_root": str(old), **args})
    assert (new / "main.tex").read_text(encoding="utf-8") == "same source\n"
    assert (old / "main.tex").read_text(encoding="utf-8") == "same source\n"


def test_project_actions_wait_for_same_project_lock(tmp_path):
    root = tmp_path / "manuscript"
    root.mkdir()
    (root / "main.tex").write_text("safe\n", encoding="utf-8")
    config = {"library": str(tmp_path / "library")}
    project = dispatch({**config, "action": "latex_project_create", "root": str(root)})["project"]
    db = Library(config["library"])
    started = Event()
    revision = dispatch({**config, "action": "latex_read", "id": project["id"]})["revision"]
    def write():
        started.set()
        return dispatch({**config, "action": "latex_write", "id": project["id"], "path": "main.tex", "content": "changed\n", "expected_revision": revision, "expected_root": str(root)})
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            with project_lock(db, project["id"]):
                future = executor.submit(write)
                assert started.wait(2)
                assert not future.done()
            assert future.result(timeout=5)["changed"]
    finally:
        db.close()


def test_build_lock_does_not_block_reads_or_saves_but_prevents_rebinding(tmp_path):
    root = tmp_path / "manuscript"
    root.mkdir()
    (root / "main.tex").write_text("safe\n", encoding="utf-8")
    config = {"library": str(tmp_path / "library")}
    project = dispatch({**config, "action": "latex_project_create", "root": str(root)})["project"]
    db = Library(config["library"])
    try:
        with project_lock(db, project["id"], compiling=True):
            read = dispatch({**config, "action": "latex_read", "id": project["id"], "expected_root": str(root)})
            written = dispatch({**config, "action": "latex_write", "id": project["id"], "path": "main.tex", "content": "changed\n", "expected_revision": read["revision"], "expected_root": str(root)})
            assert written["changed"]
            with pytest.raises(ValueError, match="正在处理其他操作"):
                dispatch({**config, "action": "latex_project_update", "id": project["id"], "title": "other", "expected_root": str(root)})
    finally:
        db.close()


def test_binding_generation_prevents_aba_and_old_client_writes(tmp_path):
    root = tmp_path / "manuscript"
    root.mkdir()
    for name in ("main.tex", "other.tex"):
        (root / name).write_text("same source\n", encoding="utf-8")
    config = {"library": str(tmp_path / "library")}
    project = dispatch({**config, "action": "latex_project_create", "root": str(root), "main_path": "main.tex"})["project"]
    assert project["binding_generation"] == 0
    original = dispatch({**config, "action": "latex_read", "id": project["id"]})
    changed = dispatch({**config, "action": "latex_project_update", "id": project["id"], "main_path": "other.tex", "expected_binding_generation": 0})["project"]
    returned = dispatch({**config, "action": "latex_project_update", "id": project["id"], "main_path": "main.tex", "expected_binding_generation": changed["binding_generation"]})["project"]
    assert returned["binding_generation"] == 2
    write = {**config, "action": "latex_write", "id": project["id"], "path": "main.tex", "content": "new\n", "expected_revision": original["revision"]}
    for extra in ({}, {"expected_binding_generation": 0}, {"expected_binding_generation": True}, {"expected_binding_generation": None}):
        with pytest.raises(ValueError, match="项目绑定已变化"):
            dispatch({**write, **extra})
    assert (root / "main.tex").read_text(encoding="utf-8") == "same source\n"
    assert dispatch({**write, "expected_binding_generation": 2})["changed"]
