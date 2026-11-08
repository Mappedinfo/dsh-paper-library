"""有界、确定性的伪代码控制流解析；输出仅含数据，不生成 HTML 或执行代码。"""

from __future__ import annotations

import re
from typing import Any


_NUMBER = re.compile(r"^\s*(\d{1,5})(?:[.:)]\s*|\s+)(\S.*)$")
_HEADER = re.compile(r"^(?:algorithm\b|算法)\s*\d*[.:：]?\s*", re.I)
_CLOSE = re.compile(r"^end\s*(for|while|if)\b\s*[.;:]?$", re.I)
_UNSUPPORTED = re.compile(
    r"^(?:else\s*if|elif|switch|case|default|repeat|until|do\b|try|catch|finally|"
    r"function|procedure|def|goto|jump|parallel|fork|join|yield|await|end\s*\w+)\b", re.I
)


def parse_algorithm(
    text: str,
    *,
    max_nodes: int = 160,
    max_chars: int = 32000,
    max_lines: int = 500,
    max_label_chars: int = 240,
    max_edges: int | None = None,
) -> dict[str, Any]:
    """解析常见 for/while/if 结构，保留输入物理行及可选印刷行号。

    ``complete`` 仅表示本规则解析器识别并闭合了输入中的控制结构，
    不声称 PDF 提取完整或程序语义正确。调用方须另行保留 PDF 提取边界。
    ``source_text`` 为原始行，``label`` 为有界显示文本。渲染器须用 textContent。
    超预算或无法识别的控制结构返回 partial，绝不补造循环结束。
    """
    if not isinstance(text, str):
        raise TypeError("algorithm text must be a string")
    limits = {
        "nodes": min(500, max(2, int(max_nodes))),
        "chars": min(100000, max(1, int(max_chars))),
        "lines": min(2000, max(1, int(max_lines))),
        "label_chars": min(1000, max(1, int(max_label_chars))),
    }
    limits["edges"] = min(2000, max(1, int(max_edges if max_edges is not None else limits["nodes"] * 2 + 8)))
    warnings: list[str] = []
    truncated = False
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    source_lines: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    pending: list[tuple[str, str]] = []
    returns: list[tuple[str, str]] = []
    title = ""
    numbered: list[int] = []
    statements = 0

    def warn(message: str) -> None:
        if message not in warnings:
            warnings.append(message)

    def node(kind: str, label: str, source: dict[str, Any] | None = None) -> str | None:
        nonlocal truncated
        if len(nodes) >= limits["nodes"]:
            truncated = True
            warn("节点数量超过预算；流程图仅显示已解析部分。")
            return None
        source = source or {}
        label_limit = limits["label_chars"]
        identity = f"n{len(nodes)}"
        nodes.append({
            "id": identity, "kind": kind, "label": label[:label_limit],
            "label_truncated": len(label) > label_limit,
            "source_line": source.get("source_line"),
            "line_number": source.get("line_number"),
            "source_text": source.get("text", ""),
        })
        return identity

    def connect(tails: list[tuple[str, str]], target: str, *, back: bool = False) -> None:
        nonlocal truncated
        for origin, branch in tails:
            if len(edges) >= limits["edges"]:
                truncated = True
                warn("连线数量超过预算；流程图仅显示已解析部分。")
                return
            # 分支直接返回循环条件时仍保留 true/false 标签。
            kind = "back" if back else branch
            edge = {"source": origin, "target": target, "kind": kind,
                    "label": {"true": "是", "false": "否", "back": "循环"}.get(branch, "循环" if back else "")}
            if edge not in edges:
                edges.append(edge)

    if len(text) > limits["chars"]:
        truncated = True
        warn("输入字符数超过预算；后续原文未解析。")
    bounded = text[:limits["chars"]]
    raw_lines = bounded.splitlines()
    if len(raw_lines) > limits["lines"]:
        truncated = True
        warn("输入行数超过预算；后续原文未解析。")
    raw_lines = raw_lines[:limits["lines"]]
    start = node("start", "开始")
    pending = [(start, "next")]
    for physical, raw in enumerate(raw_lines, 1):
        stripped = raw.strip()
        numbered_match = _NUMBER.match(stripped)
        printed = int(numbered_match[1]) if numbered_match else None
        content = numbered_match[2].strip() if numbered_match else stripped
        source = {"source_line": physical, "line_number": printed, "text": raw}
        source_lines.append(source)
        if not content:
            source["kind"] = "blank"
            continue
        if _HEADER.match(content):
            title = title or content[:limits["label_chars"]]
            source["kind"] = "title"
            continue
        if content.startswith(("//", "#", "%")):
            source["kind"] = "comment"
            continue
        # 行内注释只影响语法识别，原文始终留在 source_text。
        code = content.split("//", 1)[0].strip()
        if printed is not None:
            if numbered and printed != numbered[-1] + 1:
                warn(f"第 {physical} 行：印刷行号不连续（{numbered[-1]} → {printed}），请核对提取范围。")
            elif not numbered and printed != 1:
                warn(f"第 {physical} 行：印刷行号从 {printed} 开始，可能缺少算法开头。")
            numbered.append(printed)
        close = _CLOSE.fullmatch(code)
        if close:
            source["kind"] = "close"
            block = close[1].lower()
            if not stack or stack[-1]["type"] != block:
                warn(f"第 {physical} 行：{code} 与当前控制结构不匹配。")
                continue
            frame = stack.pop()
            if block == "if":
                pending = frame["then_tails"] + pending if frame["has_else"] else pending + [(frame["node"], "false")]
            else:
                connect(pending, frame["node"], back=True)
                pending = [(frame["node"], "false")] + frame["breaks"]
            continue
        if re.fullmatch(r"else\s*[:;]?", code, re.I):
            source["kind"] = "else"
            if not stack or stack[-1]["type"] != "if" or stack[-1]["has_else"]:
                warn(f"第 {physical} 行：else 没有唯一对应的 if。")
                continue
            frame = stack[-1]
            frame["then_tails"] = pending
            frame["has_else"] = True
            pending = [(frame["node"], "false")]
            continue
        # 预留最终节点，不把超预算的图画成一个完成的算法。
        if len(nodes) >= limits["nodes"] - 1:
            truncated = True
            warn("节点数量超过预算；流程图仅显示已解析部分。")
            break
        lowered = code.lower()
        match = re.match(r"^(for|while|if)\b\s*(.*)$", code, re.I)
        unsupported = bool(_UNSUPPORTED.match(code))
        if unsupported:
            kind = "unknown"
            warn(f"第 {physical} 行：尚不支持该控制语法，保留原文供核对：{code[:80]}")
        elif match:
            kind = "decision" if match[1].lower() == "if" else "loop"
            condition = re.sub(r"\s*\b(?:then|do)\s*[:;]?\s*$", "", match[2], flags=re.I).strip()
            if not condition:
                warn(f"第 {physical} 行：控制条件为空。")
        elif re.match(r"^return\b", code, re.I):
            kind = "return"
        elif re.fullmatch(r"(?:end|stop|exit)\s*[.;]?", code, re.I):
            kind = "terminal"
            if stack:
                warn(f"第 {physical} 行：end 位于未闭合结构中，未猜测其闭合对象。")
        else:
            kind = "step"
        source["kind"] = kind
        identity = node(kind, code, source)
        statements += 1
        if not pending:
            warn(f"第 {physical} 行：没有可达的前置步骤，请核对 return/end 后的结构。")
        connect(pending, identity)
        if match and not unsupported:
            block = match[1].lower()
            stack.append({"type": block, "node": identity, "line": physical,
                          "has_else": False, "then_tails": [], "breaks": []})
            pending = [(identity, "true")]
        elif kind in {"return", "terminal"}:
            returns.append((identity, "next"))
            pending = []
        elif re.fullmatch(r"(?:break|continue)\s*;?", lowered):
            loop = next((frame for frame in reversed(stack) if frame["type"] in {"for", "while"}), None)
            if loop is None:
                warn(f"第 {physical} 行：{code} 不在循环中。")
                pending = [(identity, "next")]
            elif lowered.rstrip(";") == "break":
                loop["breaks"].append((identity, "next"))
                pending = []
            else:
                connect([(identity, "next")], loop["node"], back=True)
                pending = []
        else:
            pending = [(identity, "next")]
    for frame in stack:
        warn(f"第 {frame['line']} 行的 {frame['type']} 未闭合；可能是跨页截断，未补造结束分支。")
    if not statements:
        warn("未找到可解析的算法步骤。")
    # 缺失的结构不能用一个「结束」节点掩盖。
    if not warnings and not truncated:
        finish = node("end", "结束")
        connect(pending + returns, finish)
    complete = not warnings and not truncated
    return {
        "title": title, "nodes": nodes, "edges": edges, "complete": complete,
        "status": "complete" if complete else "partial", "warnings": warnings,
        "source_lines": source_lines, "truncated": truncated, "limits": limits,
        "method": "deterministic-structured-pseudocode-v1",
        "completeness_scope": "control_structure_only",
    }
