"""One bounded JSON request per process; diagnostics never corrupt stdout protocol."""
import json
import sys
from .core import dispatch


def main():
    try:
        raw = sys.stdin.buffer.read(40 * 1024 * 1024 + 1)
        if len(raw) > 40 * 1024 * 1024:
            raise ValueError("Request exceeds 40 MB")
        result = dispatch(json.loads(raw))
        response = {"ok": True, "result": result}
    except Exception as exc:
        response = {"ok": False, "error": str(exc), "error_type": type(exc).__name__}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
