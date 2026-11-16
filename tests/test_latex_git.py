import shlex
import shutil
import subprocess

import pytest

from dsh_paper_library.core import dispatch
from dsh_paper_library import latex_git


def git(where, *args):
    return subprocess.check_output(["git", "-C", str(where), *args], text=True, stderr=subprocess.PIPE).strip()


def test_latex_git_uses_parent_repo_commits_only_selected_files_and_pushes_reviewed_head(tmp_path):
    repo = tmp_path / "work"
    project = repo / "manuscript"
    project.mkdir(parents=True)
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "config", "user.name", "Synthetic fixture")
    remote = tmp_path / "remote"
    remote.mkdir()
    git(remote, "init", "--bare")
    git(repo, "remote", "add", "origin", str(remote))
    main = project / "main.tex"
    main.write_text(r"\section{Introduction}" + "\n")
    other = repo / "other.txt"
    other.write_text("initial\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "Start")
    git(repo, "push", "-u", "origin", "main")

    request = {"library": str(tmp_path / "library")}
    created = dispatch({**request, "action": "latex_project_create", "root": str(project)})["project"]
    request["id"] = created["id"]

    def call(operation, **args):
        return dispatch({**request, "action": f"latex_git_{operation}", **args})

    main.write_text("An update\n")
    fresh = project / "new [version].bib"
    fresh.write_text("@misc{sample,title={Test}}\n")
    other.write_text("unrelated staged change\n")
    git(repo, "add", "other.txt")
    state = call("status")
    assert state["repository"] == str(repo)
    assert state["scope"] == "manuscript"
    assert state["branch"] == "main"
    assert state["history"][0]["subject"] == "Start"
    assert {change["path"] for change in state["changes"]} == {"main.tex", fresh.name}
    assert state["upstream"]["ahead"] == state["upstream"]["behind"] == 0
    with pytest.raises(ValueError, match="不在此项目"):
        call("commit", paths=["../other.txt"], message="invalid", expected_version=state["version"])

    main.write_text("A different update\n")
    with pytest.raises(ValueError, match="已变化"):
        call("commit", paths=["main.tex"], message="stale", expected_version=state["version"])
    reviewed = call("status")
    saved = call("commit", paths=["main.tex", fresh.name], message="Update manuscript", expected_version=reviewed["version"])
    assert set(git(repo, "show", "--format=", "--name-only", "HEAD").splitlines()) == {
        "manuscript/main.tex", "manuscript/new [version].bib",
    }
    assert git(repo, "diff", "--cached", "--name-only") == "other.txt"
    outgoing = call("status")
    assert not outgoing["changes"]
    assert outgoing["upstream"]["ahead"] == 1
    assert outgoing["upstream"]["outgoing"][0]["id"] == saved["head"]
    with pytest.raises(ValueError, match="目标已变化"):
        call("push", expected_version=reviewed["push_version"])
    pushed = call("push", expected_version=outgoing["push_version"])
    assert pushed["head"] == git(remote, "rev-parse", "refs/heads/main")
    assert git(repo, "diff", "--cached", "--name-only") == "other.txt"


def test_latex_git_protects_project_binding_and_keeps_untracked_on_failed_commit(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    main = repo / "main.tex"
    main.write_text("Original\n")
    request = {"library": str(tmp_path / "library"), "root": str(repo)}
    project = dispatch({**request, "action": "latex_project_create"})["project"]
    base = {"library": request["library"], "id": project["id"]}
    assert not dispatch({**base, "action": "latex_git_status"})["available"]
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "config", "user.name", "Synthetic fixture")
    state = dispatch({**base, "action": "latex_git_status"})
    command = {**base, "action": "latex_git_commit", "paths": ["main.tex"], "message": "First", "expected_version": state["version"]}
    with pytest.raises(ValueError, match="绑定已变化"):
        dispatch({**command, "expected_binding_generation": 1})
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    with pytest.raises(ValueError):
        dispatch(command)
    assert git(repo, "status", "--short") == "?? main.tex"
    assert main.read_text() == "Original\n"
    hook.unlink()
    assert dispatch({**command, "expected_version": dispatch({**base, "action": "latex_git_status"})["version"]})["head"]


@pytest.fixture
def git_commit_fixture(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "config", "user.name", "Synthetic fixture")
    (repo / "main.tex").write_text("Original\n")
    git(repo, "add", "main.tex")
    git(repo, "commit", "-m", "Start")

    def prepare(worktree, filename="main.tex"):
        (worktree / filename).write_text("Reviewed change\n")
        base = {"library": str(tmp_path / "library")}
        base["id"] = dispatch({**base, "action": "latex_project_create", "root": str(worktree)})["project"]["id"]
        state = dispatch({**base, "action": "latex_git_status"})
        return {**base, "action": "latex_git_commit", "paths": [filename], "message": "Reviewed", "expected_version": state["version"]}

    return repo, prepare


def test_latex_git_retires_stale_worktree_lock_and_retries_add(git_commit_fixture, monkeypatch):
    repo, prepare = git_commit_fixture
    worktree = repo.parent / "linked manuscript"
    git(repo, "worktree", "add", "-b", "linked", str(worktree))
    request = prepare(worktree, "new.tex")
    lock = latex_git._index_lock(worktree)
    primary_lock = latex_git._index_lock(repo)
    assert lock != primary_lock
    primary_lock.write_bytes(b"Unrelated lock")
    lock.write_bytes(b"Original lock bytes")
    monkeypatch.setattr(latex_git, "INDEX_LOCK_STALE", 0)
    monkeypatch.setattr(latex_git, "_index_in_use", lambda path: False)
    result = dispatch(request)
    assert result["index_lock_recovered"]
    assert result["head"] == git(worktree, "rev-parse", "HEAD")
    assert git(worktree, "show", "--format=", "--name-only", "HEAD") == "new.tex"
    assert primary_lock.read_bytes() == b"Unrelated lock"
    assert not lock.exists()
    recovered, = lock.parent.glob("index.lock.paper-library-recovered-*")
    assert recovered.read_bytes() == b"Original lock bytes"


@pytest.mark.parametrize("edited", [False, True])
def test_latex_git_waits_for_temporary_lock_and_rechecks_review(git_commit_fixture, monkeypatch, edited):
    repo, prepare = git_commit_fixture
    request = prepare(repo)
    lock = latex_git._index_lock(repo)
    lock.touch()
    head = git(repo, "rev-parse", "HEAD")

    def release(_):
        if edited:
            (repo / "main.tex").write_text("Changed while waiting\n")
        lock.unlink()

    monkeypatch.setattr(latex_git, "sleep", release)
    if edited:
        with pytest.raises(ValueError, match="等待 Git 索引时改动已变化"):
            dispatch(request)
        assert git(repo, "rev-parse", "HEAD") == head
    else:
        result = dispatch(request)
        assert result["head"] != head and not result["index_lock_recovered"]
    assert not list(lock.parent.glob("index.lock.paper-library-recovered-*"))


@pytest.mark.skipif(not shutil.which("lsof"), reason="File-holder detection requires lsof")
def test_latex_git_preserves_an_old_lock_still_open(git_commit_fixture, monkeypatch):
    repo, prepare = git_commit_fixture
    request = prepare(repo)
    lock = latex_git._index_lock(repo)
    monkeypatch.setattr(latex_git, "INDEX_LOCK_STALE", 0)
    monkeypatch.setattr(latex_git, "INDEX_LOCK_WAIT", 0)
    with lock.open("wb") as holder:
        holder.write(b"Occupied")
        holder.flush()
        with pytest.raises(ValueError, match="Git 索引仍被占用"):
            dispatch(request)
        assert lock.read_bytes() == b"Occupied"
    assert not list(lock.parent.glob("index.lock.paper-library-recovered-*"))


def test_latex_git_does_not_replay_a_failing_hook_that_reports_a_lock(git_commit_fixture):
    repo, prepare = git_commit_fixture
    request = prepare(repo)
    lock = latex_git._index_lock(repo)
    attempts = lock.parent / "hook-attempts"
    hook = lock.parent / "hooks" / "pre-commit"
    diagnostic = f"fatal: Unable to create '{lock}': File exists."
    hook.write_text(f"#!/bin/sh\necho attempt >> {shlex.quote(str(attempts))}\necho {shlex.quote(diagnostic)} >&2\nexit 1\n")
    hook.chmod(0o755)
    with pytest.raises(ValueError, match="Unable to create"):
        dispatch(request)
    assert attempts.read_text() == "attempt\n"
    assert not lock.exists()
