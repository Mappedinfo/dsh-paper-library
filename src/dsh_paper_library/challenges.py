"""Deterministic research-challenge candidate mining (P1) plus later stages.

No model is involved in this module: section headings and trigger phrases are
matched with a fixed lexicon, and every candidate keeps its page and rule IDs.
The model-facing extraction (P2) and cross-paper themes (P3) build on these
records; see docs/research-challenge-mining-design.md.
"""
import hashlib
import json
import re
import unicodedata
from datetime import datetime, timezone

from . import library_knowledge as knowledge
from . import paper_analysis
from pathlib import Path

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
    if action == "challenge_themes":
        return themes(library, request)
    if action == "challenge_theme_list":
        return theme_list(library, request)
    if action == "challenge_theme_get":
        return theme_get(library, request)
    if action == "challenge_theme_review":
        return theme_review(library, request)
    if action == "challenge_theme_merge":
        return theme_merge(library, request)
    if action == "challenge_export":
        return challenge_export(library, request)
    if action == "challenge_theme_check":
        return theme_check(library, request)
    if action == "challenge_comparison":
        return comparison(library, request)
    if action == "challenge_comparison_list":
        return comparison_list(library, request)
    if action == "challenge_comparison_get":
        return comparison_get(library, request)
    if action == "challenge_review_packet":
        return review_packet(library, request)
    raise ValueError("CHALLENGE_INVALID: unsupported challenge action")


# --- P3: cross-paper themes -------------------------------------------------

MAX_THEME_PAPERS = 200
MAX_THEMES = 200
MAX_DRAFTS_PER_PAPER = 100
MAX_MERGE_MEMBERS = 10
MAX_EXPORT_BYTES = 8 * 1024 * 1024
MERGE_JACCARD = 0.6
THEME_STATUSES = {"needs-review", "accepted", "rejected", "merged"}
_IGNORED_TOKENS = {"the", "a", "an", "of", "in", "on", "for", "to", "and", "is", "are", "with", "by", "our",
                   "we", "this", "that", "its", "their", "的", "了", "在", "与", "和", "是"}


def _theme_key(label):
    text = re.sub(r"[\s\W_]+", " ", unicodedata.normalize("NFKC", str(label or "")).lower(), flags=re.UNICODE).strip()
    return re.sub(r"\s+", " ", text)


def _tokens(key):
    return _tokenize(key)


def _themes_schema(library):
    with library.lock():
        library.db.executescript("""
        CREATE TABLE IF NOT EXISTS challenge_themes(
          scope TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
          revision INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
          PRIMARY KEY(scope, id));
        CREATE INDEX IF NOT EXISTS challenge_themes_scope ON challenge_themes(scope, status);
        """)


def _scope_hash(ids):
    return hashlib.sha256(json.dumps(sorted(ids), ensure_ascii=False).encode("utf-8")).hexdigest()


def _difficulty_records(library, paper_ids, include):
    """Collect labelled difficulty nodes and their evidence from saved drafts."""
    records, scanned, skipped = [], 0, []
    statuses = ("accepted",) if include == "accepted" else ("accepted", "needs-review")
    for paper_id in paper_ids:
        try:
            paper = library.get(paper_id, include_archived=True)
        except (ValueError, KeyError):
            skipped.append({"id": paper_id, "reason": "论文不存在或不可读取"})
            continue
        if paper.get("archived"):
            skipped.append({"id": paper_id, "reason": "论文在回收站中"})
            continue
        drafts = []
        for status in statuses:
            page = knowledge.listing(library, "drafts", {"entity": {"kind": "paper", "id": paper_id},
                                                         "status": status, "limit": MAX_DRAFTS_PER_PAPER, "offset": 0})
            drafts.extend(page["items"])
        scanned += 1
        for preview in drafts:
            draft = knowledge.get(library, "drafts", preview["id"])
            sources = {f"{node['type']}:{node['id']}": node for node in draft.get("nodes", []) if node["type"] in knowledge.SOURCES}
            for node in draft.get("nodes", []):
                if node["type"] not in {"gap", "question"} or not node.get("source_status"):
                    continue
                supports = [relation for relation in draft.get("assertions", [])
                            if relation.get("object") == f"{node['type']}:{node['id']}" and relation.get("subject") in sources
                            and relation.get("relation") in {"identifies", "motivates", "justifies", "reports", "evaluates", "supports"}]
                quotes = []
                for relation in supports:
                    source_node = sources[relation["subject"]]
                    if not source_node or not source_node.get("quote"):
                        continue
                    page_number = None
                    if source_node.get("source_id"):
                        try:
                            page_number = knowledge.get(library, "sources", source_node["source_id"])["locator"].get("page")
                        except ValueError:
                            page_number = None
                    quotes.append({"page": page_number, "quote": source_node["quote"]})
                records.append({
                    "paper_id": paper_id, "citekey": paper.get("citekey"), "year": _paper_year(paper),
                    "draft_id": draft["id"], "draft_status": draft["status"], "node_id": f"{node['type']}:{node['id']}",
                    "label": node["label"], "source_status": node["source_status"],
                    "target": (node.get("fields") or {}).get("target"), "quotes": quotes,
                })
    return records, scanned, skipped


def _assemble(scope, key, group, *, label=None, origin="deterministic-aggregation", merged_from=None):
    papers, years, statuses, quotes = {}, [], {"author-stated": 0, "reviewed-stated": 0, "inferred": 0}, []
    for record in group:
        papers.setdefault(record["paper_id"], []).append(record)
        if isinstance(record["year"], int):
            years.append(record["year"])
        statuses[record["source_status"] if record["source_status"] in {"author-stated", "inferred"} else "reviewed-stated"] += 1
        quotes.extend(record["quotes"])
    representative = label or sorted(group, key=lambda item: (item["source_status"] != "author-stated", item["label"]))[0]["label"]
    members = sorted(papers.items(), key=lambda item: (min(record["year"] or 0 for record in item[1]), str(item[0])))
    theme = {
        "id": "ct-" + hashlib.sha256(f"{scope}:{key}".encode("utf-8")).hexdigest()[:24],
        "scope": scope, "key": key, "label": representative,
        "variants": sorted({record["label"] for record in group} - {representative})[:20],
        "paper_count": len(papers), "record_count": len(group),
        "years": {"min": min(years) if years else None, "max": max(years) if years else None,
                  "histogram": {str(year): years.count(year) for year in sorted(set(years))}},
        "source_status": statuses, "quotes": quotes[:40], "evidence_count": len(quotes),
        "papers": [{"paper_id": paper_id, "citekey": values[0]["citekey"], "year": values[0]["year"],
                    "node_id": values[0]["node_id"], "label": values[0]["label"],
                    "source_status": values[0]["source_status"], "draft_id": values[0]["draft_id"],
                    "draft_status": values[0]["draft_status"], "quotes": values[0]["quotes"][:5]}
                   for paper_id, values in members][:50],
        "status": "needs-review", "origin": origin,
    }
    if merged_from:
        theme["merged_from"] = merged_from
    return theme


def _store_theme(library, scope, theme, *, keep_status=True):
    now = _now()
    with library.lock():
        row = library.db.execute("SELECT payload,revision,status FROM challenge_themes WHERE scope=? AND id=?", (scope, theme["id"])).fetchone()
        previous = json.loads(row["payload"]) if row else None
        revision = (row["revision"] + 1) if row else 1
        status = row["status"] if row and keep_status else "needs-review"
        value = {**theme, "status": status, "revision": revision,
                 "previous": {"revision": previous["revision"], "paper_count": previous["paper_count"]} if previous else None,
                 "created": previous["created"] if previous else now, "updated": now}
        library.db.execute(
            "INSERT INTO challenge_themes(scope,id,payload,status,revision,created,updated) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(scope,id) DO UPDATE SET payload=excluded.payload,status=excluded.status,revision=excluded.revision,updated=excluded.updated",
            (scope, theme["id"], json.dumps(value, ensure_ascii=False), status, revision, value["created"], now))
        library.db.commit()
    return value


def _select_scope(library, request):
    ids = request.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > MAX_THEME_PAPERS:
        raise ValueError(f"CHALLENGE_SCOPE: select 1–{MAX_THEME_PAPERS} explicit paper ids")
    if len(set(ids)) != len(ids) or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value) for value in ids):
        raise ValueError("CHALLENGE_SCOPE: paper ids must be unique and well formed")
    include = request.get("include", "accepted")
    if include not in {"accepted", "all"}:
        raise ValueError("CHALLENGE_SCOPE: include must be accepted or all")
    return ids, include


def themes(library, request):
    """Aggregate labelled difficulty records into reviewable corpus themes."""
    ids, include = _select_scope(library, request)
    persist = request.get("persist", True)
    if not isinstance(persist, bool):
        raise ValueError("CHALLENGE_SCOPE: persist must be boolean")
    knowledge.setup(library)
    _themes_schema(library)
    records, scanned, skipped = _difficulty_records(library, ids, include)
    buckets = {}
    for record in records:
        key = _theme_key(record["label"])
        if key:
            buckets.setdefault(key, []).append(record)
    scope = _scope_hash(ids)
    assembled = [_assemble(scope, key, group) for key, group in sorted(buckets.items())[:MAX_THEMES]]
    suggestions = []
    for index, left in enumerate(assembled):
        for right in assembled[index + 1:]:
            left_tokens, right_tokens = _tokens(left["key"]), _tokens(right["key"])
            if not left_tokens or not right_tokens:
                continue
            overlap = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
            if overlap >= MERGE_JACCARD:
                suggestions.append({"left": left["id"], "right": right["id"], "jaccard": round(overlap, 3),
                                    "labels": [left["label"], right["label"]]})
    stored = [_store_theme(library, scope, theme) for theme in assembled] if persist else []
    return {
        "schema": "paper-library-challenge-themes.v1",
        "generated_at": _now(),
        "scope": {"hash": scope, "requested": len(ids), "scanned": scanned, "skipped": skipped, "include": include},
        "totals": {"records": len(records), "themes": len(assembled), "persisted": len(stored)},
        "merge_suggestions": suggestions[:50],
        "themes": stored or assembled,
        "model_calls": 0,
    }


def theme_list(library, request):
    knowledge.setup(library)
    _themes_schema(library)
    limit, offset = request.get("limit", 50), request.get("offset", 0)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_THEMES \
            or isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 100000:
        raise ValueError("CHALLENGE_SCOPE: invalid theme pagination")
    status = request.get("status")
    if status is not None and status not in THEME_STATUSES:
        raise ValueError("CHALLENGE_SCOPE: invalid theme status")
    scope = request.get("scope")
    if scope is not None and (not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope)):
        raise ValueError("CHALLENGE_SCOPE: invalid theme scope")
    clauses, args = [], []
    if scope:
        clauses.append("scope=?")
        args.append(scope)
    if status:
        clauses.append("status=?")
        args.append(status)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    total = library.db.execute(f"SELECT count(*) FROM challenge_themes {where}", args).fetchone()[0]
    rows = library.db.execute(f"SELECT payload FROM challenge_themes {where} ORDER BY updated DESC,id LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    items = [json.loads(row[0]) for row in rows]
    for item in items:
        item["papers"] = item.get("papers", [])[:10]
        item["quotes"] = item.get("quotes", [])[:5]
    return {"scope": scope, "status": status, "total": total, "items": items, "offset": offset, "limit": limit,
            "hasMore": offset + len(items) < total, "model_calls": 0}


def theme_get(library, request):
    knowledge.setup(library)
    _themes_schema(library)
    row = library.db.execute("SELECT payload FROM challenge_themes WHERE id=?", (request.get("id"),)).fetchone()
    if not row:
        raise ValueError("CHALLENGE_MISSING: theme not found")
    return {"theme": json.loads(row[0]), "model_calls": 0}


def theme_review(library, request):
    if request.get("reviewed_by") != "user" or request.get("decision") not in {"accepted", "rejected"}:
        raise ValueError("CHALLENGE_REVIEW_REQUIRED: explicit user review is required")
    knowledge.setup(library)
    _themes_schema(library)
    with library.lock():
        row = library.db.execute("SELECT scope,payload,status,revision FROM challenge_themes WHERE id=?", (request.get("id"),)).fetchone()
        if not row:
            raise ValueError("CHALLENGE_MISSING: theme not found")
        if isinstance(request.get("expected_revision"), bool) or request.get("expected_revision") != row["revision"]:
            raise ValueError("CHALLENGE_CONFLICT: theme revision changed")
        value = json.loads(row["payload"])
        value.update(status=request["decision"], reviewed_by="user", reviewed_at=_now(),
                     revision=row["revision"] + 1, updated=_now())
        library.db.execute("UPDATE challenge_themes SET payload=?,status=?,revision=?,updated=? WHERE id=?",
                           (json.dumps(value, ensure_ascii=False), value["status"], value["revision"], value["updated"], request["id"]))
        library.db.commit()
    return value


def theme_merge(library, request):
    """Merge explicitly selected themes into one reviewable theme; nothing is inferred."""
    if request.get("reviewed_by") != "user":
        raise ValueError("CHALLENGE_REVIEW_REQUIRED: explicit user review is required")
    ids = request.get("theme_ids")
    if not isinstance(ids, list) or not 2 <= len(ids) <= MAX_MERGE_MEMBERS or len(set(ids)) != len(ids) \
            or any(not isinstance(value, str) or not re.fullmatch(r"ct-[a-f0-9]{24}", value) for value in ids):
        raise ValueError(f"CHALLENGE_SCOPE: select 2–{MAX_MERGE_MEMBERS} distinct theme ids")
    revisions = request.get("expected_revisions")
    if isinstance(revisions, list):
        # Tool surfaces pass revisions positionally because the schema compiler
        # rejects map-shaped parameters; both spellings validate identically.
        if len(revisions) != len(ids) or any(isinstance(value, bool) or not isinstance(value, int) for value in revisions):
            raise ValueError("CHALLENGE_SCOPE: expected_revisions must cover every merged theme")
        revisions = dict(zip(ids, revisions))
    if not isinstance(revisions, dict) or set(revisions) != set(ids) or any(isinstance(value, bool) or not isinstance(value, int) for value in revisions.values()):
        raise ValueError("CHALLENGE_SCOPE: expected_revisions must cover every merged theme")
    knowledge.setup(library)
    _themes_schema(library)
    with library.lock():
        rows = {row["id"]: row for row in library.db.execute(
            f"SELECT id,scope,payload,status,revision FROM challenge_themes WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()}
        if len(rows) != len(ids):
            raise ValueError("CHALLENGE_MISSING: theme not found")
        scopes = {row["scope"] for row in rows.values()}
        if len(scopes) != 1:
            raise ValueError("CHALLENGE_SCOPE: merged themes must share one corpus scope")
        scope = scopes.pop()
        for theme_id, row in rows.items():
            if row["revision"] != revisions[theme_id]:
                raise ValueError("CHALLENGE_CONFLICT: theme revision changed")
            if row["status"] == "merged":
                raise ValueError("CHALLENGE_CONFLICT: theme was already merged")
        members = [json.loads(row["payload"]) for row in rows.values()]
    group = [{"paper_id": member["paper_id"], "citekey": member["citekey"], "year": member["year"],
              "draft_id": member["draft_id"], "draft_status": member["draft_status"], "node_id": member["node_id"],
              "label": member["label"], "source_status": member["source_status"], "quotes": member["quotes"]}
             for theme in members for member in theme["papers"]]
    label = request.get("label")
    if label is not None and (not isinstance(label, str) or not label.strip() or len(label) > 200):
        raise ValueError("CHALLENGE_SCOPE: merged label must be bounded text")
    key = f"merged:{'+'.join(sorted(theme['id'] for theme in members))}"
    merged = _assemble(scope, key, group, label=label.strip() if label else None,
                       origin="user-merge", merged_from=sorted(theme["id"] for theme in members))
    value = _store_theme(library, scope, merged, keep_status=False)
    now = _now()
    with library.lock():
        for theme in members:
            theme["status"] = "merged"
            theme["superseded_by"] = value["id"]
            theme["updated"] = now
            library.db.execute("UPDATE challenge_themes SET payload=?,status=?,updated=? WHERE id=?",
                               (json.dumps(theme, ensure_ascii=False), "merged", now, theme["id"]))
        library.db.commit()
    return value


def _csv_cell(value):
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n")


def challenge_export(library, request):
    """Write the CSV/Markdown/BibTeX challenge export under the library's exports/."""
    ids, include = _select_scope(library, request)
    scope = request.get("scope")
    if scope is not None and (not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope)):
        raise ValueError("CHALLENGE_SCOPE: invalid theme scope")
    scope = scope or _scope_hash(ids)
    from . import bibliography
    include_unreviewed = request.get("include_unreviewed", False)
    if not isinstance(include_unreviewed, bool):
        raise ValueError("CHALLENGE_SCOPE: include_unreviewed must be boolean")
    knowledge.setup(library)
    _themes_schema(library)
    statuses = ["accepted"] + (["needs-review"] if include_unreviewed else [])
    placeholders = ",".join("?" * len(statuses))
    rows = library.db.execute(f"SELECT payload FROM challenge_themes WHERE scope=? AND status IN ({placeholders}) ORDER BY id",
                              [scope, *statuses]).fetchall()
    themes_exported = [json.loads(row[0]) for row in rows]
    if not themes_exported:
        raise ValueError("CHALLENGE_MISSING: no reviewed theme to export for this corpus scope")
    generated = _now()
    citekeys = sorted({paper["citekey"] for theme in themes_exported for paper in theme["papers"] if paper.get("citekey")})
    csv_lines = ["theme_id,theme_label,theme_status,theme_revision,paper_id,citekey,year,node_id,source_status,page,quote"]
    for theme in themes_exported:
        for paper in theme["papers"]:
            quotes = paper.get("quotes") or [{"page": None, "quote": None}]
            for quote in quotes:
                cells = [theme["id"], theme["label"], theme["status"], theme["revision"], paper["paper_id"], paper["citekey"],
                         paper["year"], paper["node_id"], paper["source_status"], quote.get("page"), quote.get("quote")]
                csv_lines.append(",".join('"' + _csv_cell(cell).replace('"', '""') + '"' for cell in cells))
    csv_text = "\n".join(csv_lines) + "\n"
    markdown = [
        "# 研究难点主题导出（Research challenge themes）",
        "",
        f"- 生成时间 generated_at：{generated}",
        f"- 语料范围 corpus scope：`{scope}`（请求 {len(ids)} 篇，模式 include={include}）",
        f"- 导出主题 themes：{len(themes_exported)}（状态过滤 status={','.join(statuses)}）",
        f"- 引用论文 citekeys：{len(citekeys)}",
        "- 生成方式 provenance：P1 确定性扫描 + P2 受限抽取 + P3 确定性聚合；本文件不做模型判断。",
        "",
    ]
    for theme in themes_exported:
        years = theme["years"]
        markdown += [
            f"## {theme['label']}",
            "",
            f"- 主题 id：`{theme['id']}`；状态：**{theme['status']}**；修订：{theme['revision']}",
            f"- 覆盖：{theme['paper_count']} 篇 / {theme['record_count']} 条难点记录；证据 {theme['evidence_count']} 条",
            f"- 年份：{years['min']}–{years['max']}；分布 {years['histogram']}",
            f"- 来源状态 source_status：author-stated {theme['source_status']['author-stated']}、"
            f"reviewed-stated {theme['source_status']['reviewed-stated']}、inferred {theme['source_status']['inferred']}",
        ]
        if theme.get("variants"):
            markdown.append(f"- 归一化变体 variants：{'；'.join(theme['variants'])}")
        if theme.get("merged_from"):
            markdown.append(f"- 人工合并自：{', '.join(theme['merged_from'])}")
        markdown += ["", "证据 evidence：", ""]
        for paper in theme["papers"]:
            for quote in (paper.get("quotes") or [{"page": None, "quote": None}]):
                location = f"[@{paper['citekey']}" + (f" p.{quote['page']}" if quote.get("page") else "") + "]"
                markdown.append(f"- {location} ({paper['source_status']}) “{quote.get('quote') or '（缺少逐字引用）'}”")
        markdown.append("")
    markdown += ["## 待审阅的合并建议 merge suggestions", ""]
    suggestions = request.get("merge_suggestions") or []
    if suggestions:
        for suggestion in suggestions:
            markdown.append(f"- `{suggestion['left']}` ↔ `{suggestion['right']}`（相似度 {suggestion['jaccard']}）——待人工确认")
    else:
        markdown.append("- 本次导出没有携带合并建议（合并建议由 `challenge_themes` 返回，需人工复核）。")
    markdown += ["", "## 说明", "",
                 "- 难点与主题一律 `needs-review` 起步，只有人工接受（`status=accepted`）的主题进入本导出。",
                 "- 缺失的逐字引用保持缺失，不补写、不改写；quote 与页码均来自受限抽取记录。",
                 "- BibTeX 仅使用目录中已有的元数据字段，缺失字段省略。", ""]
    bib_entries = []
    for citekey in citekeys:
        found = library.db.execute("SELECT id,metadata,citekey FROM papers WHERE citekey=?", (citekey,)).fetchone()
        if not found:
            continue
        metadata = json.loads(found["metadata"])
        entry_type, fields = knowledge.bib_fields(metadata)
        bib_entries.append(knowledge.bib_entry(entry_type, citekey, fields))
    bib_text = "% Research challenge themes export\n" \
               f"% generated_at {generated}\n% corpus scope {scope}\n% citekeys {len(bib_entries)} of {len(citekeys)}\n\n" \
               + "\n".join(bib_entries)
    payloads = {"exports/challenges.csv": csv_text, "exports/challenges.md": "\n".join(markdown), "exports/challenges.bib": bib_text}
    for relative, content in payloads.items():
        if len(content.encode("utf-8")) > MAX_EXPORT_BYTES:
            raise ValueError(f"CHALLENGE_EXPORT: {relative} exceeds the 8 MiB export budget")
    exports = library.root / "exports"
    exports.mkdir(exist_ok=True, mode=0o700)
    written = {}
    for relative, content in payloads.items():
        path = library.root / relative
        bibliography._atomic_write(path, content.encode("utf-8"))
        written[path.name] = {"path": str(path), "bytes": len(content.encode("utf-8"))}
    return {"schema": "paper-library-challenge-export.v1", "generated_at": generated, "scope": scope,
            "themes": len(themes_exported), "rows": max(len(csv_lines) - 1, 0), "citekeys": citekeys,
            "files": written, "model_calls": 0}


# --- P4: comparison, structural check and review packet ---------------------

MAX_CHECKLIST_ENTRIES = 200
MAX_CHECKLIST_CHARACTERS = 65536
MAX_CHECKLIST_FILE_BYTES = 1024 * 1024
MAX_PACKET_BYTES = 8 * 1024 * 1024
MATCH_STRONG = 0.5
MATCH_WEAK = 0.2
CHECKLIST_EXTENSIONS = {".md", ".markdown", ".txt", ".text", ".json", ".csv", ".bib"}
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_CHECKLIST_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.)、])\s*")
_CHECKLIST_HEADING = re.compile(r"^\s*#{1,6}\s*")


def _tokenize(key):
    """Whitespace tokens for Latin text, character bigrams for CJK labels."""
    tokens = set()
    for token in key.split():
        if not token or token in _IGNORED_TOKENS:
            continue
        if _CJK.search(token):
            cleaned = re.sub(r"[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]+", "", token)
            if not cleaned:
                continue
            if len(cleaned) <= 2:
                tokens.add(cleaned)
            else:
                tokens.update(cleaned[index:index + 2] for index in range(len(cleaned) - 1))
        else:
            tokens.add(token)
    return tokens


def _overlap(left, right):
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _comparison_schema(library):
    with library.lock():
        library.db.executescript("""
        CREATE TABLE IF NOT EXISTS challenge_comparisons(
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL,
          created TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS challenge_comparisons_scope ON challenge_comparisons(scope, updated);
        """)


def _checklist_entries(library, request):
    source, reference_date, origin = "pasted text", None, "user-text"
    text = request.get("checklist_text")
    if text is not None and text not in (None, ""):
        if not isinstance(text, str) or len(text) > MAX_CHECKLIST_CHARACTERS:
            raise ValueError("CHALLENGE_SCOPE: checklist text exceeds 65536 characters")
    elif request.get("checklist_path"):
        raw = request["checklist_path"]
        if not isinstance(raw, str) or len(raw) > 4096:
            raise ValueError("CHALLENGE_SCOPE: invalid checklist path")
        path = Path(raw).expanduser()
        if path.suffix.lower() not in CHECKLIST_EXTENSIONS:
            raise ValueError("CHALLENGE_SCOPE: checklist must be a text, Markdown, JSON, CSV or BibTeX file")
        if not path.is_file():
            raise ValueError("CHALLENGE_MISSING: checklist file not found")
        data = path.read_bytes()
        if len(data) > MAX_CHECKLIST_FILE_BYTES:
            raise ValueError("CHALLENGE_SCOPE: checklist file exceeds 1 MiB")
        text = data.decode("utf-8", errors="replace")
        source, origin = str(path), "local-file"
        reference_date = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    else:
        raise ValueError("CHALLENGE_SCOPE: provide checklist_text or checklist_path")
    if request.get("checklist_date") is not None:
        if not isinstance(request["checklist_date"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", request["checklist_date"]):
            raise ValueError("CHALLENGE_SCOPE: checklist_date must be YYYY-MM-DD")
        reference_date = request["checklist_date"]
    if request.get("checklist_label") is not None:
        if not isinstance(request["checklist_label"], str) or not request["checklist_label"].strip() or len(request["checklist_label"]) > 200:
            raise ValueError("CHALLENGE_SCOPE: checklist label must be bounded text")
        source = f"{request['checklist_label'].strip()} ({source})"
    bullets, plain, headings = [], [], []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("|") or stripped.startswith("```"):
            continue
        is_heading = bool(_CHECKLIST_HEADING.match(stripped))
        candidate = _CHECKLIST_HEADING.sub("", _CHECKLIST_BULLET.sub("", stripped)).strip().strip("*_` ")
        if not candidate:
            continue
        # A long line is often several comma-separated asks; short lines stay whole.
        parts = re.split(r"[；;]", candidate) if len(candidate) > 60 else [candidate]
        for part in parts:
            value = part.strip().strip("*_` ")
            if len(value) < 3:
                continue
            (bullets if _CHECKLIST_BULLET.match(stripped) else headings if is_heading else plain).append(value[:400])
    # Bullets win; a plain-line list is the fallback; a multi-heading outline is
    # the last resort, so a lone document title never becomes a checklist entry.
    chosen = bullets or plain or (headings if len(headings) >= 2 else [])
    entries, seen = [], set()
    for value in chosen:
        if value.lower() in seen:
            continue
        seen.add(value.lower())
        entries.append(value)
    if not entries:
        raise ValueError("CHALLENGE_SCOPE: checklist produced no comparable entries")
    return {"source": source, "origin": origin, "date": reference_date, "entries": entries}


def _stored_themes(library, scope, statuses=None, limit=MAX_THEMES):
    clauses, args = ["scope=?"], [scope]
    if statuses:
        clauses.append(f"status IN ({','.join('?' * len(statuses))})")
        args.extend(statuses)
    rows = library.db.execute(f"SELECT payload FROM challenge_themes WHERE {' AND '.join(clauses)} ORDER BY id LIMIT ?", [*args, limit]).fetchall()
    return [json.loads(row[0]) for row in rows]


def theme_check(library, request):
    """Structural findings over stored themes; read-only, no model, no rewrite."""
    scope = request.get("scope")
    if not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope):
        raise ValueError("CHALLENGE_SCOPE: invalid theme scope")
    knowledge.setup(library)
    _themes_schema(library)
    statuses = request.get("statuses")
    if statuses is not None and (not isinstance(statuses, list) or not statuses or any(value not in THEME_STATUSES for value in statuses)):
        raise ValueError("CHALLENGE_SCOPE: invalid theme status filter")
    stored = _stored_themes(library, scope, statuses)
    findings = []
    for theme in stored:
        findings.extend(_theme_findings(theme))
    counts = {severity: sum(1 for finding in findings if finding["severity"] == severity) for severity in ("error", "warning", "info")}
    by_status = {status: sum(1 for theme in stored if theme["status"] == status) for status in sorted(THEME_STATUSES)}
    return {
        "schema": "paper-library-challenge-theme-check.v1", "generated_at": _now(), "scope": scope,
        "themes": len(stored), "counts": counts, "by_status": by_status,
        "findings": findings[:200], "truncated": len(findings) > 200, "model_calls": 0,
    }


def _theme_findings(theme):
    findings = []
    base = {"theme_id": theme["id"], "label": theme["label"], "status": theme["status"]}
    if not theme.get("evidence_count"):
        findings.append({**base, "code": "theme-without-evidence", "severity": "error", "message": "主题没有任何逐字引用；不能作为结论使用。"})
    if theme.get("paper_count", 0) < 2:
        findings.append({**base, "code": "theme-single-paper", "severity": "warning", "message": "主题只覆盖 1 篇文献，尚不构成跨篇结论。"})
    if not (theme.get("source_status") or {}).get("author-stated"):
        findings.append({**base, "code": "theme-inferred-only", "severity": "warning", "message": "主题没有作者自陈的难点记录，全部来自推断或外部评审。"})
    if theme["status"] == "needs-review":
        findings.append({**base, "code": "theme-unreviewed", "severity": "info", "message": "主题尚未经过人工复核。"})
    if theme["status"] == "merged":
        findings.append({**base, "code": "theme-merged-member", "severity": "info", "message": f"该主题已被合并到 {theme.get('superseded_by')}。"})
    if theme.get("revision", 1) > 1:
        findings.append({**base, "code": "theme-revised", "severity": "info", "message": f"主题已修订 {theme['revision'] - 1} 次，导出前请确认看过最新版本。"})
    return findings


def comparison(library, request):
    """Deterministic comparison of accepted themes against a user-owned checklist."""
    ids, include = _select_scope(library, request)
    scope = request.get("scope")
    if scope is not None and (not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope)):
        raise ValueError("CHALLENGE_SCOPE: invalid theme scope")
    scope = scope or _scope_hash(ids)
    knowledge.setup(library)
    _themes_schema(library)
    _comparison_schema(library)
    checklist = _checklist_entries(library, request)
    # A comparison is a report, not an export: every stored theme is compared and
    # its review status is reported, so a gap decision is never made on a filter.
    statuses = request.get("statuses", sorted(THEME_STATUSES))
    if not isinstance(statuses, list) or not statuses or any(value not in THEME_STATUSES for value in statuses):
        raise ValueError("CHALLENGE_SCOPE: invalid theme status filter")
    stored = _stored_themes(library, scope, statuses)
    theme_tokens = {theme["id"]: _tokenize(" ".join([theme["key"], *theme.get("variants", []), theme["label"]])) for theme in stored}
    entry_tokens = [_tokenize(_theme_key(entry)) for entry in checklist["entries"]]
    entries = []
    for index, entry in enumerate(checklist["entries"]):
        matches = sorted(({"theme_id": theme["id"], "label": theme["label"], "status": theme["status"],
                           "overlap": round(_overlap(entry_tokens[index], theme_tokens[theme["id"]]), 3)}
                          for theme in stored if _overlap(entry_tokens[index], theme_tokens[theme["id"]]) >= MATCH_WEAK),
                         key=lambda item: (-item["overlap"], item["theme_id"]))
        best = matches[0]["overlap"] if matches else 0.0
        entries.append({"entry": entry, "matches": matches[:10],
                        "status": "covered" if best >= MATCH_STRONG else "partial" if matches else "gap",
                        "best_overlap": best})
    themes = [{"theme_id": theme["id"], "label": theme["label"], "status": theme["status"],
               "entries": [entry["entry"] for entry in entries if any(match["theme_id"] == theme["id"] for match in entry["matches"])]}
              for theme in stored]
    gaps = [entry["entry"] for entry in entries if entry["status"] == "gap"]
    unmatched = [theme["theme_id"] for theme in themes if not theme["entries"]]
    checklist_hash = hashlib.sha256("\n".join(checklist["entries"]).encode("utf-8")).hexdigest()
    record_id = "cc-" + hashlib.sha256(f"{scope}:{checklist_hash}".encode("utf-8")).hexdigest()[:24]
    now = _now()
    with library.lock():
        row = library.db.execute("SELECT payload FROM challenge_comparisons WHERE id=?", (record_id,)).fetchone()
        previous = json.loads(row[0]) if row else None
        revision = (previous["revision"] + 1) if previous else 1
        value = {
            "schema": "paper-library-challenge-comparison.v1", "id": record_id, "scope": scope,
            "generated_at": now, "revision": revision, "checklist": {**checklist, "hash": checklist_hash},
            "statuses": statuses, "thresholds": {"strong": MATCH_STRONG, "weak": MATCH_WEAK},
            "counts": {"entries": len(entries), "covered": sum(1 for entry in entries if entry["status"] == "covered"),
                       "partial": sum(1 for entry in entries if entry["status"] == "partial"), "gaps": len(gaps),
                       "themes": len(themes), "unmatched_themes": len(unmatched)},
            "entries": entries, "themes": themes, "gaps": gaps, "unmatched_themes": unmatched,
            "manual_review_note": "匹配只比较词面重叠，不判断研究价值、饱和度或一致性；κ 一类人工编码结论必须由人独立完成。",
            "created": previous["created"] if previous else now, "model_calls": 0,
        }
        library.db.execute(
            "INSERT INTO challenge_comparisons(id,scope,payload,revision,created,updated) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated=excluded.updated",
            (record_id, scope, json.dumps(value, ensure_ascii=False), revision, value["created"], now))
        library.db.commit()
    return value


def comparison_list(library, request):
    knowledge.setup(library)
    _comparison_schema(library)
    limit, offset = request.get("limit", 20), request.get("offset", 0)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200 \
            or isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 100000:
        raise ValueError("CHALLENGE_SCOPE: invalid comparison pagination")
    scope = request.get("scope")
    if scope is not None and (not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope)):
        raise ValueError("CHALLENGE_SCOPE: invalid theme scope")
    where, args = ("WHERE scope=?", [scope]) if scope else ("", [])
    total = library.db.execute(f"SELECT count(*) FROM challenge_comparisons {where}", args).fetchone()[0]
    rows = library.db.execute(f"SELECT payload FROM challenge_comparisons {where} ORDER BY updated DESC,id LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    items = []
    for row in rows:
        value = json.loads(row[0])
        items.append({key: value[key] for key in ("id", "scope", "generated_at", "revision", "checklist", "counts", "gaps", "unmatched_themes")})
    return {"scope": scope, "total": total, "items": items, "offset": offset, "limit": limit,
            "hasMore": offset + len(items) < total, "model_calls": 0}


def comparison_get(library, request):
    knowledge.setup(library)
    _comparison_schema(library)
    row = library.db.execute("SELECT payload FROM challenge_comparisons WHERE id=?", (request.get("id"),)).fetchone()
    if not row:
        raise ValueError("CHALLENGE_MISSING: comparison not found")
    return {"comparison": json.loads(row[0]), "model_calls": 0}


def review_packet(library, request):
    """Write the human review packet: themes, findings, comparison, manual note."""
    ids, include = _select_scope(library, request)
    scope = request.get("scope")
    if scope is not None and (not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope)):
        raise ValueError("CHALLENGE_SCOPE: invalid theme scope")
    scope = scope or _scope_hash(ids)
    knowledge.setup(library)
    _themes_schema(library)
    _comparison_schema(library)
    statuses = request.get("statuses", list(THEME_STATUSES))
    if not isinstance(statuses, list) or not statuses or any(value not in THEME_STATUSES for value in statuses):
        raise ValueError("CHALLENGE_SCOPE: invalid theme status filter")
    stored = _stored_themes(library, scope, statuses)
    if not stored:
        raise ValueError("CHALLENGE_MISSING: no theme to review for this corpus scope")
    findings = [finding for theme in stored for finding in _theme_findings(theme)]
    compared = None
    if request.get("comparison_id") is not None:
        compared = comparison_get(library, {"id": request["comparison_id"]})["comparison"]
        if compared["scope"] != scope:
            raise ValueError("CHALLENGE_SCOPE: comparison belongs to another corpus scope")
    generated = _now()
    counts = {severity: sum(1 for finding in findings if finding["severity"] == severity) for severity in ("error", "warning", "info")}
    packet = {
        "schema": "paper-library-challenge-review-packet.v1", "generated_at": generated, "scope": scope,
        "statuses": statuses, "themes": stored, "findings": findings, "counts": counts,
        "comparison": compared,
        "manual_note": "匹配与结构检查只报告可核验事实；研究价值、主题饱和度与编码一致性（κ）必须由人另行判断。",
        "provenance": {
            "pipeline": "P1 deterministic scan → P2 bounded per-paper extraction → P3 deterministic aggregation",
            "review_actions": [
                {"action": "challenge_theme_review", "params": {"id": "<theme id>", "decision": "accepted|rejected", "reviewed_by": "user", "expected_revision": "<revision>"}},
                {"action": "challenge_theme_merge", "params": {"theme_ids": ["<id>", "<id>"], "expected_revisions": ["<revision>", "<revision>"], "reviewed_by": "user"}},
                {"action": "challenge_export", "params": {"ids": ids, "scope": scope}},
            ],
        },
        "model_calls": 0,
    }
    markdown = [
        "# 研究难点人工评审包（manual review packet）", "",
        f"- 生成时间 generated_at：{generated}",
        f"- 语料范围 corpus scope：`{scope}`（请求 {len(ids)} 篇）",
        f"- 状态过滤 statuses：{', '.join(statuses)}",
        f"- 结构检查：{counts['error']} 错误 · {counts['warning']} 警告 · {counts['info']} 提示",
        "- 生成方式：P1 确定性扫描 + P2 受限抽取 + P3 确定性聚合；本文件不包含模型判断。",
        "- 阅读顺序：先看结构检查 → 逐条确认引用（citekey + 页码）→ 接受/否决/合并 → 再运行导出。", "",
    ]
    if findings:
        markdown += ["## 结构检查 findings", ""]
        for finding in findings:
            markdown.append(f"- [{ {'error': '错误', 'warning': '警告', 'info': '提示'}[finding['severity']] }] `{finding['code']}` {finding['label']}（`{finding['theme_id']}`，{finding['status']}）：{finding['message']}")
        markdown.append("")
    for theme in stored:
        years = theme["years"]
        markdown += [
            f"## {theme['label']}", "",
            f"- 主题 id：`{theme['id']}`；状态 **{theme['status']}**；修订 {theme['revision']}",
            f"- 覆盖 {theme['paper_count']} 篇 / {theme['record_count']} 条记录；证据 {theme['evidence_count']} 条；年份 {years['min']}–{years['max']}",
            f"- source_status：author-stated {theme['source_status']['author-stated']} · reviewed-stated {theme['source_status']['reviewed-stated']} · inferred {theme['source_status']['inferred']}",
        ]
        if theme.get("merged_from"):
            markdown.append(f"- 合并自：{', '.join(theme['merged_from'])}")
        markdown.append("")
        for paper in theme["papers"]:
            for quote in (paper.get("quotes") or [{"page": None, "quote": None}]):
                markdown.append(f"- [@{paper['citekey']}" + (f" p.{quote['page']}" if quote.get("page") else "") + f"] ({paper['source_status']}) “{quote.get('quote') or '（缺少逐字引用）'}”")
        markdown.append("")
    if compared:
        markdown += ["## 与自有清单的对照 comparison", "",
                     f"- 对照清单 checklist：`{compared['checklist']['source']}`（日期 {compared['checklist']['date'] or '未知'}，{len(compared['checklist']['entries'])} 条）",
                     f"- 覆盖 covered {compared['counts']['covered']} · 部分 partial {compared['counts']['partial']} · 缺口 gaps {compared['counts']['gaps']} · 未匹配主题 {compared['counts']['unmatched_themes']}", ""]
        for entry in compared["entries"]:
            matched = "；".join(f"{match['label']}（{match['overlap']}）" for match in entry["matches"][:3]) or "无"
            markdown.append(f"- [{ {'covered': '覆盖', 'partial': '部分', 'gap': '缺口'}[entry['status']] }] {entry['entry']} → {matched}")
        markdown.append("")
    markdown += ["## 人工说明", "", f"- {packet['manual_note']}",
                 "- 复核动作只通过 `challenge_theme_review` / `challenge_theme_merge` 生效，插件不会自动接受任何主题。", ""]
    markdown_text = "\n".join(markdown)
    json_text = json.dumps(packet, ensure_ascii=False, indent=1, allow_nan=False) + "\n"
    for name, content in (("challenges-review-packet.md", markdown_text), ("challenges-review-packet.json", json_text)):
        if len(content.encode("utf-8")) > MAX_PACKET_BYTES:
            raise ValueError(f"CHALLENGE_EXPORT: {name} exceeds the 8 MiB export budget")
    from . import bibliography
    exports = library.root / "exports"
    exports.mkdir(exist_ok=True, mode=0o700)
    written = {}
    for name, content in (("challenges-review-packet.md", markdown_text), ("challenges-review-packet.json", json_text)):
        path = exports / name
        bibliography._atomic_write(path, content.encode("utf-8"))
        written[name] = {"path": str(path), "bytes": len(content.encode("utf-8"))}
    return {"schema": "paper-library-challenge-review-packet.v1", "generated_at": generated, "scope": scope,
            "themes": len(stored), "counts": counts, "comparison": compared["id"] if compared else None,
            "files": written, "model_calls": 0}
