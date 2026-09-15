"""Strictly sampled UTF-8 tabular previews; never deserialize a whole data file."""
import csv
import hashlib
import json
import os
from pathlib import Path
import stat
import time

LIMITS = {"rows": 100, "columns": 50, "input_bytes": 4 * 1024 * 1024,
          "line_bytes": 64 * 1024, "field_characters": 8192,
          "output_bytes": 512 * 1024, "seconds": 2}


class PreviewBudget(ValueError):
    pass


class Lines:
    def __init__(self, handle, deadline):
        self.handle, self.deadline = handle, deadline
        self.bytes_read = 0
        self.digest = hashlib.sha256()
        self.eof = False

    def __iter__(self):
        return self

    def __next__(self):
        if time.monotonic() > self.deadline:
            raise PreviewBudget("Preview time budget reached")
        remaining = LIMITS["input_bytes"] - self.bytes_read
        if remaining <= 0:
            raise PreviewBudget("Preview input byte budget reached")
        value = self.handle.readline(min(remaining, LIMITS["line_bytes"] + 1))
        self.bytes_read += len(value)
        self.digest.update(value)
        if not value:
            self.eof = True
            raise StopIteration
        if len(value) > LIMITS["line_bytes"]:
            raise PreviewBudget("A source line exceeds the 64 KiB preview limit")
        if not value.endswith(b"\n") and self.bytes_read >= LIMITS["input_bytes"]:
            raise PreviewBudget("Preview input byte budget reached inside a row")
        return value.decode("utf-8-sig" if self.bytes_read == len(value) else "utf-8", errors="strict")


def _cell(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        result = value
    else:
        result = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if isinstance(result, str) and len(result) > LIMITS["field_characters"]:
        raise PreviewBudget("A field exceeds the 8192-character preview limit")
    return result


def preview(asset):
    result = {"asset_id": asset["id"], "dataset_id": asset["dataset_id"], "format": asset.get("format", "").lower(),
              "status": "ready", "columns": [], "rows": [], "sample_only": True,
              "total_rows": None, "bytes_read": 0, "truncated": False,
              "warnings": [], "limits": dict(LIMITS), "file_sha256": None}
    if not asset.get("path"):
        return {**result, "status": "unsupported", "warnings": ["External link is registered; preview never downloads data"]}
    path = Path(asset["path"])
    try:
        details = path.lstat()
    except FileNotFoundError:
        return {**result, "status": "missing", "warnings": ["Linked file is missing; explicitly relocate this asset"]}
    if not stat.S_ISREG(details.st_mode):
        raise ValueError("Linked asset is no longer a regular file; explicitly relink it")
    observed = {"size": details.st_size, "mtime_ns": details.st_mtime_ns, "device": details.st_dev, "inode": details.st_ino}
    previous = asset.get("fingerprint") or {}
    if any(previous.get(key) != observed[key] for key in ("device", "inode")):
        raise ValueError("Linked file identity changed; explicitly relink it before previewing")
    result["source"] = {**observed, "file_changed": previous != observed, "asset_revision": asset["revision"]}
    if previous != observed:
        result["warnings"].append("File contents may have changed since registration; this is a fresh sample")
    if result["format"] not in {"csv", "tsv", "jsonl", "ndjson"}:
        return {**result, "status": "unsupported", "warnings": [*result["warnings"], "This format is listed as metadata only; no file contents were read"]}
    # O_NOFOLLOW/O_NONBLOCK plus fstat prevent a swapped symlink/FIFO from
    # turning a bounded local sample into another file read or an indefinite wait.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    started = time.monotonic()
    with os.fdopen(descriptor, "rb", buffering=0) as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino) != (details.st_dev, details.st_ino) or not stat.S_ISREG(opened.st_mode):
            raise ValueError("Linked file changed while opening; retry after explicitly relinking")
        lines = Lines(handle, started + LIMITS["seconds"])
        old_limit = csv.field_size_limit()
        csv.field_size_limit(LIMITS["field_characters"])
        output_bytes = len(json.dumps(result, ensure_ascii=False).encode()) + 4096
        try:
            if result["format"] in {"csv", "tsv"}:
                reader = csv.reader(lines, delimiter="\t" if result["format"] == "tsv" else ",", strict=True)
                header = next(reader, [])
                if len(header) > LIMITS["columns"]:
                    result["truncated"] = True
                    result["warnings"].append("Only the first 50 columns are shown")
                columns = [_cell(value) for value in header[:LIMITS["columns"]]]
                required = len(json.dumps(columns, ensure_ascii=False).encode())
                if output_bytes + required > LIMITS["output_bytes"]:
                    raise PreviewBudget("Column names exceed the preview response byte budget")
                result["columns"] = columns
                output_bytes += required
                for row in reader:
                    if len(row) > LIMITS["columns"]:
                        result["truncated"] = True
                    row = [_cell(value) for value in row[:LIMITS["columns"]]]
                    if len(row) > len(result["columns"]):
                        result["columns"].extend(f"Column {index + 1}" for index in range(len(result["columns"]), len(row)))
                        result["warnings"].append("A sampled row has more fields than the header")
                    required = len(json.dumps(row, ensure_ascii=False).encode()) + 2
                    if output_bytes + required > LIMITS["output_bytes"]:
                        raise PreviewBudget("Preview response byte budget reached")
                    output_bytes += required
                    result["rows"].append(row)
                    if len(result["rows"]) == LIMITS["rows"]:
                        result["truncated"] |= lines.bytes_read < details.st_size
                        break
            else:
                for line in lines:
                    if not line.strip():
                        continue
                    value = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON value")))
                    if not isinstance(value, dict):
                        raise ValueError("JSONL preview requires one object per line")
                    new_columns = [key for key in value if key not in result["columns"]]
                    room = LIMITS["columns"] - len(result["columns"])
                    if len(new_columns) > room:
                        result["truncated"] = True
                    new_columns = [_cell(key) for key in new_columns[:room]]
                    columns = [*result["columns"], *new_columns]
                    row = [_cell(value.get(key)) for key in columns]
                    required = len(json.dumps(row, ensure_ascii=False, allow_nan=False).encode()) + len(json.dumps(new_columns, ensure_ascii=False).encode()) + len(result["rows"]) * 6 * len(new_columns) + 2
                    if output_bytes + required > LIMITS["output_bytes"]:
                        raise PreviewBudget("Preview response byte budget reached")
                    output_bytes += required
                    for previous_row in result["rows"]:
                        previous_row.extend([None] * len(new_columns))
                    result["columns"] = columns
                    result["rows"].append(row)
                    if len(result["rows"]) == LIMITS["rows"]:
                        result["truncated"] |= lines.bytes_read < details.st_size
                        break
        except StopIteration:
            pass
        except (PreviewBudget, csv.Error, UnicodeError, ValueError, RecursionError) as exc:
            result["truncated"] = True
            result["warnings"].append(str(exc)[:500])
            result["status"] = "partial" if result["rows"] else "error"
        finally:
            csv.field_size_limit(old_limit)
        after = os.fstat(handle.fileno())
        if (after.st_size, after.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns):
            result["warnings"].append("File changed during sampling; sample consistency is not guaranteed")
            result["truncated"] = True
        result.update(bytes_read=lines.bytes_read, rows_read=len(result["rows"]), elapsed_seconds=round(time.monotonic() - started, 4))
        result["source"]["sample_sha256"] = lines.digest.hexdigest()
    result["warnings"] = list(dict.fromkeys(result["warnings"]))[:20]
    # Include JSON keys, metadata, warnings and actual Unicode encoding in the
    # response budget, not only table cells. Never truncate cell contents.
    while len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode()) > LIMITS["output_bytes"] and result["rows"]:
        result["rows"].pop()
        result["truncated"] = True
    result["rows_read"] = len(result["rows"])
    return result
