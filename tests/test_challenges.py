"""Deterministic challenge-candidate mining: sections, triggers, budgets, skips."""
import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library
from dsh_paper_library.worker import dispatch_request

PAPER_LINES = [
    "Synthetic Challenge Paper",
    "Abstract",
    "We present a synthetic pipeline for urban flow reconstruction.",
    "1 Introduction",
    "Existing synthetic methods perform well on standard synthetic benchmarks.",
    "However, they fail to generalise to noisy synthetic settings.",
    "Prior work lacks a shared evaluation protocol (Smith et al. 2024).",
    "2 Related Work",
    "Synthetic transfer has received little attention.",
    "3 Method",
    "Our pipeline has three stages.",
    "4 Results",
    "The synthetic score improves by 12% over the baseline.",
    "5 Discussion",
    "A key limitation is that our evaluation covers only one synthetic city.",
    "Despite these results, synthetic transfer remains unclear.",
    "6 Future Work",
    "Future work should test the pipeline on other synthetic regions.",
    "7 Conclusion",
    "Synthetic transfer is the main open challenge.",
    "References",
    "Synthetic reference list with a limitation keyword inside a cited title.",
]


def write_pdf(path, lines=PAPER_LINES, per_page=10):
    with fitz.open() as doc:
        page = None
        for index, line in enumerate(lines):
            if index % per_page == 0:
                page = doc.new_page(width=595, height=842)
            page.insert_text((50, 60 + (index % per_page) * 22), line, fontsize=11)
        doc.save(path)
    return path


@pytest.fixture
def library(tmp_path):
    instance = Library(tmp_path / "library")
    yield instance
    instance.close()


def call(library, action, **values):
    return dispatch_request({"library": str(library.root), "action": action, **values})


def make_paper(library, tmp_path, name="paper-1", citekey="synthetic2026", lines=PAPER_LINES, with_pdf=True, archived=False):
    item = library.create({"title": f"Synthetic challenge paper {name}", "citekey": citekey,
                           "issued": {"date-parts": [[2026]]}})
    if with_pdf:
        library.attach(item["id"], str(write_pdf(tmp_path / f"{name}.pdf", lines)))
    if archived:
        library.archive(item["id"])
        return item
    return library.get(item["id"])


def test_scan_finds_sections_and_page_anchored_candidates(library, tmp_path):
    paper = make_paper(library, tmp_path)
    result = call(library, "challenge_scan", ids=[paper["id"]])
    assert result["schema"] == "paper-library-challenge-candidates.v1"
    assert result["model_calls"] == 0
    assert result["scope"] == {"requested": 1, "scanned": 1, "skipped": []}
    entry = result["papers"][0]
    assert {"abstract", "introduction", "related-work", "method", "results", "discussion", "future-work", "conclusion"} <= set(entry["sections_found"])
    assert "references" not in entry["sections_found"]
    assert entry["sections_used"][0] == "limitations" or "discussion" in entry["sections_used"]
    assert len(entry["sections_used"]) <= result["budgets"]["sections_per_paper"]
    candidates = entry["candidates"]
    assert candidates, "Synthetic paper must yield trigger candidates"
    for candidate in candidates:
        assert candidate["section"] in entry["sections_used"]
        assert 1 <= candidate["page"] <= 2
        assert candidate["rules"], "Every candidate keeps its matched rule ids"
        assert 20 <= len(candidate["text"]) <= result["budgets"]["candidate_characters"]
    joined = " ".join(candidate["text"] for candidate in candidates)
    assert "key limitation" in joined.lower()
    assert "Synthetic reference list" not in joined, "Back matter is excluded"
    limitation = next(candidate for candidate in candidates if "key limitation" in candidate["text"].lower())
    assert limitation["section"] == "discussion" and limitation["page"] == 2
    assert "en-limitation" in limitation["rules"]
    assert result["rules"]["en-contrast"] >= 1 and result["rules"]["en-open"] >= 1


def test_abbreviations_and_subsection_headings_do_not_split_evidence(library, tmp_path):
    lines = [
        "1 Introduction", "Prior work by Smith et al. 2024 assumed a fixed grid; however, that assumption fails to hold for sparse data.",
        "3.1 Synthetic Protocol", "The protocol cannot represent irregular sampling.",
        "4 Conclusion", "The grid assumption remains unclear for sparse data.",
    ]
    paper = make_paper(library, tmp_path, name="abbrev", citekey="abbrev2026", lines=lines)
    entry = call(library, "challenge_scan", ids=[paper["id"]])["papers"][0]
    texts = [candidate["text"] for candidate in entry["candidates"]]
    assert any(text.startswith("Prior work by Smith et al. 2024") for text in texts), texts
    assert not any(text.startswith("al. 2024") for text in texts), "The abbreviation must not split a sentence"
    assert all(not text.startswith("3.1 Synthetic Protocol") for text in texts), "Subsection headings are structure"


def test_per_paper_and_aggregate_budgets_are_enforced(library, tmp_path):
    lines = ["1 Discussion"]
    for index in range(120):
        lines.append(f"However, synthetic limitation number {index} remains unclear in setting {index}.")
    paper = make_paper(library, tmp_path, name="many", citekey="many2026", lines=lines)
    entry = call(library, "challenge_scan", ids=[paper["id"]])["papers"][0]
    assert len(entry["candidates"]) <= 40
    assert entry["characters"] <= 24000
    assert entry["truncated"] is True

    ids = []
    for index in range(2):
        ids.append(make_paper(library, tmp_path, name=f"agg-{index}", citekey=f"agg{index}2026", lines=lines)["id"])
    aggregate = call(library, "challenge_scan", ids=ids)
    assert aggregate["totals"]["candidates"] <= 400
    assert aggregate["totals"]["characters"] <= 200000


def test_scope_validation_and_skips_stay_explicit(library, tmp_path):
    paper = make_paper(library, tmp_path, name="ok", citekey="ok2026")
    metadata_only = make_paper(library, tmp_path, name="meta", citekey="meta2026", with_pdf=False)
    archived = make_paper(library, tmp_path, name="arch", citekey="arch2026", archived=True)
    result = call(library, "challenge_scan", ids=[paper["id"], metadata_only["id"], archived["id"], "missing-id"])
    assert result["scope"]["scanned"] == 1
    reasons = {entry["id"]: entry["reason"] for entry in result["scope"]["skipped"]}
    assert "PDF" in reasons[metadata_only["id"]]
    assert "回收站" in reasons[archived["id"]]
    assert "missing-id" in reasons

    with pytest.raises(ValueError, match="CHALLENGE_SCOPE"):
        call(library, "challenge_scan", ids=[])
    with pytest.raises(ValueError, match="CHALLENGE_SCOPE"):
        call(library, "challenge_scan", ids=["a", "a"])
    with pytest.raises(ValueError, match="CHALLENGE_SCOPE"):
        call(library, "challenge_scan", ids=[f"p{index}" for index in range(51)])
    with pytest.raises(ValueError, match="CHALLENGE_SCOPE"):
        call(library, "challenge_scan", ids=[paper["id"]], sections=["not-a-section"])


def test_explicit_section_subset_limits_scanning(library, tmp_path):
    paper = make_paper(library, tmp_path, name="subset", citekey="subset2026")
    entry = call(library, "challenge_scan", ids=[paper["id"]], sections=["conclusion"])["papers"][0]
    assert entry["sections_used"] == ["conclusion"]
    assert {candidate["section"] for candidate in entry["candidates"]} <= {"conclusion"}
    assert call(library, "challenge_scan", ids=[paper["id"]], sections=["method"])["papers"][0]["candidates"] == []


def test_sources_freeze_candidates_with_trusted_provenance(library, tmp_path):
    paper = make_paper(library, tmp_path, name="freeze", citekey="freeze2026")
    result = call(library, "challenge_sources", id=paper["id"])
    assert result["schema"] == "paper-library-challenge-sources.v1"
    assert result["model_calls"] == 0
    assert result["source_ids"] and len(result["source_ids"]) == len(result["sources"]) == result["candidates"]
    assert len(result["source_ids"]) <= 40
    for source in result["sources"]:
        assert source["entity"] == {"kind": "paper", "id": paper["id"]}
        assert source["kind"] == "source-note"
        assert source["content_hash"]
        assert source["locator"]["page"] >= 1
        assert source["pdf_snapshot"]["kind"] == "challenge-candidate"
        assert source["pdf_snapshot"]["sections"] == result["sections_used"]
    # Re-running is idempotent: the same candidate text resolves to the same source id.
    again = call(library, "challenge_sources", id=paper["id"])
    assert again["source_ids"] == result["source_ids"]
    with pytest.raises(ValueError, match="CHALLENGE_SCOPE"):
        call(library, "challenge_sources", id="dataset_x")


def test_source_status_is_validated_and_linted(library, tmp_path):
    from dsh_paper_library import library_knowledge as knowledge
    paper = make_paper(library, tmp_path, name="status", citekey="status2026")
    sources = call(library, "challenge_sources", id=paper["id"])
    entity = {"kind": "paper", "id": paper["id"]}
    source_id = sources["source_ids"][0]
    text = sources["sources"][0]["text"]
    quote = text[:40]

    def draft(nodes, assertions, request_id):
        return knowledge.draft_put(library, {"entity": entity, "source_ids": [source_id], "request_id": request_id,
                                             "mode": "graph", "nodes": nodes, "edges": [], "assertions": assertions})

    valid = draft([
        {"id": "difficulty", "type": "gap", "label": "Synthetic evaluation covers one city", "source_status": "author-stated"},
        {"id": "proof", "type": "evidence", "label": "Stated limitation", "source_id": source_id, "quote": quote},
    ], [{"subject": "evidence:proof", "object": "gap:difficulty", "relation": "identifies", "surface": "Explicit limitation sentence"}], "challenge-1")
    assert valid["nodes"][0]["source_status"] == "author-stated"

    with pytest.raises(ValueError, match="source_status"):
        draft([{"id": "x", "type": "gap", "label": "Bad status", "source_status": "author-said"}], [], "challenge-2")
    with pytest.raises(ValueError, match="source_status belongs"):
        draft([{"id": "x", "type": "claim", "label": "Wrong type", "source_status": "inferred"}], [], "challenge-3")

    unbacked = draft([{"id": "lonely", "type": "gap", "label": "No evidence at all", "source_status": "inferred"}], [], "challenge-4")
    linted = knowledge.draft_lint(library, {"id": unbacked["id"]})
    assert any(finding["rule"] == "challenge-without-evidence" for finding in linted["findings"])
    backed = knowledge.draft_lint(library, {"id": valid["id"]})
    assert not any(finding["rule"] == "challenge-without-evidence" for finding in backed["findings"])
