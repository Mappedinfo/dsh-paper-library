#!/usr/bin/env python3
"""Read bounded bibliographic metadata from one PDF without modifying it."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

MAX_BYTES = 512 * 1024 * 1024
MAX_CSL_BYTES = 1024 * 1024
PORTABLE_NAME = "paper-library.csl.json"
DOI_RE = re.compile(r"\b10\.\d{4,9}/[^\s<>\"{}]+", re.I)
SF_DATALESS = getattr(stat, "SF_DATALESS", 0x40000000)


def _safe_stat(value):
    return {"size": value.st_size, "mtime_ns": value.st_mtime_ns, "ctime_ns": value.st_ctime_ns,
            "dev": value.st_dev, "ino": value.st_ino, "mode": stat.S_IMODE(value.st_mode)}


def _base(status="error", warnings=None):
    return {"status": status, "sha256": None, "stat": None,
            "info": {"title": "", "author": "", "subject": "", "keywords": ""},
            "embedded_csl": None, "doi_candidates": [], "page_count": None,
            "warnings": list(warnings or [])}


def probe(path):
    result = _base()
    snapshot_identity = None
    try:
        before = os.lstat(path)
        if not stat.S_ISREG(before.st_mode):
            result["warnings"].append("not_regular_file")
            return result
        if getattr(before, "st_flags", 0) & SF_DATALESS:
            result["warnings"].append("dataless_file")
            return result
        if before.st_size < 0 or before.st_size > MAX_BYTES:
            result["warnings"].append("file_size_limit")
            return result
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                result["warnings"].append("file_changed_before_read")
                return result
            if opened.st_size > MAX_BYTES:
                result["warnings"].append("file_size_limit")
                return result
            chunks, total = [], 0
            while True:
                chunk = os.read(fd, min(1024 * 1024, MAX_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_BYTES:
                    result["warnings"].append("file_size_limit")
                    return result
            data = b"".join(chunks)
            after_fd = os.fstat(fd)
        finally:
            os.close(fd)
        after_path = os.lstat(path)
        identity = lambda st: (st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if identity(before) != identity(after_fd) or identity(before) != identity(after_path):
            result["warnings"].append("file_changed_during_read")
            return result
        snapshot_identity = identity(after_path)
        result["sha256"] = hashlib.sha256(data).hexdigest()
        result["stat"] = _safe_stat(after_path)
        try:
            import pymupdf
            tools = pymupdf.TOOLS
            prior_errors, prior_warnings = tools.mupdf_display_errors(), tools.mupdf_display_warnings()
            tools.mupdf_warnings(reset=True)
            tools.mupdf_display_errors(False)
            tools.mupdf_display_warnings(False)
            try:
                with pymupdf.open(stream=data, filetype="pdf") as doc:
                    if doc.is_repaired:
                        result["warnings"].append("pdf_repaired")
                    raw_info = doc.metadata or {}
                    for key in result["info"]:
                        value = raw_info.get(key)
                        if isinstance(value, str):
                            result["info"][key] = value[:4000]
                    result["page_count"] = int(doc.page_count)
                    if PORTABLE_NAME in doc.embfile_names():
                        try:
                            attachment_info = doc.embfile_info(PORTABLE_NAME)
                            declared_size = attachment_info.get("size", attachment_info.get("length"))
                            if not isinstance(declared_size, int) or declared_size < 0:
                                result["warnings"].append("embedded_csl_size_unknown")
                            elif declared_size > MAX_CSL_BYTES:
                                result["warnings"].append("embedded_csl_size_limit")
                            else:
                                payload = doc.embfile_get(PORTABLE_NAME)
                                if len(payload) > MAX_CSL_BYTES:
                                    result["warnings"].append("embedded_csl_size_limit")
                                else:
                                    candidate = json.loads(payload.decode("utf-8"))
                                    if isinstance(candidate, dict):
                                        result["embedded_csl"] = candidate
                                    else:
                                        result["warnings"].append("embedded_csl_invalid")
                        except Exception:
                            result["warnings"].append("embedded_csl_invalid")
                    if doc.page_count:
                        text = doc.load_page(0).get_text("text")
                        seen = set()
                        for match in DOI_RE.finditer(text):
                            doi = match.group().rstrip(".,;:]}")
                            while doi.endswith(")") and doi.count(")") > doi.count("("):
                                doi = doi[:-1]
                            if doi.lower() not in seen:
                                seen.add(doi.lower())
                                result["doi_candidates"].append(doi[:512])
                                if len(result["doi_candidates"]) == 8:
                                    break
            finally:
                diagnostics = tools.mupdf_warnings(reset=True)
                tools.mupdf_display_errors(prior_errors)
                tools.mupdf_display_warnings(prior_warnings)
                if diagnostics:
                    result["warnings"].append("mupdf_diagnostic")
            result["status"] = "ok"
        except Exception:
            # Parser messages can contain source text or paths. Keep diagnostics generic.
            result["warnings"].append("pdf_parse_failed")
            result["status"] = "unreadable_pdf"
    except FileNotFoundError:
        result["warnings"].append("file_missing")
    except OSError:
        result["warnings"].append("file_access_failed")
    except Exception:
        result["warnings"].append("probe_failed")
    finally:
        if snapshot_identity is not None:
            try:
                final_path = os.lstat(path)
                if identity(final_path) != snapshot_identity and "file_changed_during_read" not in result["warnings"]:
                    result["warnings"].append("file_changed_during_read")
                    result["status"] = "changed"
            except OSError:
                result["warnings"].append("file_changed_during_read")
                result["status"] = "changed"
    return result


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    args = parser.parse_args(argv)
    try:
        value = probe(args.path)
    except Exception:
        value = _base("error", ["probe_failed"])
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
