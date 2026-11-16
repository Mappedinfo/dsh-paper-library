import subprocess

import pytest

from dsh_paper_library.core import dispatch


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
