"""Opt-in read-only placement preflight; never writes or authorizes PDF changes.

CLI: python -m dsh_paper_library.placement_preflight PLAN.json SOURCES.json
SOURCES is an explicit source-ID to local-PDF-path map.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import pymupdf
from .text_anchors import find_unique_anchor


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def preflight(plan, sources):
    errors, coverage, documents = [], {}, {}

    def fail(code, index=None):
        errors.append({"code": code, "entry": index})

    def result():
        return {"ok": not errors, "errors": errors, "coverage": coverage,
                "semantic_validation": "reviewer-attestation-only", "write_authorized": False}

    if not isinstance(plan, dict) or plan.get("schema") != "question-placement-v1":
        fail("unsupported_schema")
        return result()
    questions, entries = plan.get("questions"), plan.get("entries")
    if not isinstance(questions, dict) or not questions or len(questions) > 500 or not all(_text(k) and _text(v) for k, v in questions.items()):
        fail("invalid_question_registry")
        return result()
    coverage = {qid: {"question": text, "evidence": [], "context": [], "unanchored": []} for qid, text in questions.items()}
    if not isinstance(entries, list) or len(entries) > 500 or not isinstance(sources, dict) or len(sources) > 32:
        fail("invalid_or_over_budget_plan")
        return result()
    seen, scopes = set(), set()
    try:
        for index, entry in enumerate(entries):
            before = len(errors)
            if not isinstance(entry, dict):
                fail("invalid_entry", index)
                continue
            eid, qid = entry.get("id"), entry.get("question_id")
            if not _text(eid) or eid in seen:
                fail("duplicate_or_missing_entry_id", index)
            else:
                seen.add(eid)
            if not isinstance(qid, str) or qid not in questions:
                fail("unknown_or_non_atomic_question", index)
                continue
            if entry.get("question") != questions[qid]:
                fail("question_text_mismatch", index)
            if not _text(entry.get("answer")):
                fail("missing_answer", index)
            scope = entry.get("scope")
            if not isinstance(scope, dict) or set(scope) != {"source_id", "version", "entity", "use"} or not all(_text(v) for v in scope.values()):
                fail("missing_atomic_source_version_entity_use", index)
                continue
            key = (qid, *(scope[k] for k in ("source_id", "version", "entity", "use")))
            if key in scopes:
                fail("duplicate_question_scope", index)
            scopes.add(key)
            review = entry.get("review")
            if not isinstance(review, dict) or not _text(review.get("reviewer")) or not _text(review.get("rationale")) or review.get("most_relevant_local_evidence") is not True:
                fail("semantic_review_required", index)
            status = entry.get("status")
            if status not in {"evidence", "context-not-evidence", "unanchored"}:
                fail("invalid_status", index)
                continue
            if status != "evidence" and not _text(entry.get("reason")):
                fail("non_evidence_reason_required", index)
            refs = entry.get("evidence", [])
            if not isinstance(refs, list) or len(refs) > 32:
                fail("invalid_evidence_list", index)
                continue
            anchor = entry.get("anchor")
            if status == "unanchored":
                if anchor is not None:
                    fail("unanchored_must_not_claim_anchor", index)
            elif not isinstance(anchor, dict):
                fail("anchor_required", index)
            if status == "evidence" and (not refs or anchor not in refs):
                fail("anchor_is_not_answer_evidence", index)
            for ref in refs + ([anchor] if isinstance(anchor, dict) and anchor not in refs else []):
                if not isinstance(ref, dict):
                    fail("invalid_reference", index)
                    continue
                sid = ref.get("source_id")
                if sid != scope["source_id"] or ref.get("version") != scope["version"]:
                    fail("cross_source_or_version_split_required", index)
                    continue
                if sid not in sources:
                    fail("missing_explicit_source", index)
                    continue
                if sid not in documents:
                    path = Path(sources[sid])
                    if not path.is_file() or path.stat().st_size > 100_000_000:
                        fail("pdf_size_or_file_type", index)
                        continue
                    data = path.read_bytes()
                    documents[sid] = (hashlib.sha256(data).hexdigest(), pymupdf.open(stream=data, filetype="pdf"))
                digest, doc = documents[sid]
                if ref.get("sha256") != digest:
                    fail("stale_pdf", index)
                    continue
                page_no = ref.get("page")
                if doc.page_count > 500 or type(page_no) is not int or not 1 <= page_no <= doc.page_count:
                    fail("invalid_page_or_page_budget", index)
                    continue
                page = doc[page_no - 1]
                quote = ref.get("quote")
                page_text = page.get_text()
                match = find_unique_anchor(page_text, quote, allow_fuzzy=False)
                if match["status"] != "matched":
                    fail("anchor_" + match["status"], index)
                    continue
                # MuPDF search ignores ASCII case. Refuse extra case variants
                # instead of silently collecting geometry outside the exact quote.
                folded = find_unique_anchor(page_text.casefold(), quote.casefold(), allow_fuzzy=False)
                if folded["status"] != "matched":
                    fail("anchor_search_ambiguous", index)
                    continue
                # Multiple quads may be one wrapped occurrence. Uniqueness is
                # established above, NOT inferred from search_for hit count.
                actual = [[v for point in quad for v in point] for quad in page.search_for(quote, quads=True, flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES)]
                given = ref.get("quads")
                valid = bool(actual) and isinstance(given, list) and len(given) == len(actual)
                if valid:
                    valid = all(isinstance(b, list) and len(b) == 8 and all(type(v) in (int, float) and math.isfinite(v) for v in b) and all(abs(x-y) <= .1 for x,y in zip(a,b)) for a,b in zip(actual,given))
                if not valid:
                    fail("quad_mismatch", index)
            if len(errors) == before:
                bucket = {"evidence": "evidence", "context-not-evidence": "context", "unanchored": "unanchored"}[status]
                coverage[qid][bucket].append({"entry_id": eid, "scope": scope, "references": refs})
        for qid, row in coverage.items():
            if not any(row[k] for k in ("evidence", "context", "unanchored")):
                fail("question_not_accounted_for:" + qid)
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        fail("source_or_schema_error:" + type(exc).__name__)
    finally:
        for _, doc in documents.values():
            doc.close()
    return result()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan")
    parser.add_argument("sources")
    args = parser.parse_args()
    try:
        values = []
        for name in (args.plan, args.sources):
            with Path(name).open("rb") as handle:
                data = handle.read(2_000_001)
            if len(data) > 2_000_000:
                raise ValueError("JSON budget exceeded")
            values.append(json.loads(data))
        report = preflight(*values)
    except (OSError, ValueError) as exc:
        report = {"ok": False, "errors": [{"code": str(exc)}], "write_authorized": False}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
