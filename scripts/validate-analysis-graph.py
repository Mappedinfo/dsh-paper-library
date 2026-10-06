#!/usr/bin/env python3
"""诊断用纯校验：复用生产图谱验证器，不打开资料库、不写入草稿。"""
import json
import sys
from dsh_paper_library.library_knowledge import validate_graph


def validate(payload):
    request, sources = payload["request"], payload["sources"]
    normalized = validate_graph(None, request, sources)
    if request.get("mode", "graph") == "graph" and not any(normalized):
        raise ValueError("KNOWLEDGE_INVALID: graph draft contains no records")
    return {"ok": True, "nodes": len(normalized[0]), "edges": len(normalized[1]), "assertions": len(normalized[2])}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Diagnostic input exceeds 1 MiB")
        print(json.dumps(validate(json.loads(raw))))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}))
        sys.exit(1)
