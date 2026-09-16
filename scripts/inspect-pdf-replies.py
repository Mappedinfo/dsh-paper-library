"""Inspect a private PDF copy and its native annotation threads, never writing the source.

Usage: uv run python scripts/inspect-pdf-replies.py SOURCE PRIVATE_OUTPUT_DIRECTORY
Outputs contain source material; keep the directory outside version control.
"""
import argparse
import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path

import pymupdf


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inspect(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = output / "reading-copy.pdf"
    before = sha256(source)
    if target.exists():
        raise ValueError("Copy already exists; choose a fresh output directory")
    shutil.copy2(source, target)
    target.chmod(0o600)
    rows = []
    with pymupdf.open(target) as doc:
        pages = len(doc)
        for number, page in enumerate(doc, 1):
            for note in page.annots() or []:
                rows.append({"page": number, "xref": note.xref, "type": note.type[1],
                             "reply_xref": note.irt_xref, "info": note.info,
                             "text": page.get_textbox(note.rect)[:1600]})
        by_xref = {r["xref"]: r for r in rows}
        for row in rows:
            parent = by_xref.get(row["reply_xref"])
            row["reply_to"] = parent["info"].get("id") if parent else None
        selected = sorted({rows[0]["page"] if rows else 1,
                           next((r["page"] for r in rows if r["reply_xref"]), 1)})
        for number in selected:
            doc[number - 1].get_pixmap(matrix=pymupdf.Matrix(1.2, 1.2)).save(output / f"page-{number}.png")
    after = sha256(source)
    copied = sha256(target)
    assert before == after == copied, "Source or copy changed during inspection"
    summary = {"pages": pages, "annotations": len(rows), "types": dict(Counter(r["type"] for r in rows)),
               "authors": dict(Counter(r["info"].get("title", "") for r in rows)),
               "native_replies": sum(bool(r["reply_xref"]) for r in rows),
               "unresolved_parents": sum(bool(r["reply_xref"]) and r["reply_xref"] not in by_xref for r in rows),
               "source_unchanged": True, "sha256": before}
    (output / "inspection.json").write_text(json.dumps({"summary": summary, "annotations": rows}, ensure_ascii=False, indent=2))
    (output / "inspection.json").chmod(0o600)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    inspect(args.source, args.output)
