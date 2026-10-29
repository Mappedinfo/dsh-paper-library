"""Portable directory durability for local atomic replacements.

File descriptors are still flushed before replacement on every platform. POSIX
also flushes the containing directory. Windows' ordinary Python directory open
does not support that operation; skipping it preserves atomic replacement but
does not promise equivalent power-loss durability on every filesystem.
"""
import os
import sys

IS_WINDOWS = sys.platform == "win32"


def fsync_directory(path):
    """Flush a directory on POSIX; never try opening one for fsync on Windows."""
    if IS_WINDOWS:
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
