"""Use the same citation snapshot for catalog ordering and row display."""

import json
import re
from urllib.parse import unquote, urlsplit

DOI = re.compile(r"10\.[0-9]{4,9}/[^\s?#]+", re.I)
DOI_URL = re.compile(r"https?://(?:dx\.)?doi\.org/", re.I)
ARXIV_ID = r"(?:[0-9]{2}(?:0[1-9]|1[0-2])\.[0-9]{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?/[0-9]{2}(?:0[1-9]|1[0-2])[0-9]{3})"
ARXIV = re.compile(rf"({ARXIV_ID})(?:v[1-9][0-9]*)?")
ARXIV_URL = re.compile(r"^(?:https?://)?(?:www\.|export\.)?arxiv\.org(/[^?#]*)(?:[?#].*)?$", re.I)
MAX_COUNT = (1 << 53) - 1


def _doi(value):
    value = re.sub(r"^doi:\s*", "", value.strip(), flags=re.I) if isinstance(value, str) else ""
    if DOI_URL.match(value):
        try:
            value = unquote(urlsplit(value).path[1:], errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None
    return value.lower() if len(value) <= 512 and DOI.fullmatch(value) else None


def _arxiv(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if re.match(r"^arxiv:", value, re.I):
        value = re.sub(r"^arxiv:\s*", "", value, flags=re.I)
    elif link := ARXIV_URL.fullmatch(value):
        if re.search(r"[\s\\\x00-\x1f\x7f]", value):
            return None
        path = re.fullmatch(r"/(?:abs|pdf|html)/(.+?)(?:\.pdf)?/?", link[1])
        value = path[1] if path else ""
    match = ARXIV.fullmatch(value)
    return "10.48550/arxiv." + match[1].lower() if match else None


def _identifier(item):
    return (_doi(item.get("DOI"))
            or (_arxiv(item.get("archive_location")) if str(item.get("archive", "")).lower() == "arxiv" else None)
            or _arxiv(item.get("URL")))


def _count(value):
    return int(value) if type(value) in (int, float) and 0 <= value <= MAX_COUNT and value % 1 == 0 else None


def _saved(item):
    for source, field, name in (
        ("OpenAlex", "openalex", "cited_by_count"),
        ("Crossref", "crossref", "is-referenced-by-count"),
        ("Semantic Scholar", "semantic_scholar", "citationCount"),
    ):
        record = item.get(field)
        record = record if isinstance(record, dict) else {}
        count = record.get(name)
        if count is None and field == "crossref":
            count = item.get(name)
        count = _count(count)
        if count is not None:
            date = record.get("fetched_at") or record.get("as_of")
            return {"status": "found", "source": source, "count": count,
                    "fetched_at": date if isinstance(date, str) else None}
    return None


def project(item, cache):
    doi = _identifier(item)
    stored = cache.get(doi)
    cached = stored.get("value") if isinstance(stored, dict) else None
    cached = cached if isinstance(cached, dict) else None
    snapshot = (cached if cached and cached.get("status") == "found" and _count(cached.get("count")) is not None
                else _saved(item) or cached)
    output = {}
    if doi:
        output.update(citation_lookup_doi=doi, citation_needs_lookup=not (cached and stored.get("fresh") is True))
    if snapshot:
        output["citation_snapshot"] = snapshot
    return output


def sort_count(metadata, cache):
    snapshot = project(json.loads(metadata), cache).get("citation_snapshot")
    return _count(snapshot.get("count")) if snapshot and snapshot.get("status") == "found" else None
