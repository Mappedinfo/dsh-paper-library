"""Synthetic cross-platform locks and durable-write regression checks."""
import os
from contextlib import contextmanager
from pathlib import Path
import stat
import subprocess
import sys
import time

import pymupdf as fitz
import pytest

from dsh_paper_library import bibliography, library_knowledge, pdf_write, portable_io
from dsh_paper_library.core import Library


def child_env():
    return {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}


def run_child(code, *args):
    return subprocess.run([sys.executable, "-c", code, *map(str, args)], env=child_env(),
                          text=True, encoding="utf-8", capture_output=True, timeout=10)


def test_core_import_does_not_require_fcntl():
    result = run_child("""
import importlib.abc, sys
class NoFcntl(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'fcntl': raise ModuleNotFoundError('fcntl unavailable')
sys.meta_path.insert(0, NoFcntl())
from dsh_paper_library.core import Library
print('imported')
""")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "imported"


def test_windows_directory_sync_does_not_open_a_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(portable_io, "IS_WINDOWS", True)
    monkeypatch.setattr(portable_io.os, "open", lambda *args: pytest.fail("Windows must not open a directory for fsync"))
    monkeypatch.setattr(portable_io.os, "fsync", lambda *args: pytest.fail("Windows must not fsync directory handles"))
    portable_io.fsync_directory(tmp_path)


def test_posix_directory_sync_preserves_errors_and_closes_handle(monkeypatch, tmp_path):
    monkeypatch.setattr(portable_io, "IS_WINDOWS", False)
    calls = []
    monkeypatch.setattr(portable_io.os, "open", lambda path, flags: calls.append(("open", path)) or 42)
    monkeypatch.setattr(portable_io.os, "close", lambda fd: calls.append(("close", fd)))
    def failed_sync(fd):
        calls.append(("fsync", fd))
        raise OSError("synthetic flush failure")
    monkeypatch.setattr(portable_io.os, "fsync", failed_sync)
    with pytest.raises(OSError, match="flush failure"):
        portable_io.fsync_directory(tmp_path)
    assert calls == [("open", tmp_path), ("fsync", 42), ("close", 42)]


def test_library_lock_commits_rolls_back_and_releases_after_exception(tmp_path):
    library = Library(tmp_path / "library")
    try:
        with library.lock():
            library.db.execute("CREATE TABLE transaction_probe(value INTEGER)")
        with pytest.raises(RuntimeError, match="synthetic"):
            with library.lock():
                library.db.execute("INSERT INTO transaction_probe VALUES(1)")
                raise RuntimeError("synthetic operation failure")
        assert library.db.execute("SELECT count(*) FROM transaction_probe").fetchone()[0] == 0
        with library.lock():
            library.db.execute("INSERT INTO transaction_probe VALUES(2)")
        assert library.db.execute("SELECT value FROM transaction_probe").fetchone()[0] == 2
        assert (library.root / ".write.lock").is_file()
    finally:
        library.close()


def test_other_process_cannot_enter_a_held_library_lock_and_can_retry(tmp_path):
    root = tmp_path / "library"
    library = Library(root)
    code = """
import sys
from dsh_paper_library import papers
from dsh_paper_library.core import Library
papers.LIBRARY_LOCK_TIMEOUT_SECONDS = .15
library = Library(sys.argv[1])
library.create({'title':'Synthetic writer'})
library.close()
print('written')
"""
    try:
        with library.lock():
            blocked = run_child(code, root)
            assert blocked.returncode != 0
            assert "写锁" in blocked.stderr and "超时" in blocked.stderr
        passed = run_child(code, root)
        assert passed.returncode == 0, passed.stderr
        assert passed.stdout.strip() == "written"
    finally:
        library.close()


def test_process_termination_releases_native_library_lock(tmp_path):
    root, ready = tmp_path / "library", tmp_path / "holder-ready"
    Library(root).close()
    code = """
import sys,time
from pathlib import Path
from dsh_paper_library.core import Library
library = Library(sys.argv[1])
with library.lock():
    Path(sys.argv[2]).write_text('ready')
    time.sleep(60)
"""
    child = subprocess.Popen([sys.executable, "-c", code, str(root), str(ready)], env=child_env(),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(.02)
        assert ready.exists(), "synthetic lock holder failed to start"
        child.terminate()
        child.wait(timeout=5)
        result = run_child("""
import sys
from dsh_paper_library.core import Library
from dsh_paper_library import papers
papers.LIBRARY_LOCK_TIMEOUT_SECONDS = .2
library = Library(sys.argv[1])
library.create({'title':'Recovered after process termination'})
library.close()
print('recovered')
""", root)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "recovered"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        child.stdout.close()
        child.stderr.close()


def test_windows_branch_retains_file_flushes_and_native_pdf_annotations(tmp_path, monkeypatch):
    monkeypatch.setattr(portable_io, "IS_WINDOWS", True)
    original_sync, flushed = os.fsync, []
    def file_sync(fd):
        assert stat.S_ISREG(os.fstat(fd).st_mode), "directory flush escaped the platform helper"
        flushed.append(fd)
        original_sync(fd)
    monkeypatch.setattr(os, "fsync", file_sync)
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 60), "Synthetic evidence")
        page.add_text_annot((100, 100), "External synthetic note")
        doc.save(source)
    before = source.read_bytes()
    library = Library(tmp_path / "library-中文")
    try:
        item = library.create({"title": "Synthetic", "citekey": "synthetic2026"})
        library.attach(item["id"], str(source))
        library.annotate(item["id"], page=1, rects=[[40, 45, 150, 65]], text="Synthetic evidence", comment="Owned synthetic note")
        library.update(item["id"], {"title": "Synthetic updated"})
        notes = library.annotations(item["id"])["annotations"]
        assert {note["comment"] for note in notes} == {"External synthetic note", "Owned synthetic note"}
        bibliography.write_export(library, {"bib_text": "@article{synthetic2026,title={Synthetic}}", "audit": bibliography.audit(library, {})})
        source_note = library_knowledge.dispatch(library, {"action": "knowledge_source_put", "entity": {"kind": "paper", "id": item["id"]},
            "kind": "user-text", "text": "A synthetic source."})
        note = library_knowledge.dispatch(library, {"action": "knowledge_note_put", "entity": {"kind": "paper", "id": item["id"]},
            "source_ids": [source_note["id"]], "title": "Synthetic", "body": "A synthetic private note.", "expected_revision": 0})
        assert library_knowledge.dispatch(library, {"action": "knowledge_note_get", "id": note["id"]})["body"] == "A synthetic private note."
        assert source.read_bytes() == before
        assert len(flushed) >= 6
    finally:
        library.close()


def test_file_fsync_failure_does_not_replace_existing_data(tmp_path, monkeypatch):
    monkeypatch.setattr(portable_io, "IS_WINDOWS", True)
    path = tmp_path / "existing.txt"
    path.write_bytes(b"preserved original")
    def failure(fd):
        assert stat.S_ISREG(os.fstat(fd).st_mode)
        raise OSError("synthetic file flush failure")
    monkeypatch.setattr(os, "fsync", failure)
    with pytest.raises(OSError, match="file flush failure"):
        bibliography._atomic_write(path, b"replacement")
    assert path.read_bytes() == b"preserved original"
    assert not list(tmp_path.glob("*.tmp-*"))


def test_pdf_file_flush_uses_a_descriptor_windows_can_commit(tmp_path, monkeypatch):
    """Emulate Windows _commit rejecting a read-only file descriptor on any OS."""
    import builtins
    import errno
    original_sync, opened = os.fsync, {}
    def track_open(*args, **kwargs):
        handle = builtins.open(*args, **kwargs)
        if Path(handle.name).name.startswith(".pdf-write-"):
            opened[handle.fileno()] = handle.writable()
        return handle
    def strict_file_commit(fd):
        if fd in opened and not opened[fd]:
            raise OSError(errno.EBADF, "Windows cannot commit a read-only file descriptor")
        original_sync(fd)
    monkeypatch.setattr(pdf_write, "open", track_open, raising=False)
    monkeypatch.setattr(os, "fsync", strict_file_commit)
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 60), "Synthetic content")
        doc.save(source)
    library = Library(tmp_path / "library")
    try:
        item = library.create({"title": "Synthetic commit"})
        library.attach(item["id"], str(source))
        assert opened and all(opened.values())
        assert library.pdf_path(item["id"]).is_file()
    finally:
        library.close()


def test_pdf_replacement_closes_owned_source_before_publish(tmp_path, monkeypatch):
    """Enforce Windows' no-replace-while-open rule on every test platform."""
    import errno
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 60), "Synthetic source")
        doc.save(source)
    original = source.read_bytes()
    library = Library(tmp_path / "library")
    open_pdf, replace = library._open_pdf, os.replace
    active, replaced = {}, []
    @contextmanager
    def tracked_pdf(path, writing=False):
        path = Path(path).resolve()
        with open_pdf(path, writing=writing) as doc:
            active[path] = doc
            try:
                yield doc
            finally:
                active.pop(path, None)
    def windows_replace(staged, target):
        path = Path(target).resolve()
        if path in active and not active[path].is_closed:
            raise PermissionError(errno.EACCES, "Windows refuses to replace an open PDF")
        if path.suffix.lower() == ".pdf":
            replaced.append(path)
        return replace(staged, target)
    monkeypatch.setattr(library, "_open_pdf", tracked_pdf)
    monkeypatch.setattr(os, "replace", windows_replace)
    try:
        item = library.create({"title": "Synthetic managed PDF"})
        library.attach(item["id"], str(source))
        library.annotate(item["id"], page=1, type="note", comment="Persisted with source closed")
        assert replaced.count(library.pdf_path(item["id"]).resolve()) == 2
        assert library.annotations(item["id"])["annotations"][0]["comment"] == "Persisted with source closed"
        assert source.read_bytes() == original
        assert not active
    finally:
        library.close()


def test_pdf_validation_failure_closes_owned_document(tmp_path, monkeypatch):
    source = tmp_path / "synthetic.png"
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 10, 10), False)
    pixmap.clear_with(220)
    pixmap.save(source)
    actual_open, opened = fitz.open, []
    def tracked_open(*args, **kwargs):
        doc = actual_open(*args, **kwargs)
        opened.append(doc)
        return doc
    monkeypatch.setattr(fitz, "open", tracked_open)
    with pytest.raises(ValueError, match="non-PDF"):
        with pdf_write.PdfWrites._open_pdf(source):
            pytest.fail("a non-PDF must not enter the owning context")
    assert opened and all(doc.is_closed for doc in opened)


def test_failed_pdf_verification_releases_source_and_preserves_original(tmp_path, monkeypatch):
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 60), "Synthetic source")
        doc.save(source)
    library = Library(tmp_path / "library")
    try:
        item = library.create({"title": "Synthetic original"})
        library.attach(item["id"], str(source))
        managed = library.pdf_path(item["id"])
        before = managed.read_bytes()
        original_open, writers = library._open_pdf, []
        @contextmanager
        def rejected_staging(path, writing=False):
            if Path(path).name.startswith(".pdf-write-"):
                raise ValueError("synthetic saved-PDF validation failure")
            with original_open(path, writing=writing) as doc:
                if writing:
                    writers.append(doc)
                yield doc
        monkeypatch.setattr(library, "_open_pdf", rejected_staging)
        with pytest.raises(ValueError, match="saved-PDF validation"):
            library.annotate(item["id"], page=1, type="note", comment="Must not publish")
        assert writers and all(doc.is_closed for doc in writers)
        assert managed.read_bytes() == before
        assert not list(managed.parent.glob(".pdf-write-*"))
        with library.lock():
            pass
    finally:
        library.close()
