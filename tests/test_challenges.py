"""Deterministic challenge-candidate mining: sections, triggers, budgets, skips."""
import json

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


def make_paper(library, tmp_path, name="paper-1", citekey="synthetic2026", lines=PAPER_LINES, with_pdf=True, archived=False, year=2026):
    item = library.create({"title": f"Synthetic challenge paper {name}", "citekey": citekey,
                           "issued": {"date-parts": [[year]]}})
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


# --- P3: cross-paper themes -------------------------------------------------

def make_difficulty_draft(library, paper, label, quote, page, node_type="gap", source_status="author-stated",
                          draft_id=None, accept=True):
    source = call(library, "knowledge_source_put", entity={"kind": "paper", "id": paper["id"]}, kind="user-text",
                  text=f"{quote} Synthetic context sentence.", locator={"page": page})
    draft = call(library, "knowledge_draft_put", entity={"kind": "paper", "id": paper["id"]},
                 source_ids=[source["id"]], request_id=draft_id or f"draft-{paper['id']}-{page}",
                 nodes=[{"id": "difficulty-1", "type": node_type, "label": label, "source_status": source_status},
                        {"id": "evidence-1", "type": "evidence", "label": "Synthetic excerpt", "source_id": source["id"], "quote": quote}],
                 assertions=[{"subject": "evidence:evidence-1", "object": f"{node_type}:difficulty-1", "relation": "identifies"}])
    if accept:
        draft = call(library, "knowledge_draft_review", id=draft["id"], reviewed_by="user", decision="accepted",
                     expected_revision=draft["revision"])
    return draft


def test_themes_aggregate_reviewed_difficulty_records(library, tmp_path):
    first = make_paper(library, tmp_path, name="a", citekey="alpha2024", year=2024)
    second = make_paper(library, tmp_path, name="b", citekey="beta2026", year=2026)
    make_difficulty_draft(library, first, "Cross-city generalization is unclear", "Cross-city generalization remains unclear.", 4)
    make_difficulty_draft(library, second, "cross city generalization is unclear!", "Generalization across cities is unclear.", 2)
    result = call(library, "challenge_themes", ids=[first["id"], second["id"]])
    assert result["schema"] == "paper-library-challenge-themes.v1"
    assert result["model_calls"] == 0
    assert result["totals"] == {"records": 2, "themes": 1, "persisted": 1}
    theme = result["themes"][0]
    assert theme["paper_count"] == 2 and theme["record_count"] == 2
    assert theme["status"] == "needs-review" and theme["revision"] == 1
    assert theme["years"] == {"min": 2024, "max": 2026, "histogram": {"2024": 1, "2026": 1}}
    assert theme["source_status"]["author-stated"] == 2
    assert {item["citekey"] for item in theme["papers"]} == {"alpha2024", "beta2026"}
    assert sorted(quote["page"] for quote in theme["quotes"]) == [2, 4]
    assert all(quote["quote"] in ("Cross-city generalization remains unclear.", "Generalization across cities is unclear.") for quote in theme["quotes"])
    assert theme["variants"] == ["cross city generalization is unclear!"]
    assert result["scope"]["scanned"] == 2 and result["scope"]["skipped"] == []


def test_themes_respect_draft_review_status(library, tmp_path):
    paper = make_paper(library, tmp_path)
    make_difficulty_draft(library, paper, "Sparse synthetic supervision is unsolved", "Supervision is sparse.", 3, accept=False)
    assert call(library, "challenge_themes", ids=[paper["id"]])["totals"]["records"] == 0
    included = call(library, "challenge_themes", ids=[paper["id"]], include="all")
    assert included["totals"]["records"] == 1
    assert included["themes"][0]["papers"][0]["draft_status"] == "needs-review"


def test_themes_scope_and_option_validation(library, tmp_path):
    paper = make_paper(library, tmp_path)
    for ids in ([], [paper["id"], paper["id"]], ["bad id!"], [f"p{index}" for index in range(201)]):
        with pytest.raises(ValueError):
            call(library, "challenge_themes", ids=ids)
    with pytest.raises(ValueError):
        call(library, "challenge_themes", ids=[paper["id"]], include="everything")
    with pytest.raises(ValueError):
        call(library, "challenge_themes", ids=[paper["id"]], persist="yes")


def test_themes_propose_pending_merges_without_applying(library, tmp_path):
    paper = make_paper(library, tmp_path)
    make_difficulty_draft(library, paper, "Limited synthetic evaluation protocol coverage", "Protocol coverage is limited.", 2, draft_id="one")
    make_difficulty_draft(library, paper, "Limited synthetic evaluation protocol breadth", "Protocol breadth is limited.", 3, draft_id="two")
    result = call(library, "challenge_themes", ids=[paper["id"]])
    assert len(result["themes"]) == 2, "Overlapping labels must stay separate until a reviewer merges them"
    assert result["merge_suggestions"] and result["merge_suggestions"][0]["jaccard"] >= 0.6
    suggestion = result["merge_suggestions"][0]
    assert {suggestion["left"], suggestion["right"]} == {theme["id"] for theme in result["themes"]}


def test_theme_persistence_revision_review_and_listing(library, tmp_path):
    paper = make_paper(library, tmp_path)
    make_difficulty_draft(library, paper, "No shared synthetic benchmark exists", "No shared benchmark exists.", 2)
    first = call(library, "challenge_themes", ids=[paper["id"]])
    theme = first["themes"][0]
    second = call(library, "challenge_themes", ids=[paper["id"]])
    assert second["themes"][0]["revision"] == 2
    assert second["themes"][0]["previous"] == {"revision": 1, "paper_count": 1}
    assert second["totals"]["persisted"] == 1
    with pytest.raises(ValueError):
        call(library, "challenge_theme_review", id=theme["id"], reviewed_by="llm", decision="accepted", expected_revision=2)
    with pytest.raises(ValueError):
        call(library, "challenge_theme_review", id=theme["id"], reviewed_by="user", decision="accepted", expected_revision=1)
    reviewed = call(library, "challenge_theme_review", id=theme["id"], reviewed_by="user", decision="accepted", expected_revision=2)
    assert reviewed["status"] == "accepted" and reviewed["revision"] == 3
    listed = call(library, "challenge_theme_list", scope=second["scope"]["hash"])
    assert listed["total"] == 1 and listed["items"][0]["status"] == "accepted"
    assert len(listed["items"][0]["papers"]) <= 10 and len(listed["items"][0]["quotes"]) <= 5
    with pytest.raises(ValueError):
        call(library, "challenge_theme_list", scope="nope")
    with pytest.raises(ValueError):
        call(library, "challenge_theme_list", limit=0)


def test_themes_skip_archived_and_missing_papers(library, tmp_path):
    archived = make_paper(library, tmp_path, name="gone", citekey="gone2026", archived=True)
    result = call(library, "challenge_themes", ids=[archived["id"], "missing-paper"])
    assert result["totals"]["records"] == 0
    assert [item["reason"] for item in result["scope"]["skipped"]] == ["论文在回收站中", "论文不存在或不可读取"]
    assert result["scope"]["scanned"] == 0


def test_theme_merge_requires_review_and_supersedes_members(library, tmp_path):
    first = make_paper(library, tmp_path, name="a", citekey="alpha2024", year=2024)
    second = make_paper(library, tmp_path, name="b", citekey="beta2026", year=2026)
    make_difficulty_draft(library, first, "Limited synthetic evaluation protocol coverage", "Protocol coverage is limited.", 2)
    make_difficulty_draft(library, second, "Limited synthetic evaluation protocol breadth", "Protocol breadth is limited.", 3)
    result = call(library, "challenge_themes", ids=[first["id"], second["id"]])
    themes = {theme["id"]: theme for theme in result["themes"]}
    ids = sorted(themes)
    revisions = {theme_id: themes[theme_id]["revision"] for theme_id in ids}
    with pytest.raises(ValueError):
        call(library, "challenge_theme_merge", theme_ids=ids, expected_revisions=revisions, reviewed_by="llm")
    with pytest.raises(ValueError):
        call(library, "challenge_theme_merge", theme_ids=[ids[0]], expected_revisions={ids[0]: 1}, reviewed_by="user")
    with pytest.raises(ValueError):
        call(library, "challenge_theme_merge", theme_ids=ids, expected_revisions={ids[0]: 999, ids[1]: revisions[ids[1]]}, reviewed_by="user")
    merged = call(library, "challenge_theme_merge", theme_ids=ids, expected_revisions=revisions, reviewed_by="user",
                  label="Synthetic evaluation protocol coverage and breadth")
    assert merged["status"] == "needs-review" and merged["origin"] == "user-merge" and merged["revision"] == 1
    assert merged["merged_from"] == ids
    assert merged["paper_count"] == 2 and merged["record_count"] == 2
    assert merged["years"] == {"min": 2024, "max": 2026, "histogram": {"2024": 1, "2026": 1}}
    assert sorted(quote["page"] for quote in merged["quotes"]) == [2, 3]
    for theme_id in ids:
        superseded = call(library, "challenge_theme_get", id=theme_id)["theme"]
        assert superseded["status"] == "merged" and superseded["superseded_by"] == merged["id"]
    with pytest.raises(ValueError):
        call(library, "challenge_theme_merge", theme_ids=ids, expected_revisions=revisions, reviewed_by="user")
    listed = call(library, "challenge_theme_list", scope=merged["scope"], status="merged")
    assert listed["total"] == 2
    assert call(library, "challenge_theme_get", id=merged["id"])["theme"]["paper_count"] == 2
    with pytest.raises(ValueError):
        call(library, "challenge_theme_get", id="ct-" + "0" * 24)


def test_challenge_export_writes_bounded_reviewed_files(library, tmp_path):
    first = make_paper(library, tmp_path, name="a", citekey="alpha2024", year=2024)
    second = make_paper(library, tmp_path, name="b", citekey="beta2026", year=2026)
    make_difficulty_draft(library, first, "No shared synthetic benchmark exists", "No shared benchmark exists.", 2)
    make_difficulty_draft(library, second, "No shared synthetic benchmark exists", "A shared benchmark is missing.", 5)
    result = call(library, "challenge_themes", ids=[first["id"], second["id"]])
    theme = result["themes"][0]
    with pytest.raises(ValueError):
        call(library, "challenge_export", ids=[first["id"], second["id"]], scope=result["scope"]["hash"])
    call(library, "challenge_theme_review", id=theme["id"], reviewed_by="user", decision="accepted", expected_revision=1)
    exported = call(library, "challenge_export", ids=[first["id"], second["id"]], scope=result["scope"]["hash"])
    assert exported["schema"] == "paper-library-challenge-export.v1" and exported["model_calls"] == 0
    assert exported["themes"] == 1 and exported["citekeys"] == ["alpha2024", "beta2026"]
    assert set(exported["files"]) == {"challenges.csv", "challenges.md", "challenges.bib"}
    csv_text = (library.root / "exports/challenges.csv").read_text()
    assert csv_text.splitlines()[0].startswith("theme_id,theme_label")
    assert '"accepted"' in csv_text and "alpha2024" in csv_text and "beta2026" in csv_text
    assert '"Synthetic excerpt"' not in csv_text.splitlines()[0]
    markdown = (library.root / "exports/challenges.md").read_text()
    assert "覆盖：2 篇 / 2 条难点记录" in markdown and "2024–2026" in markdown
    assert "[@alpha2024 p.2]" in markdown and "[@beta2026 p.5]" in markdown
    assert "`needs-review` 起步" in markdown and "没有携带合并建议" in markdown
    bib = (library.root / "exports/challenges.bib").read_text()
    assert "@misc{alpha2024" in bib and "@misc{beta2026" in bib
    assert "author" not in bib, "Missing metadata fields must stay absent"
    assert exported["rows"] == 2 and exported["files"]["challenges.csv"]["bytes"] == len(csv_text.encode())
    assert call(library, "challenge_export", ids=[second["id"]], include="all", include_unreviewed=True,
                scope=result["scope"]["hash"])["themes"] == 1, "Unreviewed themes are exportable only on request"
    carried = call(library, "challenge_export", ids=[first["id"], second["id"]], scope=result["scope"]["hash"],
                   merge_suggestions=[{"left": theme["id"], "right": theme["id"], "jaccard": 0.75}])
    assert carried["themes"] == 1
    assert "（相似度 0.75）——待人工确认" in (library.root / "exports/challenges.md").read_text()
    with pytest.raises(ValueError):
        call(library, "challenge_export", ids=[second["id"]], scope="0" * 64)


# --- P4: structural check, comparison and review packet ---------------------

def make_gap_only_draft(library, paper, label, draft_id=None):
    """A gap without an evidence assertion: structurally invalid, still storable."""
    source = call(library, "knowledge_source_put", entity={"kind": "paper", "id": paper["id"]}, kind="user-text",
                  text="Synthetic context sentence for an unbacked gap.", locator={"page": 6})
    draft = call(library, "knowledge_draft_put", entity={"kind": "paper", "id": paper["id"]}, source_ids=[source["id"]],
                 request_id=draft_id or f"gap-{paper['id']}",
                 nodes=[{"id": "unsupported-1", "type": "gap", "label": label, "source_status": "inferred"}])
    return call(library, "knowledge_draft_review", id=draft["id"], reviewed_by="user", decision="accepted", expected_revision=draft["revision"])


def test_theme_check_reports_only_structural_findings(library, tmp_path):
    paper = make_paper(library, tmp_path)
    make_difficulty_draft(library, paper, "No shared synthetic benchmark exists", "No shared benchmark exists.", 2)
    themes = call(library, "challenge_themes", ids=[paper["id"]])
    checked = call(library, "challenge_theme_check", scope=themes["scope"]["hash"])
    assert checked["schema"] == "paper-library-challenge-theme-check.v1" and checked["model_calls"] == 0
    assert checked["themes"] == 1 and checked["counts"]["error"] == 0
    codes = {finding["code"] for finding in checked["findings"]}
    assert "theme-single-paper" in codes and "theme-unreviewed" in codes and "theme-revised" not in codes
    assert checked["by_status"]["needs-review"] == 1
    with pytest.raises(ValueError):
        call(library, "challenge_theme_check", scope="nope")
    with pytest.raises(ValueError):
        call(library, "challenge_theme_check", scope=themes["scope"]["hash"], statuses=["bogus"])
    assert call(library, "challenge_theme_check", scope="a" * 64)["themes"] == 0


def test_theme_check_flags_missing_evidence(library, tmp_path):
    paper = make_paper(library, tmp_path)
    make_gap_only_draft(library, paper, "Synthetic gaps may lack evidence")
    themes = call(library, "challenge_themes", ids=[paper["id"]])
    checked = call(library, "challenge_theme_check", scope=themes["scope"]["hash"])
    assert checked["counts"]["error"] == 1
    error = next(finding for finding in checked["findings"] if finding["severity"] == "error")
    assert error["code"] == "theme-without-evidence" and error["theme_id"] == themes["themes"][0]["id"]
    assert "theme-inferred-only" in {finding["code"] for finding in checked["findings"]}


def test_comparison_matches_checklist_entries_and_reports_gaps(library, tmp_path):
    first = make_paper(library, tmp_path, name="a", citekey="alpha2026")
    second = make_paper(library, tmp_path, name="b", citekey="beta2026")
    make_difficulty_draft(library, first, "No shared synthetic benchmark exists", "No shared benchmark exists.", 2)
    make_difficulty_draft(library, second, "Human evaluation of synthetic transfer is missing", "Human evaluation is missing.", 3)
    themes = call(library, "challenge_themes", ids=[first["id"], second["id"]])
    checked = call(library, "challenge_comparison", ids=[first["id"], second["id"]], scope=themes["scope"]["hash"],
                   checklist_text="# 我的清单\n- no shared synthetic benchmark\n- 城市洪涝的实时预报\n", checklist_date="2026-09-17")
    assert checked["schema"] == "paper-library-challenge-comparison.v1" and checked["model_calls"] == 0
    assert checked["checklist"]["date"] == "2026-09-17" and checked["checklist"]["origin"] == "user-text"
    assert checked["counts"] == {"entries": 2, "covered": 1, "partial": 0, "gaps": 1, "themes": 2, "unmatched_themes": 1}
    assert [entry["status"] for entry in checked["entries"]] == ["covered", "gap"]
    assert checked["entries"][0]["matches"][0]["label"] == "No shared synthetic benchmark exists"
    assert checked["gaps"] == ["城市洪涝的实时预报"]
    assert checked["unmatched_themes"] == [theme["id"] for theme in themes["themes"] if "Human evaluation" in theme["label"]]
    assert "κ" in checked["manual_review_note"]
    again = call(library, "challenge_comparison", ids=[first["id"], second["id"]], scope=themes["scope"]["hash"],
                 checklist_text="# 我的清单\n- no shared synthetic benchmark\n- 城市洪涝的实时预报\n")
    assert again["id"] == checked["id"] and again["revision"] == 2
    listed = call(library, "challenge_comparison_list", scope=themes["scope"]["hash"])
    assert listed["total"] == 1 and listed["items"][0]["revision"] == 2 and listed["items"][0]["gaps"] == ["城市洪涝的实时预报"]
    assert call(library, "challenge_comparison_get", id=checked["id"])["comparison"]["checklist"]["hash"] == checked["checklist"]["hash"]
    with pytest.raises(ValueError):
        call(library, "challenge_comparison_get", id="cc-" + "0" * 24)


def test_comparison_reads_a_bounded_local_checklist_file(library, tmp_path):
    paper = make_paper(library, tmp_path)
    make_difficulty_draft(library, paper, "No shared synthetic benchmark exists", "No shared benchmark exists.", 2)
    themes = call(library, "challenge_themes", ids=[paper["id"]])
    checklist = tmp_path / "plan.md"
    checklist.write_text("# 研究计划\n- no shared synthetic benchmark\n- 另一条无关条目\n")
    result = call(library, "challenge_comparison", ids=[paper["id"]], scope=themes["scope"]["hash"],
                  checklist_path=str(checklist), checklist_label="我的清单")
    assert result["checklist"]["origin"] == "local-file" and result["checklist"]["source"].startswith("我的清单 (")
    assert result["checklist"]["date"] and result["checklist"]["date"][:2] == "20"
    assert result["counts"]["covered"] == 1
    binary = tmp_path / "notes.pdf"
    binary.write_text("not a checklist")
    with pytest.raises(ValueError):
        call(library, "challenge_comparison", ids=[paper["id"]], checklist_path=str(binary))
    with pytest.raises(ValueError):
        call(library, "challenge_comparison", ids=[paper["id"]], checklist_path=str(tmp_path / "missing.md"))
    with pytest.raises(ValueError):
        call(library, "challenge_comparison", ids=[paper["id"]], checklist_text="# 空清单\n\n")
    with pytest.raises(ValueError):
        call(library, "challenge_comparison", ids=[paper["id"]], checklist_text="# 清单\n- 一条有效条目\n", checklist_date="2026/09/17")


def test_review_packet_writes_findings_and_comparison(library, tmp_path):
    paper = make_paper(library, tmp_path)
    make_difficulty_draft(library, paper, "No shared synthetic benchmark exists", "No shared benchmark exists.", 2)
    themes = call(library, "challenge_themes", ids=[paper["id"]])
    scope = themes["scope"]["hash"]
    compared = call(library, "challenge_comparison", ids=[paper["id"]], scope=scope, checklist_text="# 清单\n- no shared synthetic benchmark\n- 未覆盖的方向\n")
    packet = call(library, "challenge_review_packet", ids=[paper["id"]], scope=scope, comparison_id=compared["id"])
    assert packet["schema"] == "paper-library-challenge-review-packet.v1" and packet["model_calls"] == 0
    assert set(packet["files"]) == {"challenges-review-packet.md", "challenges-review-packet.json"}
    markdown = (library.root / "exports/challenges-review-packet.md").read_text()
    assert "研究难点人工评审包" in markdown and "结构检查 findings" in markdown
    assert "theme-single-paper" in markdown and "[@synthetic2026 p.2]" in markdown
    assert "与自有清单的对照" in markdown and "[缺口] 未覆盖的方向" in markdown
    assert "κ" in markdown and "challenge_theme_review" in markdown
    payload = json.loads((library.root / "exports/challenges-review-packet.json").read_text())
    assert payload["comparison"]["id"] == compared["id"] and payload["themes"][0]["status"] == "needs-review"
    assert payload["provenance"]["review_actions"][0]["action"] == "challenge_theme_review"
    assert payload["counts"]["warning"] >= 1
    other = call(library, "challenge_comparison", ids=[paper["id"]], scope="b" * 64, checklist_text="# 清单\n- no shared synthetic benchmark\n")
    assert other["id"] != compared["id"]
    with pytest.raises(ValueError):
        call(library, "challenge_review_packet", ids=[paper["id"]], scope=scope, comparison_id=other["id"])
    with pytest.raises(ValueError):
        call(library, "challenge_review_packet", ids=[paper["id"]], scope="c" * 64)
