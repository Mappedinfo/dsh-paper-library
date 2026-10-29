"""Build an explicit stat-only rebind from an existing metadata index.

Default: print only a read-only preview summary. Real application requires the
exact revision from that preview. PDF contents are neither opened nor hashed.
Use `uv run python scripts/rebind-external.py --help` for the management flags.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from dsh_paper_library import external_rebind


def build_request(library, index, source, target_id, target_root):
    """Select only unique same-size relative-suffix candidates from an index."""
    library, index, target_root = Path(library).resolve(), Path(index).resolve(), Path(target_root).resolve()
    if index.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Metadata index exceeds 8 MiB")
    document = json.loads(index.read_text(encoding="utf-8"))
    entries = document.get("files") if isinstance(document, dict) else None
    if not isinstance(entries, list) or len(entries) > 20000:
        raise ValueError("Metadata index needs a bounded files array")
    by_name = defaultdict(list)
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        path = Path(entry["path"])
        if path.is_absolute() and path.is_relative_to(target_root):
            by_name[path.name].append(entry)
    database = library / "catalog.sqlite3"
    if Path(str(database) + "-wal").exists():
        raise external_rebind.RebindConflict("A catalog writer is active; retry when it closes")
    connection = sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        rows = connection.execute("SELECT paper_id,relative,size FROM external_files WHERE source=? LIMIT 2001", (source,)).fetchall()
    finally:
        connection.close()
    if len(rows) > 2000:
        raise ValueError("Select a source of at most 2000 indexed rows")
    candidates, ambiguous, unmatched = [], 0, 0
    for paper_id, relative, size in rows:
        matches = [entry for entry in by_name[Path(relative).name]
                   if entry["path"].endswith("/" + relative) and entry.get("size") == size]
        if len(matches) != 1:
            ambiguous += len(matches) > 1; unmatched += len(matches) == 0
            continue
        new_relative = str(Path(matches[0]["path"]).relative_to(target_root))
        candidates.append({"paper_id": paper_id, "old_relative": relative,
                           "new_relative": new_relative, "expected_size": size})
    destinations = Counter(entry["new_relative"].casefold() for entry in candidates)
    unique = [entry for entry in candidates if destinations[entry["new_relative"].casefold()] == 1]
    conflicts = len(candidates) - len(unique)
    mappings, unavailable, changed_size, unsafe = [], 0, 0, 0
    for entry in unique:
        try:
            info = external_rebind._file_stat(target_root / entry["new_relative"], target_root)
        except external_rebind.RebindConflict:
            unavailable += 1; continue
        except ValueError:
            unsafe += 1; continue
        if info.st_size != entry["expected_size"]:
            changed_size += 1; continue
        mappings.append(entry)
    if not mappings:
        raise ValueError("No unique same-size indexed candidates; nothing will be changed")
    return {"action": "external_rebind", "source": source,
            "target_source": {"id": target_id, "root": str(target_root)}, "mappings": mappings}, {
                "old_rows": len(rows), "indexed_candidates": len(candidates), "candidate_mappings": len(mappings), "ambiguous": ambiguous,
                "unmatched": unmatched, "destination_conflicts": conflicts,
                "live_unavailable": unavailable, "live_size_changed": changed_size, "unsafe_paths": unsafe,
                "matching_basis": "unique relative-path suffix and recorded size, then live target stat; no content identity claim"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--target-id", required=True)
    parser.add_argument("--target-root", required=True)
    parser.add_argument("--apply-revision", help="Explicitly apply exactly the revision from the reviewed preview")
    parser.add_argument("--details", action="store_true", help="Print private IDs/paths; keep this output outside public repositories")
    args = parser.parse_args()
    request, selection = build_request(args.library, args.index, args.source, args.target_id, args.target_root)
    if args.apply_revision:
        request.update(apply=True, expected_revision=args.apply_revision)
    result = external_rebind.dispatch(args.library, request)
    if args.details:
        print(json.dumps({"selection": selection, "request": request, "result": result}, ensure_ascii=False, indent=2))
    else:
        summary = {key: value for key, value in result.items() if key != "mappings"}
        print(json.dumps({"selection": selection, **summary}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error) as error:
        print(json.dumps({"ok": False, "category": type(error).__name__, "code": getattr(error, "code", "EXTERNAL_REBIND_UNAVAILABLE")}), file=sys.stderr)
        sys.exit(1)
