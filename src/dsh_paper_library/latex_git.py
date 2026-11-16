"""Git operations for a registered LaTeX folder inside its existing worktree."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
from time import sleep
from urllib.parse import urlsplit
from uuid import uuid4

from filelock import FileLock, Timeout

MAX_FILES = 200
MAX_OUTPUT = 512 * 1024
COMMIT_TIMEOUT = 300
PUSH_TIMEOUT = 180
INDEX_LOCK_WAIT = 4
INDEX_LOCK_STALE = 600
REPO_ENV = {
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX", "GIT_NAMESPACE", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
}
OID = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")


class _IndexLockBusy(ValueError):
    pass


def _git(cwd, *args, allowed=(0,), timeout=8, index_lock=None):
    binary = shutil.which("git")
    if binary is None:
        raise ValueError("本机没有可用的 Git。")
    env = {key: value for key, value in os.environ.items() if key not in REPO_ENV}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never", LC_ALL="C")
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        command = [binary, "--literal-pathspecs", "-c", "core.fsmonitor=false", *args]
        separate_group = os.name == "posix"
        previous = None
        if separate_group and threading.current_thread() is threading.main_thread():
            previous = signal.signal(signal.SIGTERM, _interrupted)
        try:
            with subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                  stdout=stdout, stderr=stderr, start_new_session=separate_group) as process:
                try:
                    code = process.wait(timeout=timeout)
                except BaseException as exc:
                    _stop_git(process, separate_group)
                    if not isinstance(exc, subprocess.TimeoutExpired):
                        raise
                    action = {"commit": "提交", "push": "推送"}.get(args[0], "读取")
                    detail = _diagnostic(stdout, stderr)
                    raise ValueError(f"Git {action}超过 {timeout} 秒，请刷新核对结果。"
                                     + (f" 最后输出：{detail}" if detail else "")) from exc
        finally:
            if previous is not None:
                signal.signal(signal.SIGTERM, previous)
        stdout.seek(0)
        captured = stdout.read(MAX_OUTPUT + 1)
        if len(captured) > MAX_OUTPUT:
            raise ValueError("Git 返回的改动列表超过读取上限。")
        if code not in allowed:
            if code == 128 and index_lock is not None:
                stderr.seek(0)
                first_error = stderr.readline(4096).decode("utf-8", "replace")
                if first_error.strip() == f"fatal: Unable to create '{index_lock}': File exists.":
                    raise _IndexLockBusy("Git 索引仍被占用，请等当前 Git 操作完成后再提交。")
            message = _diagnostic(stdout, stderr)
            raise ValueError(message or f"Git 操作失败（{code}）。")
        return code, captured


def _interrupted(signum, _):
    raise SystemExit(128 + signum)


def _stop_git(process, separate_group):
    try:
        if separate_group:
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=2)
    except ProcessLookupError:
        pass
    except subprocess.TimeoutExpired:
        try:
            if separate_group:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass


def _diagnostic(stdout, stderr):
    output = []
    for stream in (stdout, stderr):
        length = stream.seek(0, os.SEEK_END)
        stream.seek(max(0, length - 1600))
        output.append(stream.read(1600).decode("utf-8", "replace").strip())
    message = "\n".join(part for part in output if part)
    # Strip URL credentials and query strings from command diagnostics.
    return re.sub(r"[a-zA-Z][\w+.-]*://[^\s'\"]+", lambda m: _destination(m[0]), message)[-1200:]


def _text(cwd, *args, allowed=(0,)):
    _, result = _git(cwd, *args, allowed=allowed)
    return result.decode("utf-8", "replace").rstrip("\r\n")


def _destination(value):
    if "://" in value:
        try:
            parsed = urlsplit(value)
            return parsed.hostname + parsed.path if parsed.hostname else "远端"
        except ValueError:
            return "远端"
    value = value.split("?", 1)[0]
    return re.sub(r"^[^@/]+@(?=[^/]+:)", "", value)


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=True).encode()).hexdigest()


def _repo(library, paper_id):
    from .latex import _project

    row = _project(library, paper_id)
    folder = Path(row["root"])
    if not folder.is_dir():
        return None, None, "项目文件夹不可用。"
    if shutil.which("git") is None:
        return None, None, "本机没有可用的 Git。"
    code, raw = _git(folder, "rev-parse", "--show-toplevel", allowed=(0, 128))
    if code:
        return None, None, "未找到此项目所属的 Git 工作区。"
    repo = Path(os.fsdecode(raw).rstrip("\r\n")).resolve()
    scope = folder.resolve().relative_to(repo).as_posix()
    return repo, scope, None


def _history(repo, scope, revision, limit=8):
    command = ["log", f"-{limit}", "--format=%H%x00%s", "-z", revision, "--"]
    if scope is not None:
        command.append(scope)
    fields = _text(repo, *command).split("\0")
    return [{"id": oid, "subject": title[:200]} for oid, title in zip(fields[::2], fields[1::2]) if OID.fullmatch(oid)]


def _upstream(repo, branch, head):
    if not branch:
        return None, None
    remote = _text(repo, "config", "--get", f"branch.{branch}.remote", allowed=(0, 1))
    ref = _text(repo, "config", "--get", f"branch.{branch}.merge", allowed=(0, 1))
    if not remote or remote == "." or not ref.startswith("refs/heads/"):
        return None, None
    code, _ = _git(repo, "check-ref-format", ref, allowed=(0, 1))
    if code:
        return None, None
    urls = _text(repo, "remote", "get-url", "--push", "--all", "--", remote, allowed=(0, 2)).splitlines()
    if not urls:
        return None, None
    mirror = _text(repo, "config", "--bool", "--get", f"remote.{remote}.mirror", allowed=(0, 1)) == "true"
    upstream = _text(repo, "rev-parse", "--verify", "@{upstream}", allowed=(0, 128))
    data = {"remote": remote, "branch": ref[len("refs/heads/"):],
            "destinations": [_destination(url)[:220] for url in urls[:8]],
            "ready": bool(head and not mirror and len(urls) <= 8), "ahead": None, "behind": None, "outgoing": []}
    if upstream and head:
        data["ahead"], data["behind"] = map(int, _text(repo, "rev-list", "--left-right", "--count", f"{head}...{upstream}").split())
        data["outgoing"] = _history(repo, None, f"{upstream}..{head}")
    return data, (remote, ref, urls, upstream)


def _stamp(target):
    try:
        data = target.lstat()
    except FileNotFoundError:
        return None
    return data.st_ino, data.st_size, data.st_mtime_ns, data.st_ctime_ns


def _index_lock(repo):
    path = repo / _text(repo, "rev-parse", "--git-path", "index")
    return path.parent.resolve() / (path.name + ".lock")


def _index_in_use(lock):
    # Git can close the lock descriptor while running hooks, so lsof alone is insufficient.
    if os.name != "posix":
        return True
    try:
        pid_file = lock.with_name(lock.stem + "~pid.lock")
        if pid_file.is_symlink():
            return True
        if pid_file.is_file():
            with pid_file.open("rb") as stream:
                owner = re.fullmatch(rb"pid ([1-9][0-9]{0,9})\n", stream.read(64))
            if not owner:
                return True
            try:
                os.kill(int(owner[1]), 0)
                return True
            except ProcessLookupError:
                pass
        holders = subprocess.run(["lsof", "-nP", "-F", "p", "--", str(lock)],
                                 capture_output=True, timeout=2)
        if holders.returncode != 1 or holders.stdout or holders.stderr:
            return True
        processes = subprocess.check_output(["ps", "-ax", "-o", "comm="], stderr=subprocess.DEVNULL, timeout=2)
    except (OSError, OverflowError, subprocess.SubprocessError):
        return True
    return any(Path(os.fsdecode(process).strip()).name.lower().removesuffix(".exe").split("-")[0] == "git"
               for process in processes.splitlines())


def _wait_for_index(lock):
    deadline = time.monotonic() + INDEX_LOCK_WAIT
    check_again = 0
    while True:
        try:
            info = lock.lstat()
            if (os.name == "posix" and stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                    and info.st_nlink == 1 and time.monotonic() >= check_again
                    and time.time() - max(info.st_ctime, info.st_mtime) >= INDEX_LOCK_STALE):
                check_again = time.monotonic() + 1
                if not _index_in_use(lock) and lock.lstat() == info:
                    lock.rename(lock.with_name(f"{lock.name}.paper-library-recovered-{uuid4().hex}"))
                    return True
        except FileNotFoundError:
            return False
        except OSError:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        sleep(min(0.2, remaining))
    raise _IndexLockBusy("Git 索引仍被占用，或无法确认旧锁已经失效。已保留所选文件和提交说明，请等当前 Git 操作完成后再提交。")


def _state(repo, scope):
    branch = _text(repo, "symbolic-ref", "--quiet", "HEAD", allowed=(0, 1)).removeprefix("refs/heads/")
    head = _text(repo, "rev-parse", "--verify", "HEAD", allowed=(0, 128))
    _, raw = _git(repo, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", scope)
    changes, stamps, total = [], [], 0
    for record in raw.split(b"\0"):
        if not record:
            continue
        total += 1
        if len(changes) >= MAX_FILES:
            continue
        kind, path = record[:2].decode("ascii"), os.fsdecode(record[3:])
        # Porcelain -z always emits paths relative to the root of the worktree.
        relative = Path(path).relative_to(scope).as_posix()
        if len(relative) > 1024 or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in relative):
            continue
        changes.append({"path": relative, "status": kind})
        stamps.append(_stamp(repo / path))
    upstream, target = _upstream(repo, branch, head)
    return {"available": True, "repository": str(repo), "scope": scope, "branch": branch or None,
            "head": head or None, "changes": changes, "change_count": total,
            "history": _history(repo, scope, head) if head else [], "upstream": upstream,
            "version": _digest([str(repo), scope, branch, head, changes, stamps]),
            "push_version": _digest([str(repo), branch, head, target]) if target else None}, target


def status(library, id):
    repo, scope, error = _repo(library, id)
    if error:
        return {"available": False, "message": error}
    return _state(repo, scope)[0]


def _mutation(library, id, operation):
    repo, scope, error = _repo(library, id)
    if error:
        raise ValueError(error)
    lock = library.root / f".latex-git-{_digest(str(repo))}.lock"
    try:
        with FileLock(lock, timeout=2, mode=0o600):
            return operation(repo, scope)
    except Timeout as exc:
        raise ValueError("此 Git 仓库正在处理另一项操作，请稍后重试。") from exc


def commit(library, id, paths, message, expected_version):
    if (not isinstance(paths, list) or not 1 <= len(paths) <= MAX_FILES
            or any(not isinstance(path, str) or not 1 <= len(path) <= 1024 for path in paths) or len(set(paths)) != len(paths)):
        raise ValueError("请选择要提交的项目文件。")
    if not isinstance(message, str) or not message.strip() or len(message) > 2000 or "\0" in message:
        raise ValueError("请输入 1–2000 字符的提交说明。")

    def execute(repo, scope):
        state, _ = _state(repo, scope)
        if not state["branch"]:
            raise ValueError("请先切换到 Git 分支，再提交项目文件。")
        if state["version"] != expected_version:
            raise ValueError("Git 改动已变化，请刷新后重新核对要提交的文件。")
        changes = {row["path"]: row["status"] for row in state["changes"]}
        if any(path not in changes for path in paths):
            raise ValueError("部分文件已不在此项目的待提交列表中。")
        selected = [(Path(scope) / path).as_posix() for path in paths]
        new = [path for relative, path in zip(paths, selected) if changes[relative] == "??"]
        lock = _index_lock(repo)
        recovered = False

        def write_index(*args, version, timeout=8):
            nonlocal recovered
            try:
                _git(repo, *args, timeout=timeout, index_lock=lock)
            except _IndexLockBusy:
                recovered = _wait_for_index(lock) or recovered
                refreshed, _ = _state(repo, scope)
                if refreshed["version"] != version:
                    raise ValueError("等待 Git 索引时改动已变化，请刷新后重新核对要提交的文件。")
                _git(repo, *args, timeout=timeout, index_lock=lock)

        if new:
            write_index("add", "--intent-to-add", "--", *new, version=state["version"])
        try:
            version = _state(repo, scope)[0]["version"] if new else state["version"]
            write_index("commit", "--only", "-m", message.strip(), "--", *selected, version=version, timeout=COMMIT_TIMEOUT)
        except (ValueError, SystemExit) as error:
            # Remove the staging entries we introduced on ordinary commit failure.
            if new and _text(repo, "rev-parse", "--verify", "HEAD", allowed=(0, 128)) == (state["head"] or ""):
                _, staged = _git(repo, "diff", "--cached", "--name-only", "-z", "--ita-invisible-in-index", "--", *new)
                real_changes = set(staged.split(b"\0"))
                intent = [path for path in new if os.fsencode(path) not in real_changes]
                if intent:
                    try:
                        _git(repo, "rm", "--cached", "--ignore-unmatch", "--", *intent, index_lock=lock)
                    except _IndexLockBusy:
                        if isinstance(error, ValueError):
                            raise ValueError(f"{error} 新文件的待添加标记会保留到下次提交。") from error
            raise
        return {"head": _text(repo, "rev-parse", "--verify", "HEAD"), "index_lock_recovered": recovered}

    return _mutation(library, id, execute)


def push(library, id, expected_version):
    def execute(repo, scope):
        state, target = _state(repo, scope)
        if not target or not state["upstream"]["ready"]:
            raise ValueError("当前分支没有可推送的远端跟踪分支，或远端使用镜像推送。")
        if expected_version != state["push_version"]:
            raise ValueError("分支或推送目标已变化，请刷新并重新核对。")
        remote, ref, _, _ = target
        _git(repo, "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--",
             remote, f"{state['head']}:{ref}", timeout=PUSH_TIMEOUT)
        return {"head": state["head"], "remote": remote, "branch": state["upstream"]["branch"]}

    return _mutation(library, id, execute)
