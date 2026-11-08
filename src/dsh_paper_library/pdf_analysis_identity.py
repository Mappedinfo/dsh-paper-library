"""单篇分析的 PDF 底稿身份；批注、链接、附件与题录不属于正文。"""
import hashlib
import json
import os
import tempfile

import pymupdf as fitz

from . import pdf_preprocessing as preprocessing

MAX_SOURCE_BYTES = 512 * 1024 * 1024
SCHEMA = "pdf-content-v1"


def observed_file(path):
    stat = path.stat()
    if stat.st_size > MAX_SOURCE_BYTES:
        raise ValueError("PAPER_ANALYSIS_INVALID: PDF exceeds 512 MiB analysis input limit")
    return {"device": stat.st_dev, "inode": stat.st_ino, "bytes": stat.st_size,
            "modified_ns": str(stat.st_mtime_ns), "changed_ns": str(stat.st_ctime_ns)}


def content_version(library, paper_id, path, doc, observed):
    """不提词或渲染整篇；按需复制 PDF 底稿对象，文件未变则复用单份缓存。"""
    _, directory = preprocessing.cache_directory(library, paper_id, {"kind": SCHEMA})
    manifest_path = directory / "identity.json"
    cached = preprocessing.cached_json(manifest_path, 8192)
    if isinstance(cached, dict) and cached.get("observed") == observed:
        version = cached.get("version")
        if (isinstance(version, dict) and version.get("schema") == SCHEMA
                and version.get("page_count") == doc.page_count
                and isinstance(version.get("sha256"), str) and len(version["sha256"]) == 64):
            return version
    # MuPDF 自身完成对象图复制，避免手写 PDF 解析器和 xref 归一化。
    # 只在明确请求本篇分析且文件发生变化时运行；仍受 worker 超时和 2000 页上限约束。
    descriptor, temporary = tempfile.mkstemp(prefix=".base-", suffix=".pdf", dir=directory)
    os.close(descriptor)
    try:
        with fitz.open() as base:
            base.insert_pdf(doc, links=False, annots=False, widgets=False)
            base.save(temporary, garbage=4, deflate=True, no_new_id=True)
        if os.path.getsize(temporary) > MAX_SOURCE_BYTES:
            raise ValueError("PAPER_ANALYSIS_INVALID: PDF analysis base exceeds 512 MiB limit")
        digest = hashlib.sha256()
        with open(temporary, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        version = {"schema": SCHEMA, "sha256": digest.hexdigest(), "page_count": doc.page_count}
        if observed_file(path) == observed:
            # 并发批注原子替换时不缓存旧文件到新观察值；调用端会重开并核对底稿。
            preprocessing.atomic_write(manifest_path, json.dumps({"observed": observed, "version": version}).encode())
        return version
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
