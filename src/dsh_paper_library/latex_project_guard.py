"""Serialize operations against one registered manuscript's mutable binding."""
from contextlib import contextmanager

from filelock import FileLock, Timeout

LOCK_WAIT_SECONDS = 30


@contextmanager
def project_lock(library, project_id, *, compiling=False, wait=LOCK_WAIT_SECONDS):
    # project_id is validated by the caller before it becomes a filename.
    suffix = "-build" if compiling else ""
    lock = FileLock(library.root / f".latex-{project_id}{suffix}.lock", timeout=wait,
                    mode=0o600, fallback_to_soft=False, preserve_lock_file=True)
    try:
        lock.acquire()
    except Timeout as error:
        raise ValueError("此写作项目正在处理其他操作；请稍后重试。") from error
    try:
        yield
    finally:
        lock.release()


def check_binding(row, expected_root=None, expected_binding_generation=None):
    if expected_root is not None:
        if not isinstance(expected_root, str) or expected_root != row["root"]:
            raise ValueError("项目文件夹已变化；请重新打开项目。未保存的内容仍在当前编辑器中。")
    if expected_binding_generation is not None:
        if isinstance(expected_binding_generation, bool) or not isinstance(expected_binding_generation, int) or expected_binding_generation != row["binding_generation"]:
            raise ValueError("项目绑定已变化；请重新打开项目。未保存的内容仍在当前编辑器中。")
