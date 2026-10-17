"""Bulk metadata enrichment for external sources (design: docs/bulk-import-design.md).

对 external_scan 建立的目录条目做有界、可续跑、从不臆造的元数据富化：
文件名/首页证据 → arXiv / CrossRef 提供方 → 只填缺失字段 + field_sources 溯源 →
三级去重只标记 → enriched/unmatched/failures 报告。网络提供方以参数注入，测试离线。
"""
from __future__ import annotations

import hashlib
import json
import re
import urllib.request
import xml.etree.ElementTree as ElementTree
from datetime import datetime, timezone
from pathlib import Path

from .external import STAGED_DIRECTORY

MAX_ENRICH_PER_RUN = 200
ARXIV_DELAY_SECONDS = 3
CROSSREF_DELAY_SECONDS = 1
TITLE_OVERLAP_THRESHOLD = 0.6
TIMEOUT_SECONDS = 30
MAX_ABSTRACT = 2000
ARXIV_STEM = re.compile(r"(\d{4}\.\d{4,5})(?:v\d+)?$", re.I)
DOI_TEXT = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+")
ARXIV_TEXT = re.compile(r"arXiv:(\d{4}\.\d{4,5}(?:v\d+)?)")
MAILTO = "qtec@outlook.com"

ACTION = "external_enrich"


def _now():
    return datetime.now(timezone.utc).isoformat()


def normalize_doi(value):
    value = (value or "").strip().lower()
    return value[4:] if value.startswith("https://doi.org/") else value


def normalized_title(value):
    return re.sub(r"\s+", " ", (value or "")).strip().lower()


def title_overlap(a, b):
    words_a = set(normalized_title(a).split(" ")) - {""}
    words_b = set(normalized_title(b).split(" ")) - {""}
    if not words_a:
        return 0.0
    return len(words_a & words_b) / len(words_a)


def first_page_candidates(pdf_path, max_pages=2):
    """首页文本里的 DOI / arXiv 证据；打不开或无文本时如实返回空。"""
    try:
        import pymupdf as fitz
    except ImportError:  # PyMuPDF 未安装时本证据不可用，如实降级
        return []
    out = []
    try:
        doc = fitz.open(pdf_path)
        for number in range(min(max_pages, doc.page_count)):
            text = doc[number].get_text()[:3000]
            match = ARXIV_TEXT.search(text) or re.search(r"\b(\d{4}\.\d{4,5}(?:v\d+)?)\b", text)
            if match:
                value = match.group(1) if match.lastindex else match.group(0).lstrip("arXiv:")
                out.append({"kind": "arxiv", "value": value})
                break
            doi = DOI_TEXT.search(text)
            if doi:
                out.append({"kind": "doi", "value": doi.group(0).rstrip(".,)")})
                break
        doc.close()
    except Exception:
        return []
    return out


class ArxivProvider:
    """arXiv API；3 秒限速。tests 注入 fetch 覆盖网络。"""

    delay = ARXIV_DELAY_SECONDS

    def __init__(self, opener=None):
        self._opener = opener or self._http

    @staticmethod
    def _http(url):
        request = urllib.request.Request(url, headers={"User-Agent": "dsh-paper-library bulk-enrich (mailto:%s)" % MAILTO})
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8", "replace")

    def fetch(self, arxiv_id):
        import time
        time.sleep(self.delay)
        xml = self._opener("http://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(arxiv_id))
        root = ElementTree.fromstring(xml)
        entry = next((node for node in root if node.tag.endswith("entry")), None)
        if entry is None:
            return None
        def text(tag):
            node = entry.find("{http://www.w3.org/2005/Atom}" + tag)
            return re.sub(r"\s+", " ", node.text or "").strip() if node is not None else ""
        title = text("title")
        if not title or title.lower().startswith("error"):
            return None
        creators = []
        for author in [n for n in entry if n.tag.endswith("author")]:
            name_node = author.find("{http://www.w3.org/2005/Atom}name")
            if name_node is None:
                continue
            parts = (name_node.text or "").strip().split()
            family = parts.pop() if parts else ""
            entry_creator = {"firstName": " ".join(parts), "family": family, "creatorType": "author"}
            if not entry_creator["family"]:
                entry_creator = {"family": name_node.text or "", "creatorType": "author"}
            creators.append(entry_creator)
        published = entry.find("{http://www.w3.org/2005/Atom}published")
        return {
            "itemType": "preprint",
            "title": title,
            "creators": creators,
            "date": (published.text or "")[:10] if published is not None else "",
            "url": "https://arxiv.org/abs/" + arxiv_id,
            "archiveID": "arXiv:" + arxiv_id,
        }


class CrossrefProvider:
    """CrossRef works / bibliographic 检索；polite pool（mailto）。"""

    delay = CROSSREF_DELAY_SECONDS

    def __init__(self, opener=None, mailto=MAILTO):
        self._opener = opener or self._http
        self._mailto = mailto

    @staticmethod
    def _http(url):
        request = urllib.request.Request(url, headers={"User-Agent": "dsh-paper-library bulk-enrich (mailto:%s)" % MAILTO})
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8", "replace")

    def fetch(self, doi):
        import json as json_module
        import time
        time.sleep(self.delay)
        payload = json_module.loads(self._opener("https://api.crossref.org/works/" + urllib.parse.quote(normalize_doi(doi))))
        return self._convert(payload.get("message", {}))

    def search_by_title(self, title):
        import json as json_module
        import time
        time.sleep(self.delay)
        url = ("https://api.crossref.org/works?query.bibliographic=" + urllib.parse.quote(title)
               + "&rows=1&mailto=" + self._mailto)
        payload = json_module.loads(self._opener(url))
        items = payload.get("message", {}).get("items", [])
        if not items:
            return None
        candidate = self._convert(items[0])
        if title_overlap(title, candidate.get("title")) < TITLE_OVERLAP_THRESHOLD:
            return None
        return candidate

    @staticmethod
    def _convert(message):
        creators = []
        for author in message.get("author", []):
            creators.append({
                "firstName": author.get("given", ""),
                "family": author.get("family", author.get("name", "")),
                "creatorType": "author",
            })
        date_parts = (message.get("issued", {}).get("date-parts") or [[None]])
        year = date_parts[0][0] if date_parts and date_parts[0] else ""
        return {
            "itemType": "journalArticle",
            "title": re.sub(r"\s+", " ", (message.get("title") or [""])[0]).strip(),
            "creators": creators,
            "date": str(year),
            "DOI": message.get("DOI", ""),
            "url": message.get("URL", ""),
            "publicationTitle": (message.get("container-title") or [""])[0] if message.get("container-title") else "",
            "volume": message.get("volume", ""), "issue": message.get("issue", ""), "pages": message.get("page", ""),
        }


import urllib.parse  # noqa: E402  (providers 之上仅类型引用)


def default_fetchers():
    arxiv, crossref = ArxivProvider(), CrossrefProvider()
    return {
        "arxiv": arxiv.fetch,
        "crossref_doi": crossref.fetch,
        "crossref_title": crossref.search_by_title,
    }


def arxiv_id_from_filename(stem):
    match = ARXIV_STEM.search(str(stem))
    return match.group(1) if match else None


def select_entries(library, source_id, limit):
    """external_scan 建立且尚未富化的条目（title 证据仍为 synced-filename），有界。"""
    staged_prefix = f"{STAGED_DIRECTORY}/{source_id}/"
    rows = library.db.execute(
        "SELECT id, metadata, pdf_path FROM papers WHERE pdf_path LIKE ? ORDER BY pdf_path",
        (staged_prefix + "%",),
    ).fetchall()
    out = []
    for row in rows:
        if len(out) >= limit:
            break
        value = json.loads(row["metadata"])
        parse = value.get("parse") or {}
        sources = parse.get("field_sources") or {}
        if sources.get("title") != "synced-filename":
            continue
        if value.get("DOI"):
            continue
        relative = row["pdf_path"][len(staged_prefix):]
        out.append({"id": row["id"], "metadata": value, "relative": relative,
                    "pdf": str(Path(library.root) / row["pdf_path"])})
    return out


def enrich_source(library, source, fetchers, limit=MAX_ENRICH_PER_RUN, apply=True):
    """主流程：选择 → 证据 → 提供方 → 三级去重 → 只填缺失 → 报告。返回统计。"""
    stamp = _now().replace(":", "").replace("-", "")
    out_dir = Path(library.root) / "exports" / "bulk-enrich" / stamp[:12]
    if apply:
        out_dir.mkdir(parents=True, exist_ok=True)
    entries = select_entries(library, source["id"], limit)
    enriched, unmatched, failures, duplicates = [], [], [], []
    for entry in entries:
        pdf_path = Path(entry["pdf"])
        stem = pdf_path.stem
        candidates = []
        arxiv_id = arxiv_id_from_filename(stem)
        if arxiv_id:
            candidates.append({"kind": "arxiv", "value": arxiv_id})
        candidates.extend(first_page_candidates(str(pdf_path)))
        meta, how = None, ""
        try:
            for candidate in candidates:
                if candidate["kind"] == "arxiv":
                    meta = fetchers["arxiv"](candidate["value"])
                else:
                    meta = fetchers["crossref_doi"](candidate["value"])
                if meta and meta.get("title"):
                    how = candidate["kind"] + ":" + candidate["value"]
                    break
            if meta is None:
                meta = fetchers["crossref_title"](entry["metadata"].get("title", ""))
                if meta and meta.get("title"):
                    how = "crossref-title"
            if not meta or not meta.get("title"):
                unmatched.append((cur(entry), stem, ""))
                continue
            if meta.get("DOI") and normalize_doi(meta["DOI"]) in {
                normalize_doi(x) for x in [e["metadata"].get("DOI") for e in entries if e["metadata"].get("DOI")]
            }:
                duplicates.append((cur(entry), "doi", meta["DOI"]))
        except Exception as error:
            failures.append((cur(entry), str(error)))
            continue
        enriched.append((cur(entry), how, meta.get("title")))
        if apply:
            _apply_fields(library, entry["id"], meta, how)
    _write_reports(out_dir, enriched, unmatched, failures, duplicates, apply)
    return {
        "source": source["id"], "selected": len(entries), "enriched": len(enriched),
        "unmatched": len(unmatched), "failures": len(failures), "duplicates": len(duplicates),
        "applied": bool(apply), "report_dir": str(out_dir) if apply else "",
    }


def cur(entry):
    return entry["id"] + " " + entry["relative"]


def _apply_fields(library, paper_id, meta, how):
    """只填缺失字段 + field_sources 溯源；永不覆盖已有值（对齐 external._update）。"""
    with library.lock():
        row = library.db.execute("SELECT metadata FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            return
        value = json.loads(row["metadata"])
        mapping = {"title": "title", "author": "creators", "issued": "date",
                   "DOI": "DOI", "url": "url", "publicationTitle": "publicationTitle"}
        sources = dict((value.get("parse") or {}).get("field_sources") or {})
        source_tag = "arxiv-api" if how.startswith("arxiv") else "crossref-api"
        if "title" in value and value["title"] and sources.get("title") not in (None, "synced-filename"):
            meta.pop("title", None)
        for catalog_key, meta_key in mapping.items():
            incoming = meta.get(meta_key)
            if not incoming:
                continue
            if catalog_key == "issued":
                incoming = {"date-parts": [[str(incoming)]]}
            if catalog_key == "creators":
                incoming = [c for c in incoming if c.get("family") or c.get("firstName")]
            if not incoming:
                continue
            current = value.get(catalog_key)
            # 文件名派生的 title 允许被 API 标题升级；其余字段只填缺失、永不覆盖
            if current and not (catalog_key == "title" and sources.get("title") == "synced-filename"):
                continue
            value[catalog_key] = incoming
            sources[catalog_key] = source_tag
        if meta.get("DOI") and not value.get("DOI"):
            value["DOI"] = meta["DOI"]
            sources["DOI"] = source_tag
        parse = dict(value.get("parse") or {})
        parse["field_sources"] = sources
        parse["enriched"] = {"at": _now(), "via": how}
        value["parse"] = parse
        library.db.execute("UPDATE papers SET metadata=?,title=?,modified=? WHERE id=?",
                           (json.dumps(value, ensure_ascii=False), value.get("title") or "", _now(), paper_id))


def _write_reports(out_dir, enriched, unmatched, failures, duplicates, apply):
    if not apply:
        return
    for name, rows in (("enriched.tsv", enriched), ("unmatched.tsv", unmatched),
                       ("failures.tsv", failures), ("duplicates.tsv", duplicates)):
        with open(out_dir / name, "w") as handle:
            handle.write("\n".join("\t".join(row) for row in rows) + "\n")


def dispatch(library, request):
    source_id = request.get("source_id")
    if not source_id:
        raise ValueError("source_id is required")
    source = {"id": source_id, "root": "", "label": source_id}
    for row in library.db.execute("SELECT DISTINCT source, root FROM external_files WHERE source=?", (source_id,)):
        source["root"] = row["root"]
    if not source["root"]:
        raise ValueError("unknown external source: %s" % source_id)
    limit = int(request.get("limit") or MAX_ENRICH_PER_RUN)
    apply = bool(request.get("apply", False))
    return enrich_source(library, source, default_fetchers(), limit=limit, apply=apply)
