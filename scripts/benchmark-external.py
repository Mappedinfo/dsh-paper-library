"""Reproducible check for indexing a synced corpus by symlink.

Builds a synthetic directory tree, indexes it, and records what a second scan,
a bounded scan, a rename, a disappearing file and a first write actually cost.
Nothing here reads a real corpus and nothing is copied until the last step.

Run: uv run --offline python scripts/benchmark-external.py [--files 2000]
Writes docs/validation/external-scan.json.
"""
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dsh_paper_library.core import dispatch  # noqa: E402

MINIMAL = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n"


def build(root, files):
    """One Zotero-shaped name per file plus an unrelated extension to skip."""
    for index in range(files):
        folder = root / f"Collection {index % 17:02d}"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"Author{index % 300:03d} 等 - {2000 + index % 25} - Synthetic study {index:05d}.pdf").write_bytes(MINIMAL)
        (folder / f"notes-{index}.md").write_text("not a pdf", encoding="utf-8")


def call(library, action, **kw):
    return dispatch({"library": str(library), "action": action, **kw})


def timed(library, action, sources, **kw):
    started = time.perf_counter()
    result = call(library, action, sources=sources, **kw)
    return result, round((time.perf_counter() - started) * 1000, 2)


def main():
    files = 2000
    if "--files" in sys.argv:
        files = int(sys.argv[sys.argv.index("--files") + 1])
    base = Path(tempfile.mkdtemp(prefix="external-benchmark-"))
    corpus = base / "synced"
    library = base / "library"
    build(corpus, files)
    sources = [{"id": "synced-academic", "root": str(corpus), "label": "synthetic"}]

    first, first_ms = timed(library, "external_scan", sources, limit=5000)
    second, second_ms = timed(library, "external_scan", sources, limit=5000)
    bounded, bounded_ms = timed(library, "external_scan", sources, limit=200)

    renamed = next(corpus.rglob("*.pdf"))
    renamed.rename(renamed.with_name(renamed.name.replace("Synthetic study", "Renamed study")))
    after_rename, rename_ms = timed(library, "external_scan", sources, limit=5000)

    removed = next(path for path in corpus.rglob("*.pdf") if path.name.startswith("Renamed") is False)
    body = removed.read_bytes()
    removed.unlink()
    after_missing, missing_ms = timed(library, "external_scan", sources, limit=5000)
    removed.write_bytes(body)
    after_restore, restore_ms = timed(library, "external_scan", sources, limit=5000)

    status = call(library, "status")
    catalog_bytes = (library / "catalog.sqlite3").stat().st_size
    staged_links = sum(1 for path in (library / "external").rglob("*") if path.is_symlink())
    report = {
        "verified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fixture": {"pdfs": files, "pdf_bytes": len(MINIMAL), "note_files": files, "folders": 17},
        "first_scan": {"indexed": first["sources"][0]["indexed"], "failures": first["sources"][0]["failures"], "elapsed_ms": first_ms},
        "second_scan": {"indexed": second["sources"][0]["indexed"], "skipped": second["sources"][0]["skipped"], "elapsed_ms": second_ms},
        "bounded_scan": {"limit": 200, "indexed": bounded["sources"][0]["indexed"], "pending": bounded["sources"][0]["pending"], "truncated": bounded["sources"][0]["truncated"], "elapsed_ms": bounded_ms},
        "rename": {"renamed": after_rename["sources"][0]["renamed"], "indexed": after_rename["sources"][0]["indexed"], "elapsed_ms": rename_ms},
        "missing": {"missing": after_missing["sources"][0]["missing"], "papers_kept": call(library, "status")["count"], "elapsed_ms": missing_ms},
        "restore": {"refreshed": after_restore["sources"][0]["refreshed"], "missing": call(library, "status")["external_missing"], "elapsed_ms": restore_ms},
        "totals": {"papers": status["count"], "external_indexed": status["external_indexed"], "staged_links": staged_links, "catalog_bytes": catalog_bytes, "catalog_bytes_per_record": round(catalog_bytes / max(1, status["count"]), 1)},
        "limits": [
            "Synthetic 200-byte PDFs; the scan never opens a PDF, so contents do not affect these timings",
            "Timings are one short-lived Python worker per call on this machine, not a large real corpus",
            "No hash of file contents is computed; a same-size, same-mtime rewrite is not detected",
        ],
    }
    out = ROOT / "docs" / "validation" / "external-scan.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
