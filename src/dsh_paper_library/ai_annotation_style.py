"""AI 阅读原生样式协议。只读 PDF 几何属性，不以作者、主题或正文推断来源。

写入使用蓝色 #2F80ED、3/2 pt 虚线和 1.1 pt 线宽。读取容许 RGB 每通道
2/255 舍入误差，兼容 /BS（优先）和旧 /Border；同款人工标注也会命中。
任意自定义 /AP、ICC/专色、扁平化绘图不是本协议的可识别原生样式。
"""
from __future__ import annotations
import math
import re

AI_BLUE = "#2F80ED"
AI_RGB = (47 / 255, 128 / 255, 237 / 255)
AI_DASH = (3, 2)
AI_WIDTH = 1.1
COLOR_TOLERANCE = 2 / 255 + 1e-6
# Text/Highlight/Squiggly do not reliably render a dashed stroke.
STROKE_TYPES = {3, 4, 5, 6, 7, 9, 11, 15}
_NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"


def _key(doc, xref, key):
    kind, raw = doc.xref_get_key(xref, key)
    seen = set()
    for _ in range(4):
        if kind != "xref":
            break
        target = int(raw.split()[0])
        if target in seen:
            return "invalid", ""
        seen.add(target)
        raw = doc.xref_object(target, compressed=True).strip()
        kind = ("array" if raw.startswith("[") else "dict" if raw.startswith("<<") else "name" if raw.startswith("/")
                else "int" if re.fullmatch(r"[+-]?\d+", raw) else "float" if re.fullmatch(_NUMBER, raw) else "invalid")
    return kind, raw


def _numbers(raw, limit=16):
    if len(raw) > 512 or not re.fullmatch(r"\[\s*(?:" + _NUMBER + r"\s*)*\]", raw):
        return None
    values = [float(v) for v in re.findall(_NUMBER, raw)]
    return values if len(values) <= limit and all(math.isfinite(v) for v in values) else None


def native_border(annot):
    """标准 /BS 覆盖 /Border；显式实线、非法 dash 不按虚线处理。"""
    doc = annot.parent.parent
    kind, raw = _key(doc, annot.xref, "BS")
    source, dash, width = "default", [], 1.0
    if kind != "null":
        source = "BS"
        if kind != "dict":
            return {"source": source, "dashes": [], "width": 0, "valid": False}
        sk, style = _key(doc, annot.xref, "BS/S")
        wk, wr = _key(doc, annot.xref, "BS/W")
        if wk in {"int", "float"}:
            width = float(wr)
        elif wk != "null":
            return {"source": source, "dashes": [], "width": 0, "valid": False}
        if sk == "name" and style == "/D":
            dk, dr = _key(doc, annot.xref, "BS/D")
            dash = [3.0] if dk == "null" else _numbers(dr) if dk == "array" else None
        elif sk != "null" and (sk != "name" or style not in {"/S", "/B", "/I", "/U"}):
            dash = None
    else:
        bk, br = _key(doc, annot.xref, "Border")
        if bk != "null":
            source = "Border"
            match = re.fullmatch(r"\[\s*(" + _NUMBER + r")\s+(" + _NUMBER + r")\s+(" + _NUMBER + r")\s*(\[[^\]]*\])?\s*\]", br) if bk == "array" and len(br) <= 512 else None
            if not match:
                dash = None
            else:
                width = float(match[3])
                dash = _numbers(match[4]) if match[4] else []
    valid = dash is not None and math.isfinite(width) and width >= 0 and all(v >= 0 for v in dash)
    return {"source": source, "dashes": dash if valid else [], "width": width if math.isfinite(width) else 0, "valid": valid}


def _rgb(annot):
    doc = annot.parent.parent
    kind, raw = _key(doc, annot.xref, "C")
    color = _numbers(raw, 4) if kind == "array" else None
    if color is None or not all(0 <= v <= 1 for v in color):
        return None
    if len(color) == 3:
        return color
    if len(color) == 1:
        return color * 3
    if len(color) == 4:
        # DeviceCMYK's device-independent approximation, not ICC matching.
        return [1 - min(1, channel + color[3]) for channel in color[:3]]
    return None


def native_style(annot):
    border = native_border(annot)
    dash = border["dashes"]
    cycle = dash * 2 if len(dash) % 2 else dash
    interrupted = bool(cycle) and any(v > 0 for v in cycle[::2]) and any(v > 0 for v in cycle[1::2])
    line_style = "dashed" if interrupted and max(cycle[::2]) > 2 else "dotted" if interrupted else "solid"
    rgb = _rgb(annot)
    match = (annot.type[0] in STROKE_TYPES and border["valid"] and border["width"] > 0
             and line_style == "dashed" and rgb is not None
             and all(abs(a - b) <= COLOR_TOLERANCE for a, b in zip(rgb, AI_RGB)))
    return {"ai_reading_style": bool(match), "line_style": line_style,
            "native_style": {"color_rgb": rgb, "dashes": dash, "width": border["width"],
                             "border_source": border["source"], "valid": border["valid"]}}


def sync_dash_appearance(doc, annot, width=None):
    """同步本库新建/编辑的原生 AP，避免只写 /BS 而显示仍为实线。"""
    if annot.type[0] not in STROKE_TYPES:
        return
    kind, raw = doc.xref_get_key(annot.xref, "AP/N")
    if kind != "xref":
        raise ValueError("Dashed annotation requires a direct normal appearance stream")
    xref = int(raw.split()[0])
    if not doc.xref_is_stream(xref):
        raise ValueError("Dashed annotation appearance is not a stream")
    stream = doc.xref_stream(xref)
    if len(stream) > 1024 * 1024:
        raise ValueError("Annotation appearance exceeds the 1 MiB style budget")
    dash = native_border(annot)["dashes"]
    command = ("[" + " ".join(str(float(v)) for v in dash) + "] 0 d\n").encode("ascii")
    stream = re.sub(rb"\[[^\]]*\]\s+[+-]?[\d.]+\s+d\b", command.rstrip(), stream)
    if width is not None:
        stream = re.sub(rb"(?<!\S)[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s+w\b", f"{width} w".encode(), stream)
        command += f"{width} w\n".encode()
    doc.update_stream(xref, command + stream)


def apply_ai_reading_style(doc, annot):
    """只调用于新建的 AI stroke；Highlight 请先选用原生 Underline。"""
    if annot.type[0] not in STROKE_TYPES:
        raise ValueError("AI reading requires native Underline/Square/Line/Ink, not a filled highlight or sticky icon")
    annot.set_colors(stroke=AI_RGB)
    if annot.type[0] in {3, 4, 5, 6, 7, 15}:
        annot.set_border(width=AI_WIDTH, dashes=list(AI_DASH))
    doc.xref_set_key(annot.xref, "BS", "<< /W 1.1 /S /D /D [3 2] >>")
    annot.update()
    sync_dash_appearance(doc, annot, width=AI_WIDTH)
    return annot
