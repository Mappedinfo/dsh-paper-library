"""Deterministic research-challenge candidate mining (P1) plus later stages.

No model is involved in this module: section headings and trigger phrases are
matched with a fixed lexicon, and every candidate keeps its page and rule IDs.
The model-facing extraction (P2) and cross-paper themes (P3) build on these
records; see docs/research-challenge-mining-design.md.
"""
import re
from datetime import datetime, timezone

from . import library_knowledge as knowledge
from . import paper_analysis

MAX_PAPERS = 50
MAX_SECTIONS_PER_PAPER = 6
MAX_CANDIDATES_PER_PAPER = 40
MAX_CANDIDATE_CHARACTERS = 1200
MAX_CHARACTERS_PER_PAPER = 24000
MAX_PAGES_PER_PAPER = 200
MAX_TOTAL_CANDIDATES = 400
MAX_TOTAL_CHARACTERS = 200000

SECTION_ALIASES = {
    "abstract": "abstract",
    "introduction": "introduction",
    "related work": "related-work",
    "related works": "related-work",
    "literature review": "related-work",
    "background": "background",
    "method": "method",
    "methods": "method",
    "methodology": "method",
    "materials and methods": "method",
    "experiment": "experiment",
    "experiments": "experiment",
    "evaluation": "experiment",
    "results": "results",
    "result": "results",
    "results and discussion": "results",
    "discussion": "discussion",
    "discussion and limitations": "discussion",
    "limitation": "limitations",
    "limitations": "limitations",
    "limitations and future work": "limitations",
    "limitations and discussion": "limitations",
    "future work": "future-work",
    "future works": "future-work",
    "future directions": "future-work",
    "future research": "future-work",
    "conclusion": "conclusion",
    "conclusions": "conclusion",
    "conclusion and future work": "conclusion",
    "conclusions and future work": "conclusion",
    "threats to validity": "threats-to-validity",
    "threat to validity": "threats-to-validity",
    "threats to validity and limitations": "threats-to-validity",
    "摘要": "abstract",
    "引言": "introduction",
    "绪论": "introduction",
    "相关工作": "related-work",
    "研究背景": "background",
    "背景": "background",
    "方法": "method",
    "研究方法": "method",
    "实验": "experiment",
    "实验结果": "results",
    "结果": "results",
    "结果与讨论": "results",
    "讨论": "discussion",
    "局限": "limitations",
    "局限性": "limitations",
    "不足": "limitations",
    "未来工作": "future-work",
    "展望": "future-work",
    "结论": "conclusion",
}

# Reading order follows where authors actually report difficulty (design §1).
SECTION_PRIORITY = ("limitations", "future-work", "threats-to-validity", "discussion", "conclusion",
                    "introduction", "background", "related-work", "results", "experiment", "method")

TRIGGERS = (
    ("en-limitation", re.compile(r"\b(limitation|limitations|drawback|shortcoming|weakness)\w*\b", re.I)),
    ("en-challenge", re.compile(r"\b(challenge|challenges|difficult\w*|hard to|struggle)\b", re.I)),
    ("en-contrast", re.compile(r"\b(however|nevertheless|nonetheless|despite|although|though|yet|in contrast)\b", re.I)),
    ("en-negative", re.compile(r"\b(fail(?:s|ed|ure)? to|lack(?:s|ing)? of|cannot|unable to|does not support|do not support|did not (?:consider|account)|overlook\w*|ignore[sd]?)\b", re.I)),
    ("en-open", re.compile(r"\b(future work|future research|remains? (?:unclear|unknown|open|unresolved)|still unclear|unexplored|little is known|has not been studied|yet to be)\b", re.I)),
    ("zh-limitation", re.compile(r"(局限|不足之处|不足|缺陷|缺点|弱点)")),
    ("zh-challenge", re.compile(r"(挑战|难题|困难|难以|很难|不易)")),
    ("zh-contrast", re.compile(r"(然而|但是|但|尽管|虽然|不过)")),
    ("zh-negative", re.compile(r"(未能|无法|不能|不支持|未考虑|忽略|缺乏|忽视了)")),
    ("zh-open", re.compile(r"(未来工作|未来研究|尚未|仍有待|有待解决|尚不清楚|鲜有研究|值得进一步)")),
)
RULE_IDS = tuple(rule for rule, _ in TRIGGERS)

_NUMBERED = r"(?:\d+(?:\.\d+)*\.?\s*)?"
_HEADING = re.compile(r"^" + _NUMBERED + r"([A-Za-z][A-Za-z \-/&]{2,60}|[\u4e00-\u9fff]{2,12})\s*[:：]?\s*$")
_SUBHEADING = re.compile(r"^\d+(?:\.\d+)*\.?\s+[A-Z\u4e00-\u9fff][^\n]{0,80}$")
# A recognised section ends where the bibliography or back matter starts.
_TERMINATORS = {"references", "reference", "bibliography", "acknowledgements", "acknowledgments",
                "funding", "appendix", "appendices", "supplementary material", "作者贡献", "参考文献", "致谢", "附录"}
_ABBREVIATIONS = {"al", "e.g", "i.e", "cf", "fig", "figs", "eq", "eqs", "no", "nos", "vs", "sec", "secs",
                  "ref", "refs", "approx", "dr", "prof", "st", "jr", "sr", "inc", "ltd", "etc", "resp"}
_SENTENCE_BREAK = re.compile(r"(?<=[.!?。！？])\s+")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _normalize_heading(value):
    text = re.sub(r"^\d+(?:\.\d+)*\.?\s*", "", value.strip().strip(":.：")).strip()
    text = re.sub(r"\s+", " ", text).strip(":.：").lower()
    if text in _TERMINATORS:
        return "__end__"
    return SECTION_ALIASES.get(text)


def _split_sentences(text):
    """Split on sentence punctuation while keeping common abbreviations intact."""
    sentences, start = [], 0
    for match in _SENTENCE_BREAK.finditer(text):
        head = text[start:match.end()].strip()
        if not head:
            continue
        stem = head[:-1].rstrip()
        words = stem.split()
        last = words[-1].lower().rstrip(".") if words else ""
        if last in _ABBREVIATIONS or re.fullmatch(r"[a-z]", last):
            continue  # "et al." or an initial such as "J." does not end a sentence
        sentences.append(head)
        start = match.end()
    remainder = text[start:].strip()
    if remainder:
        sentences.append(remainder)
    return sentences


def _page_lines(library, path):
    """Yield (page_number, line) in reading order for the bounded page range."""
    with library._open_pdf(path) as doc:
        limit = min(doc.page_count, MAX_PAGES_PER_PAPER)
        for number in range(1, limit + 1):
            text = library._page(doc, number).get_text("text", sort=True)
            for line in text.splitlines():
                yield number, line


def _sections(lines):
    """Group lines into alias-named sections; unrecognized headings are dropped
    from body text but never break a recognized section (subsections stay inside)."""
    sections, current = {}, None
    for page, raw in lines:
        line = raw.strip()
        if not line:
            continue
        alias = _normalize_heading(line)
        if alias == "__end__":
            current = None
            continue
        if alias:
            current = alias
            sections.setdefault(current, [])
            continue
        if _SUBHEADING.match(line) and len(line.split()) <= 12 and not line.endswith((".", "。", "!", "?", "！", "？")):
            continue  # A numbered subsection heading is structure, not evidence.
        if current:
            sections[current].append((page, line))
    return sections


def _paper_title(library, paper):
    title = paper.get("title")
    return title[:300] if isinstance(title, str) else ""


def _paper_year(paper):
    parts = (paper.get("issued") or {}).get("date-parts") if isinstance(paper.get("issued"), dict) else None
    if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0] and isinstance(parts[0][0], int):
        return parts[0][0]
    return None


def scan(library, request):
    """Explicit, bounded, model-free candidate mining over selected papers."""
    ids = request.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > MAX_PAPERS:
        raise ValueError(f"CHALLENGE_SCOPE: select 1–{MAX_PAPERS} explicit paper ids")
    if len(set(ids)) != len(ids) or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value) for value in ids):
        raise ValueError("CHALLENGE_SCOPE: paper ids must be unique and well formed")
    requested_sections = request.get("sections")
    if requested_sections is not None:
        if (not isinstance(requested_sections, list) or not requested_sections
                or len(requested_sections) > MAX_SECTIONS_PER_PAPER
                or any(section not in SECTION_ALIASES.values() for section in requested_sections)
                or len(set(requested_sections)) != len(requested_sections)):
            raise ValueError("CHALLENGE_SCOPE: sections must be unique known section names")

    persist = request.get("persist", False)
    if not isinstance(persist, bool):
        raise ValueError("CHALLENGE_SCOPE: persist must be boolean")
    if persist and len(ids) != 1:
        raise ValueError("CHALLENGE_SCOPE: persisting candidate sources requires exactly one paper")
    papers, skipped, rule_counts = [], [], {rule: 0 for rule in RULE_IDS}
    total_candidates = total_characters = 0
    aggregate_truncated = False
    for paper_id in ids:
        try:
            paper = library.get(paper_id, include_archived=True)
        except (ValueError, KeyError):
            skipped.append({"id": paper_id, "reason": "论文不存在或不可读取"})
            continue
        if paper.get("archived"):
            skipped.append({"id": paper_id, "reason": "论文在回收站中，恢复后再扫描"})
            continue
        if not paper.get("pdf"):
            skipped.append({"id": paper_id, "reason": "尚未关联 PDF"})
            continue
        path = library.pdf_path(paper_id)
        found = _sections(_page_lines(library, path))
        available = [section for section in SECTION_PRIORITY if section in found]
        chosen = [section for section in (requested_sections or available)]
        chosen = [section for section in chosen if section in found][:MAX_SECTIONS_PER_PAPER]
        candidates, characters, truncated = [], 0, False
        for section in chosen:
            for page, line in found[section]:
                for sentence in _split_sentences(line):
                    text = sentence.strip()
                    if not 20 <= len(text) <= MAX_CANDIDATE_CHARACTERS:
                        continue
                    rules = [rule for rule, pattern in TRIGGERS if pattern.search(text)]
                    if not rules:
                        continue
                    if len(candidates) >= MAX_CANDIDATES_PER_PAPER or characters + len(text) > MAX_CHARACTERS_PER_PAPER:
                        truncated = True
                        break
                    if total_candidates >= MAX_TOTAL_CANDIDATES or total_characters + len(text) > MAX_TOTAL_CHARACTERS:
                        aggregate_truncated = truncated = True
                        break
                    candidates.append({"section": section, "page": page, "text": text, "rules": rules})
                    characters += len(text)
                    total_candidates += 1
                    total_characters += len(text)
                    for rule in rules:
                        rule_counts[rule] += 1
                if truncated:
                    break
            if truncated:
                break
        papers.append({
            "id": paper_id, "citekey": paper.get("citekey"), "title": _paper_title(library, paper),
            "year": _paper_year(paper), "sections_found": list(found.keys()), "sections_used": chosen,
            "candidates": candidates, "characters": characters, "truncated": truncated,
            "warnings": [] if found else ["未识别到任何小节标题；该篇未产出候选"],
        })

    persisted = None
    if persist and papers and papers[0]["candidates"]:
        saved = _freeze(library, library.get(papers[0]["id"]), papers[0])
        persisted = {"source_ids": [source["id"] for source in saved], "sources": len(saved)}
    return {
        "schema": "paper-library-challenge-candidates.v1",
        **({"persisted": persisted} if persist else {}),
        "generated_at": _now(),
        "scope": {"requested": len(ids), "scanned": len(papers), "skipped": skipped},
        "budgets": {
            "papers": MAX_PAPERS, "sections_per_paper": MAX_SECTIONS_PER_PAPER,
            "candidates_per_paper": MAX_CANDIDATES_PER_PAPER, "candidate_characters": MAX_CANDIDATE_CHARACTERS,
            "characters_per_paper": MAX_CHARACTERS_PER_PAPER, "pages_per_paper": MAX_PAGES_PER_PAPER,
            "total_candidates": MAX_TOTAL_CANDIDATES, "total_characters": MAX_TOTAL_CHARACTERS,
        },
        "rules": rule_counts,
        "totals": {"candidates": total_candidates, "characters": total_characters, "truncated": aggregate_truncated},
        "papers": papers,
        "model_calls": 0,
    }


def _freeze(library, paper, entry):
    """Freeze one scanned paper's candidates as immutable knowledge sources."""
    version = paper_analysis.file_version(library.pdf_path(paper["id"]))
    knowledge.setup(library)
    saved = []
    for index, candidate in enumerate(entry["candidates"]):
        saved.append(knowledge.source_put(library, {
            "entity": {"kind": "paper", "id": paper["id"]}, "kind": "source-note",
            "text": candidate["text"],
            "title": f"PDF p{candidate['page']} · {candidate['section']} · {paper.get('citekey') or paper['id']}"[:500],
            "locator": {"page": candidate["page"], "section": f"{candidate['section']} · candidate {index + 1}"},
        }, trusted_provenance={"kind": "challenge-candidate", "file_version": version, "scope": "section-scan",
                               "sections": entry["sections_used"], "rules": candidate["rules"],
                               "extraction": "plain-text", "ocr": False, "truncated": entry["truncated"]}))
    return saved


def sources(library, request):
    """Freeze one paper's candidates as bounded, immutable knowledge sources.

    The extraction stage reads only these snapshots, so a later PDF edit cannot
    change what was reviewed, and a changed PDF re-scans into new sources.
    """
    paper_id = request.get("id")
    if not isinstance(paper_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", paper_id) or paper_id.startswith("dataset_"):
        raise ValueError("CHALLENGE_SCOPE: select one paper id")
    scanned = scan(library, {"ids": [paper_id], "sections": request.get("sections")})
    if not scanned["papers"]:
        reason = scanned["scope"]["skipped"][0]["reason"] if scanned["scope"]["skipped"] else "无法扫描"
        raise ValueError(f"CHALLENGE_SCOPE: {reason}")
    entry = scanned["papers"][0]
    paper = library.get(paper_id)
    saved = _freeze(library, paper, entry)
    return {
        "schema": "paper-library-challenge-sources.v1",
        "paper": {"id": paper_id, "citekey": paper.get("citekey"), "title": _paper_title(library, paper),
                  "year": _paper_year(paper)},
        "sources": saved, "source_ids": [source["id"] for source in saved],
        "sections_used": entry["sections_used"], "candidates": len(entry["candidates"]),
        "characters": entry["characters"], "truncated": entry["truncated"], "warnings": entry["warnings"],
        "budgets": scanned["budgets"], "rules": scanned["rules"], "model_calls": 0,
    }


def dispatch(library, request):
    action = request.get("action")
    if action == "challenge_scan":
        return scan(library, request)
    if action == "challenge_sources":
        return sources(library, request)
    raise ValueError("CHALLENGE_INVALID: unsupported challenge action")
