"""只读比较 PDF 的正文、视觉底稿和标准批注；仅输出摘要，不输出原文。

渲染摘要只证明指定分辨率的视觉一致，不能证明 PDF 结构或任意精度一致。
此工具不识别 Zotero 数据库中的外部批注，也不移除、合并或保存 PDF。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
from collections import Counter
from pathlib import Path

import pymupdf

MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
MAX_ANNOTATIONS = 100000
SUPPORTED = {"Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
             "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret",
             "Ink", "FileAttachment", "Redact"}
EXCLUDED = {"Link", "Widget", "Popup"}
RAW_FIELDS = ("RC", "DA", "DS", "Q", "State", "StateModel", "RT", "IT", "IC",
              "RD", "LE", "LL", "LLE", "LLO", "Cap", "CP", "Measure", "BE",
              "BS", "Border", "BM", "AS", "Open", "CL", "OverlayText", "Repeat")


class FingerprintError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8", errors="replace")


def _digest(value):
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _feed(digest, value):
    data = value if isinstance(value, (bytes, bytearray, memoryview)) else _json_bytes(value)
    digest.update(len(data).to_bytes(8, "big"))
    digest.update(data)


def _stat(value):
    return {"dev": value.st_dev, "ino": value.st_ino, "size": value.st_size,
            "mtime_ns": value.st_mtime_ns, "ctime_ns": value.st_ctime_ns}


def _simple(value):
    if isinstance(value, dict):
        return {str(k): _simple(v) for k, v in value.items()}
    if isinstance(value, (tuple, list, pymupdf.Rect, pymupdf.Point, pymupdf.Quad)):
        return [_simple(v) for v in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise FingerprintError("nonfinite_geometry")
        return 0 if value == 0 else value
    if value is None or isinstance(value, (str, int, bool)):
        return value
    raise FingerprintError("unsupported_value")


def _raw_value(doc, xref, key, depth=0, ancestors=()):
    """规范化常用 PDF 值；对象引用按内容展开，不把对象编号当作语义。"""
    if depth > 8:
        raise FingerprintError("annotation_value_depth")
    kind, value = doc.xref_get_key(xref, key)
    if kind == "xref":
        target = int(value.split()[0])
        if target in ancestors or doc.xref_is_stream(target):
            raise FingerprintError("unsupported_annotation_reference")
        keys = doc.xref_get_keys(target)
        if len(keys) > 256:
            raise FingerprintError("annotation_value_size")
        return {k: _raw_value(doc, target, k, depth + 1, (*ancestors, target))
                for k in sorted(keys) if k not in {"M", "CreationDate", "NM"}}
    if kind in {"int", "float"}:
        return float(value)
    if kind == "bool":
        return value == "true"
    if kind == "null":
        return None
    if kind in {"array", "dict"}:
        # 标准几何和样式数组的空白不携带语义；未展开的引用不能假称一致。
        if re.search(r"\b\d+\s+\d+\s+R\b", value):
            raise FingerprintError("unsupported_annotation_reference")
        tokens = re.findall(r"\([^)]*(?:\)|$)|<[^>]*>|[/A-Za-z_][^\s\[\]<>()]*|[-+]?\d*\.?\d+|\S", value)
        return [float(t) if re.fullmatch(r"[-+]?\d*\.?\d+", t) else t for t in tokens]
    return value


def _annotation(doc, page, xref, kind, warnings):
    annot = page.load_annot(xref)
    info = annot.info
    semantic = {"page": page.number + 1, "type": kind,
                "rect": _simple(annot.rect), "vertices": _simple(annot.vertices),
                "info": {k: info.get(k, "") for k in ("content", "title", "subject", "name")},
                "colors": _simple(annot.colors), "opacity": annot.opacity,
                "border": _simple(annot.border), "flags": annot.flags,
                "line_ends": _simple(annot.line_ends), "rotation": annot.rotation,
                "blendmode": annot.blendmode, "language": annot.language}
    subject = info.get("subject", "")
    if subject.startswith("paper-library:"):
        try:
            payload = json.loads(subject[len("paper-library:"):])
            if isinstance(payload, dict):
                semantic["info"]["subject"] = {k: v for k, v in payload.items() if k not in {
                    "request_id", "request_hash", "parent_id", "geometry_version"}}
        except (ValueError, TypeError):
            pass  # 未知格式保留完整 subject，不能静默丢弃语义。
    for key in RAW_FIELDS:
        try:
            value = _raw_value(doc, xref, key)
            if value is not None:
                semantic[key] = value
        except Exception:
            warnings.add("annotation_field_unreadable")
    if annot.get_oc():
        warnings.add("annotation_optional_content_not_compared")
    if kind == "FileAttachment":
        try:
            details = annot.file_info
            lengths = [details[k] for k in ("length", "size") if isinstance(details.get(k), int)]
            if not lengths or min(lengths) < 0 or max(lengths) > MAX_ATTACHMENT_BYTES:
                raise FingerprintError("attachment_limit")
            payload = annot.get_file()
            if len(payload) > MAX_ATTACHMENT_BYTES:
                raise FingerprintError("attachment_limit")
            semantic["attachment"] = {"sha256": hashlib.sha256(payload).hexdigest(),
                                      "bytes": len(payload),
                                      "name": details.get("filename"),
                                      "description": details.get("description")}
        except Exception:
            warnings.add("attachment_payload_unreadable_or_limited")
    return {"xref": xref, "parent": annot.irt_xref, "semantic": semantic,
            "intrinsic_hash": _digest(semantic)}


def _page_annotations(doc, page, warnings, excluded):
    rows = []
    xrefs = page.annot_xrefs()
    if len(xrefs) > MAX_ANNOTATIONS:
        raise FingerprintError("annotation_limit")
    raw_kind, raw_annots = doc.xref_get_key(page.xref, "Annots")
    if raw_kind == "xref":
        try:
            array_xref = int(raw_annots.split()[0])
            if doc.xref_is_stream(array_xref):
                raise ValueError("annotation array cannot be a stream")
            raw_annots = doc.xref_object(array_xref).strip()
            if not raw_annots.startswith("[") or not raw_annots.endswith("]"):
                raise ValueError("annotation target is not an array")
            raw_kind = "array"
        except Exception:
            warnings.add("indirect_annotation_array_unreadable")
            raw_kind = "unreadable"
    if raw_kind not in {"null", "array", "unreadable"}:
        warnings.add("raw_annotations_unreadable")
    elif raw_kind == "array":
        pure_refs = re.fullmatch(r"\[\s*(?:\d+\s+\d+\s+R\s*)*\]", raw_annots)
        refs = re.findall(r"\b(\d+)\s+\d+\s+R\b", raw_annots) if pure_refs else []
        if not pure_refs or Counter(map(int, refs)) != Counter(row[0] for row in xrefs):
            warnings.add("raw_annotations_not_fully_enumerated")
        known = {row[0] for row in xrefs}
        for xref in dict.fromkeys(map(int, refs)):
            if xref not in known:
                xrefs.append((xref, -1, ""))
    for xref, type_code, _name in xrefs:
        try:
            _raw_type, subtype = doc.xref_get_key(xref, "Subtype")
        except Exception:
            warnings.add("annotation_unreadable")
            continue
        kind = subtype.removeprefix("/")
        if kind in EXCLUDED:
            excluded[kind] += 1
            if kind == "Widget":
                warnings.add("form_widgets_not_compared")
            continue
        if kind not in SUPPORTED:
            warnings.add("unsupported_annotation_type")
        try:
            rows.append(_annotation(doc, page, xref, kind, warnings))
        except Exception:
            warnings.add("annotation_unreadable")
    return rows


def _finish_annotations(rows, warnings):
    by_xref = {row["xref"]: row for row in rows}
    resolved = {}

    def resolve(row, parents=()):
        xref = row["xref"]
        if xref in resolved:
            return resolved[xref]
        if xref in parents or len(parents) >= 64:
            warnings.add("reply_cycle_or_depth")
            return row["intrinsic_hash"]
        parent_hash = None
        if row["parent"]:
            parent = by_xref.get(row["parent"])
            if parent is None:
                warnings.add("reply_parent_unresolved")
                parent_hash = "unresolved"
            else:
                parent_hash = resolve(parent, (*parents, xref))
        row["parent_semantic_hash"] = parent_hash
        resolved[xref] = _digest({"annotation": row["intrinsic_hash"], "parent": parent_hash})
        return resolved[xref]

    result = []
    for row in rows:
        semantic_hash = resolve(row)
        result.append({"page": row["semantic"]["page"], "type": row["semantic"]["type"],
                       "rect": row["semantic"]["rect"], "semantic_hash": semantic_hash,
                       "parent_semantic_hash": row.get("parent_semantic_hash")})
    return sorted(result, key=lambda r: (r["page"], r["type"], r["semantic_hash"]))


def _pixmap_hash(page, dpi, annots, max_page_pixels):
    scale = dpi / 72
    width, height = math.ceil(page.rect.width * scale), math.ceil(page.rect.height * scale)
    if width < 1 or height < 1 or width * height > max_page_pixels:
        raise FingerprintError("page_pixel_limit")
    # 透明组可令 alpha=False 的白底合成出现 1/255 舍入差；比较预乘 RGBA
    # 避免把仅新增高亮造成的舍入误判为正文变化，不引入像素容差。
    pixmap = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=True, annots=annots)
    if pixmap.width * pixmap.height > max_page_pixels:
        raise FingerprintError("page_pixel_limit")
    digest = hashlib.sha256()
    _feed(digest, [pixmap.width, pixmap.height, pixmap.n])
    _feed(digest, pixmap.samples_mv)
    return digest.hexdigest()


def fingerprint(path, mode="inspect", dpi=96, max_pages=2000, max_page_pixels=16000000):
    """检查同一个只读字节快照；返回值没有正文、作者、评论或凭据。"""
    if mode not in {"inspect", "render"} or not 36 <= dpi <= 300:
        raise FingerprintError("invalid_mode_or_dpi")
    if not 1 <= max_pages <= 10000 or not 1 <= max_page_pixels <= 100000000:
        raise FingerprintError("invalid_limit")
    path = Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise FingerprintError("not_regular_file")
    if getattr(before, "st_flags", 0) & 0x40000000:
        raise FingerprintError("dataless_file")
    if before.st_size > MAX_FILE_BYTES:
        raise FingerprintError("file_size_limit")
    identity = _stat(before)
    warnings = set()
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        if _stat(os.fstat(fd)) != identity:
            raise FingerprintError("source_changed")
        with os.fdopen(os.dup(fd), "rb") as source:
            data = source.read(MAX_FILE_BYTES + 1)
        if len(data) != before.st_size:
            raise FingerprintError("source_changed")
        byte_hash = hashlib.sha256(data).hexdigest()
        # MuPDF 诊断可能携带 PDF 内的对象内容；只导出通用 warning code。
        old_errors = pymupdf.TOOLS.mupdf_display_errors(False)
        old_warnings = pymupdf.TOOLS.mupdf_display_warnings(False)
        pymupdf.TOOLS.mupdf_warnings(reset=True)
        try:
            with pymupdf.open(stream=data, filetype="pdf") as doc:
                if doc.needs_pass:
                    raise FingerprintError("password_required")
                if doc.is_repaired:
                    warnings.add("pdf_repaired")
                if doc.is_encrypted or doc.permissions < 0 and doc.metadata.get("encryption"):
                    warnings.add("encrypted_pdf")
                if not 1 <= doc.page_count <= max_pages:
                    raise FingerprintError("page_count_limit")
                raw_text, normal_text = hashlib.sha256(), hashlib.sha256()
                geometry, rows, excluded = [], [], Counter()
                base, visual = hashlib.sha256(), hashlib.sha256()
                for page in doc:
                    page_geometry = {"page": page.number + 1, "rect": _simple(page.rect),
                                     "mediabox": _simple(page.mediabox), "cropbox": _simple(page.cropbox),
                                     "rotation": page.rotation}
                    geometry.append(page_geometry)
                    text = page.get_text("text", sort=False)
                    _feed(raw_text, text.encode("utf-8", errors="replace"))
                    _feed(normal_text, " ".join(text.split()).encode("utf-8", errors="replace"))
                    page_rows = _page_annotations(doc, page, warnings, excluded)
                    rows.extend(page_rows)
                    if len(rows) > MAX_ANNOTATIONS:
                        raise FingerprintError("annotation_limit")
                    if mode == "render":
                        page_base = _pixmap_hash(page, dpi, False, max_page_pixels)
                        page_visual = (_pixmap_hash(page, dpi, True, max_page_pixels)
                                       if page_rows or excluded["Widget"] else page_base)
                        _feed(base, [page_geometry, page_base])
                        _feed(visual, [page_geometry, page_visual])
                annotations = _finish_annotations(rows, warnings)
                annotation_hash = _digest(sorted(row["semantic_hash"] for row in annotations))
                result = {"schema_version": 1, "mode": mode, "sha256": byte_hash,
                          "bytes": len(data), "stat": identity, "page_count": doc.page_count,
                          "text_hash": raw_text.hexdigest(), "text_normalized_hash": normal_text.hexdigest(),
                          "geometry_hash": _digest(geometry), "annotations": annotations,
                          "annotation_count": len(annotations),
                          "annotation_counts": dict(sorted(Counter(r["type"] for r in annotations).items())),
                          "annotation_pages": sorted({r["page"] for r in annotations}),
                          "annotation_semantic_hash": annotation_hash, "annotation_set_hash": annotation_hash,
                          "excluded_annotation_counts": {k: excluded[k] for k in sorted(EXCLUDED)},
                          "base_render_hash": base.hexdigest() if mode == "render" else None,
                          "annotation_visual_hash": visual.hexdigest() if mode == "render" else None,
                          "render_colorspace": "premultiplied-RGBA" if mode == "render" else None,
                          "dpi": dpi if mode == "render" else None}
        finally:
            if pymupdf.TOOLS.mupdf_warnings(reset=True):
                warnings.add("mupdf_diagnostic")
            pymupdf.TOOLS.mupdf_display_errors(old_errors)
            pymupdf.TOOLS.mupdf_display_warnings(old_warnings)
        if _stat(os.fstat(fd)) != identity or _stat(path.lstat()) != identity:
            raise FingerprintError("source_changed")
        result["status"] = "partial" if warnings else "complete"
        result["warnings"] = sorted(warnings)
        result["source_unchanged"] = True
        return result
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", required=True)
    parser.add_argument("--mode", choices=("inspect", "render"), default="inspect")
    parser.add_argument("--dpi", type=int, default=96)
    parser.add_argument("--max-pages", type=int, default=2000)
    parser.add_argument("--max-page-pixels", type=int, default=16000000)
    args = parser.parse_args()
    try:
        result = fingerprint(args.path, args.mode, args.dpi, args.max_pages, args.max_page_pixels)
    except Exception as exc:
        code = exc.code if isinstance(exc, FingerprintError) else type(exc).__name__
        print(json.dumps({"status": "error", "error": code}))
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
