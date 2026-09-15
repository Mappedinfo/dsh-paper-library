"""One bounded JSON request per process; diagnostics never corrupt stdout protocol."""
import json
import sys
from pathlib import Path
from .core import dispatch, Library


def dispatch_request(request):
    if not isinstance(request, dict):
        raise ValueError("Request must be a JSON object")
    action = request.get("action", "")
    if isinstance(action, str) and (action.startswith("dataset_") or action in {"resource_list", "resource_export"} or action.startswith("knowledge_")):
        root = request.get("library")
        if not isinstance(root, str) or not Path(root).expanduser().is_absolute():
            raise ValueError("library must be an absolute local directory")
        if len(json.dumps(request, ensure_ascii=False).encode("utf-8")) > 1024 * 1024:
            raise ValueError("Library request exceeds 1 MiB; select fewer sources")
        from . import datasets, library_knowledge
        library = Library(root)
        try:
            return (library_knowledge if action.startswith("knowledge_") else datasets).dispatch(library, request)
        finally:
            library.close()
    return dispatch(request)


def main():
    try:
        raw = sys.stdin.buffer.read(40 * 1024 * 1024 + 1)
        if len(raw) > 40 * 1024 * 1024:
            raise ValueError("Request exceeds 40 MB")
        result = dispatch_request(json.loads(raw))
        response = {"ok": True, "result": result}
    except Exception as exc:
        response = {"ok": False, "error": str(exc), "error_type": type(exc).__name__}
        if getattr(exc, "code", None):
            response["code"] = exc.code
        if getattr(exc, "code", None) == "STATE_CONFLICT":
            response["current"] = getattr(exc, "current", None)
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
