"""按需转换单页；原始文字、派生 Markdown 与页面图像只缓存到私有资料库。"""
import base64
from contextlib import redirect_stdout
import hashlib
import importlib.metadata
import io
import json
import math
import os
import re
import struct
import tempfile

import pymupdf as fitz

SCHEMA_VERSION = "pdf-markdown-v2"
EXTRACTOR_VERSION = "0.2.9"
NORMALIZATIONS = ["soft-hyphen-single-linebreak-v1"]
SOFT_HYPHEN_LINEBREAK = re.compile(
    r"(?<=\w)\u00ad[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]*"
    r"\r?\n[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]*(?=\w)"
)
MAX_IMAGE_EDGE = 1600
MAX_IMAGE_BYTES = 1024 * 1024
MAX_IMAGES = 2
MAX_CACHE_TEXT_BYTES = 16 * 1024 * 1024


def digest(value):
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def engine():
    return {"engine": "pymupdf4llm-legacy", "engine_version": EXTRACTOR_VERSION,
            "pymupdf_version": fitz.__version__, "version": SCHEMA_VERSION,
            "derived": True, "ocr": False, "layout_model": False,
            "normalizations": list(NORMALIZATIONS),
            "annotations_included": False}


def cursor_version():
    return f"{SCHEMA_VERSION}/pymupdf4llm-{EXTRACTOR_VERSION}/pymupdf-{fitz.__version__}"


def page_identity(version, number):
    return {"file_version": version, "page": number, **engine()}


def cache_directory(library, paper_id, identity):
    key = digest(json.dumps({"paper_id": paper_id, **identity}, sort_keys=True))
    # 所有路径段由程序产生；拒绝以符号链接把私有缓存重定向到库外。
    root = library.root.resolve()
    current = root
    for part in ("derived", "pdf-analysis", key):
        current = current / part
        if current.is_symlink():
            raise ValueError("PAPER_ANALYSIS_INVALID: derived cache must not use symlinks")
        current.mkdir(mode=0o700, exist_ok=True)
        if not current.resolve().is_relative_to(root):
            raise ValueError("PAPER_ANALYSIS_INVALID: derived cache escaped the library")
    return key, current


def atomic_write(path, value):
    if path.is_symlink():
        raise ValueError("PAPER_ANALYSIS_INVALID: derived cache must not use symlinks")
    descriptor, temporary = tempfile.mkstemp(prefix=".preprocess-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def cached_json(path, limit):
    if path.is_symlink():
        raise ValueError("PAPER_ANALYSIS_INVALID: derived cache must not use symlinks")
    try:
        if path.stat().st_size > limit:
            return None
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None


def normalize_markdown(value):
    # 只连接显式软连字符标记的单次折行；不改普通连字符、减号或段落边界。
    return SOFT_HYPHEN_LINEBREAK.sub("", value)


def markdown_page(doc, number):
    """固定轻量提取器；单页临时副本不含批注，也不能被隐式扫描为整篇。"""
    try:
        installed_version = importlib.metadata.version("pymupdf4llm")
    except importlib.metadata.PackageNotFoundError:
        installed_version = None
    if installed_version != EXTRACTOR_VERSION:
        raise ValueError("PAPER_ANALYSIS_INVALID: install the pinned pymupdf4llm==0.2.9 dependency")
    # legacy helper 不会加载布局模型或调用 OCR。库导入提示不得污染 worker JSON。
    with redirect_stdout(io.StringIO()):
        from pymupdf4llm.helpers.pymupdf_rag import to_markdown
        with fitz.open() as selected:
            selected.insert_pdf(doc, from_page=number - 1, to_page=number - 1,
                                links=False, annots=False, widgets=False)
            markdown = to_markdown(selected, pages=[0], hdr_info=False,
                                   write_images=False, embed_images=False,
                                   ignore_images=True, force_text=True,
                                   detect_bg_color=False,
                                   fontsize_limit=0, show_progress=False).strip()
            return normalize_markdown(markdown)


def raw_page(doc, number):
    # 新版 PyMuPDF 的普通 get_text 可能包含 FreeText 批注；副本明确排除它。
    with fitz.open() as selected:
        selected.insert_pdf(doc, from_page=number - 1, to_page=number - 1,
                            links=False, annots=False, widgets=False)
        page = selected.load_page(0)
        text = page.get_text("text", sort=True)
        return text, bool(page.get_images(full=False)) if not text.strip() else None


def page_manifest(identity, key, raw, markdown, has_images):
    return {"identity": identity, "raw_text_sha256": digest(raw), "markdown_sha256": digest(markdown),
            "has_extractable_text": bool(raw.strip()), "has_images": has_images,
            "raw_characters": len(raw), "markdown_characters": len(markdown),
            "raw_verbatim": False, "representation": "normalized-markdown", "cache_key": key,
            "cache_files": {"raw_text": f"derived/pdf-analysis/{key}/raw.txt",
                            "markdown": f"derived/pdf-analysis/{key}/page.md"}}


def prepare_page(library, paper_id, doc, number, version):
    """返回已核对哈希的单页缓存，保留未经 Markdown 规范化的原始文字。"""
    identity = page_identity(version, number)
    key, directory = cache_directory(library, paper_id, identity)
    manifest = cached_json(directory / "page.json", 32768)
    if isinstance(manifest, dict) and manifest.get("identity") == identity:
        try:
            paths = [directory / "raw.txt", directory / "page.md"]
            if any(path.is_symlink() or path.stat().st_size > MAX_CACHE_TEXT_BYTES for path in paths):
                raise ValueError("Invalid cached text")
            raw, markdown = [path.read_text("utf-8") for path in paths]
            if (digest(raw) == manifest.get("raw_text_sha256") and digest(markdown) == manifest.get("markdown_sha256")
                    and (manifest.get("has_images") is None or isinstance(manifest.get("has_images"), bool))):
                # 不接受缓存清单提供的路径、字符数或额外字段；从当前固定键重新构造。
                checked = page_manifest(identity, key, raw, markdown, manifest.get("has_images"))
                return {**checked, "raw_text": raw, "markdown": markdown, "cache_hit": True}
        except (OSError, ValueError, UnicodeError):
            pass
    raw, has_images = raw_page(doc, number)
    # 无可抽取文字不冒充空白页；仅记录图像存在，绝不调用 OCR。
    markdown = markdown_page(doc, number) if raw.strip() else ""
    if max(len(raw.encode("utf-8")), len(markdown.encode("utf-8"))) > MAX_CACHE_TEXT_BYTES:
        raise ValueError("PAPER_ANALYSIS_INVALID: extracted page exceeds the 16 MiB cache limit")
    manifest = page_manifest(identity, key, raw, markdown, has_images)
    atomic_write(directory / "raw.txt", raw.encode("utf-8"))
    atomic_write(directory / "page.md", markdown.encode("utf-8"))
    atomic_write(directory / "page.json", json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
    return {**manifest, "raw_text": raw, "markdown": markdown, "cache_hit": False}


def page_image(library, paper_id, doc, number, version):
    """逐页 PNG，最多 1600 像素长边与 1 MiB；不渲染 PDF 批注。"""
    identity = {"file_version": version, "page": number, "version": "page-png-v1",
                "pymupdf_version": fitz.__version__, "max_edge": MAX_IMAGE_EDGE,
                "max_bytes": MAX_IMAGE_BYTES, "annotations_included": False}
    _, directory = cache_directory(library, paper_id, identity)
    path = directory / "page.png"
    manifest = cached_json(directory / "image.json", 32768)
    if isinstance(manifest, dict) and manifest.get("identity") == identity:
        try:
            if path.is_symlink() or path.stat().st_size > MAX_IMAGE_BYTES:
                raise ValueError("Invalid cached image")
            data = path.read_bytes()
            png_size = struct.unpack(">II", data[16:24]) if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 else (0, 0)
            if (digest(data) == manifest.get("sha256") and 0 < min(png_size) <= max(png_size) <= MAX_IMAGE_EDGE
                    and png_size == (manifest.get("width"), manifest.get("height"))
                    and manifest.get("page") == number and manifest.get("bytes") == len(data)
                    and manifest.get("mime_type") == "image/png" and manifest.get("annotations_included") is False):
                return {**{k: v for k, v in manifest.items() if k != "identity"},
                        "data": base64.b64encode(data).decode("ascii"), "cache_hit": True}
        except (OSError, ValueError):
            pass
    page = doc.load_page(number - 1)
    long_edge = max(page.rect.width, page.rect.height)
    if not math.isfinite(long_edge) or long_edge <= 0:
        raise ValueError("PAPER_ANALYSIS_INVALID: PDF page has invalid dimensions")
    scale = min(2.0, (MAX_IMAGE_EDGE - 1) / long_edge)
    reduced = False
    for _ in range(9):
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB,
                                alpha=False, annots=False)
        data = pixmap.tobytes("png")
        if len(data) <= MAX_IMAGE_BYTES and max(pixmap.width, pixmap.height) <= MAX_IMAGE_EDGE:
            manifest = {"identity": identity, "mime_type": "image/png", "page": number,
                        "width": pixmap.width, "height": pixmap.height, "sha256": digest(data),
                        "bytes": len(data), "scale": scale, "reduced_for_byte_limit": reduced,
                        "annotations_included": False}
            atomic_write(path, data)
            atomic_write(directory / "image.json", json.dumps(manifest).encode("utf-8"))
            return {**{k: v for k, v in manifest.items() if k != "identity"},
                    "data": base64.b64encode(data).decode("ascii"), "cache_hit": False}
        scale *= 0.75
        reduced = True
    raise ValueError("PAPER_ANALYSIS_IMAGE_LIMIT: page image could not fit its bounded PNG budget")


def page_provenance(prepared):
    return {key: prepared[key] for key in ("cache_key", "cache_files", "raw_text_sha256", "markdown_sha256",
                                           "raw_characters", "markdown_characters", "has_extractable_text", "has_images")}
