"""Measure one short-lived preview worker with a 1 GiB sparse synthetic CSV.

The first 200 valid rows are followed by an unread sparse region. This tests
bounded reads, not representative dataset content or desktop-wide memory use.
"""
from datetime import datetime, timezone
import json
from pathlib import Path
import resource
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from dsh_paper_library.core import Library
from dsh_paper_library.datasets import dispatch

if len(sys.argv) > 1 and sys.argv[1] == "--worker":
    request = json.loads(sys.stdin.read())
    library = Library(request.pop("library"))
    result = dispatch(library, request)
    library.close()
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    print(json.dumps({"result": result, "peak_rss_bytes": peak}))
else:
    with tempfile.TemporaryDirectory(prefix="dataset-preview-benchmark-") as temp:
        root = Path(temp)
        path = root / "synthetic-large.csv"
        prefix = ("id,value\n" + "synthetic,12\n" * 200).encode()
        with path.open("wb") as handle:
            handle.write(prefix)
            handle.truncate(1024 ** 3)
        before = path.stat()
        library = Library(root / "library")
        dataset = dispatch(library, {"action": "dataset_put", "metadata": {"title": "Synthetic preview benchmark"}, "expected_revision": 0})
        asset = dispatch(library, {"action": "dataset_asset_put", "id": dataset["id"], "path": str(path), "expected_revision": 0})
        library.close()
        output = subprocess.check_output([sys.executable, __file__, "--worker"], input=json.dumps({"library": str(root / "library"), "action": "dataset_asset_preview", "id": dataset["id"], "asset_id": asset["id"]}).encode(), timeout=15)
        measured = json.loads(output)
        result = measured["result"]
        after = path.stat()
        assert result["sample_only"] and len(result["rows"]) == 100 and result["total_rows"] is None
        assert result["bytes_read"] <= 4 * 1024 * 1024
        assert len(json.dumps(result, ensure_ascii=False).encode()) <= 512 * 1024
        assert (before.st_size, before.st_mtime_ns, before.st_ino) == (after.st_size, after.st_mtime_ns, after.st_ino)
        report = {"verified_at": datetime.now(timezone.utc).isoformat(), "ok": True, "source_bytes": before.st_size, "read_bytes": result["bytes_read"], "rows_returned": len(result["rows"]), "worker_peak_rss_bytes": measured["peak_rss_bytes"], "worker_exited": True, "source_stat_unchanged": True, "model_requests": 0, "scope": "One 1 GiB sparse synthetic CSV with a valid first 200 rows; true worker peak RSS only. Excludes browser and host; not a real-library capacity comparison."}
        (ROOT / "docs/validation/dataset-preview-memory.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
