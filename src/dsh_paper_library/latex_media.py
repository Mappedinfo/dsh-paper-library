"""One bounded project asset at a time, always returned as inert PNG pixels."""
from __future__ import annotations

import base64
import math
import re
import struct
from pathlib import Path
import xml.etree.ElementTree as ET

# Allocation safety, not a quality cap: requests are fulfilled at their exact
# density or explicitly refused. Never silently downsample a reader's zoom.
MAX_PIXELS = 64_000_000
MAX_SIDE = 16000
MAX_ASSET_BYTES = 32 * 1024 * 1024
MAX_ENCODED_BYTES = 18 * 1024 * 1024
PREVIEW_SUFFIXES = {".png", ".jpg", ".jpeg", ".svg", ".pdf"}


def image_dimensions(data, suffix):
    """Read dimensions before decoding pixels; no optional imaging dependency."""
    if suffix == ".png" and data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        return struct.unpack(">II", data[16:24])
    if suffix in {".jpg", ".jpeg"} and data.startswith(b"\xff\xd8"):
        pos = 2
        while pos + 4 <= len(data):
            if data[pos] != 0xFF:
                break
            while pos < len(data) and data[pos] == 0xFF:
                pos += 1
            if pos >= len(data):
                break
            marker = data[pos]
            pos += 1
            if marker in {0x01, *range(0xD0, 0xD9)}:
                continue
            if marker in {0xD9, 0xDA} or pos + 2 > len(data):
                break
            length = int.from_bytes(data[pos:pos + 2], "big")
            if length < 2 or pos + length > len(data):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 7:
                height, width = struct.unpack(">HH", data[pos + 3:pos + 7])
                return width, height
            pos += length
    raise ValueError("媒体文件头无效或与扩展名不符")


def safe_svg(data):
    """Reject active/external content before passing SVG to a native rasterizer."""
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("SVG 过大或包含外部声明，无法安全预览")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("SVG 预览要求 UTF-8 编码") from None
    if re.search(r"<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|\x00", text, re.I):
        raise ValueError("SVG 包含外部声明，无法安全预览")
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise ValueError("SVG 格式无效") from None
    for node in root.iter():
        name = node.tag.rsplit("}", 1)[-1].lower()
        if name in {"script", "foreignobject", "iframe", "audio", "video", "image", "feimage"}:
            raise ValueError("SVG 包含脚本、嵌入内容或外部图片，无法安全预览")
        for key, value in node.attrib.items():
            key = key.rsplit("}", 1)[-1].lower()
            if key.startswith("on") or key == "base" or (key in {"href", "src"} and not value.startswith("#")):
                raise ValueError("SVG 包含事件或外部引用，无法安全预览")
        css = " ".join(node.attrib.values()) + " " + (node.text or "")
        if re.search(r"@import|url\(\s*[\"']?(?!#)", css, re.I):
            raise ValueError("SVG 包含外部样式引用，无法安全预览")
    return data


def render(document, page, scale):
    import pymupdf as fitz
    try:
        scale = float(scale)
    except (TypeError, ValueError):
        raise ValueError("渲染比例必须是数字") from None
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("渲染比例必须是正数")
    if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= document.page_count:
        raise ValueError("页码超出范围")
    current = document[page - 1]
    width, height = current.rect.width, current.rect.height
    if not all(math.isfinite(value) and value > 0 for value in (width, height)):
        raise ValueError("页面尺寸无效")
    if not math.isfinite(width * scale) or not math.isfinite(height * scale):
        raise ValueError("请求的渲染尺寸超过单页内存安全预算；未降低清晰度")
    pixel_width, pixel_height = math.ceil(width * scale), math.ceil(height * scale)
    if pixel_width * pixel_height > MAX_PIXELS or max(pixel_width, pixel_height) > MAX_SIDE:
        raise ValueError(f"请求的 {pixel_width} × {pixel_height} 像素超过单页内存安全预算；未降低清晰度。请缩窄预览区或降低缩放后重试")
    pix = current.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    data = pix.tobytes("png")
    if len(data) > MAX_ENCODED_BYTES:
        raise ValueError("预览图像超过传输预算，请降低缩放")
    return {"page": page, "page_count": document.page_count, "width": width, "height": height,
            "pixel_width": pix.width, "pixel_height": pix.height, "scale": scale,
            "requested_scale": scale, "limited": False,
            "rotation": current.rotation, "mime_type": "image/png", "image": base64.b64encode(data).decode("ascii"),
            "limits": {"allocation_pixels": MAX_PIXELS, "allocation_side": MAX_SIDE, "quality_downsampling": False}}


def preview(library, row, path, page=1, scale=1):
    import pymupdf as fitz
    from .latex import _inside

    absolute, relative = _inside(Path(row["root"]), path, "媒体路径")
    if not absolute.is_file():
        raise ValueError("媒体文件不存在")
    suffix = absolute.suffix.lower()
    stat = absolute.stat()
    metadata = {"id": row["id"], "path": relative, "bytes": stat.st_size, "version": f"{stat.st_mtime_ns}:{stat.st_size}"}
    if suffix not in PREVIEW_SUFFIXES:
        return {**metadata, "supported": False, "reason": "此文件类型暂不支持预览；可从文件侧栏打开文本源文件"}
    if suffix == ".pdf":
        with library._open_pdf(absolute) as document:
            return {**metadata, "supported": True, **render(document, page, scale)}
    if stat.st_size > MAX_ASSET_BYTES:
        raise ValueError("媒体超过 32 MiB 预览预算")
    data = absolute.read_bytes()
    if suffix == ".svg":
        safe_svg(data)
    else:
        width, height = image_dimensions(data, suffix)
        if not width or not height or width * height > 64_000_000:
            raise ValueError("媒体格式无效或源图像超过 6400 万像素")
        metadata["source_width"], metadata["source_height"] = width, height
    with fitz.open(stream=data, filetype=suffix[1:]) as document:
        return {**metadata, "supported": True, **render(document, page, scale)}
