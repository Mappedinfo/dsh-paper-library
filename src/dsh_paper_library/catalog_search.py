"""Persistent, local index of the searchable text on catalog PDF pages."""

from contextlib import closing, contextmanager
import hashlib
import json
import os
import re
import sqlite3
from time import monotonic
import unicodedata

from .document_elements import _ensure_disk, _preflight_page
from .paper_analysis import file_version
from .paper_retrieval import integer
from .projects import _identifier, _project

FILE_LIMIT = 12
PAGE_LIMIT = 96
MAX_FILE_BYTES = 250 * 1024 * 1024
MAX_PAGE_CHARACTERS = 250_000
INDEX_NAME = "pdf-text-index-v1.sqlite3"
DASHES = str.maketrans("‐‑‒–—", "-----")
INNER_DASH = re.compile(r"(?<=\w)-(?=\w)")
SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    paper_id TEXT PRIMARY KEY, version TEXT NOT NULL,
    next_page INTEGER NOT NULL, pages INTEGER NOT NULL,
    empty INTEGER NOT NULL, skipped INTEGER NOT NULL, unreadable INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY, paper_id TEXT NOT NULL, page INTEGER NOT NULL,
    display TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(paper_id, page)
);
CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
    body, content='pages', content_rowid='id', tokenize='trigram case_sensitive 1'
);
CREATE TRIGGER IF NOT EXISTS index_page AFTER INSERT ON pages BEGIN
    INSERT INTO page_search(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS unindex_page AFTER DELETE ON pages BEGIN
    INSERT INTO page_search(page_search, rowid, body) VALUES ('delete', old.id, old.body);
END;
"""


class CatalogSearchChanged(ValueError):
    code = "CATALOG_SEARCH_CHANGED"


def _encode(value):
    return json.dumps(value, separators=(",", ":")).encode()


def _display(text):
    text = unicodedata.normalize("NFKC", text).translate(DASHES)
    text = re.sub(r"\u00ad[ \t]*\r?\n[ \t]*", "", text).replace("\u00ad", "")
    text = re.sub(r"(?<=\w)-[ \t]*\r?\n\s*(?=\w)", "-", text)
    return " ".join(text.replace("\x00", " ").split())


def _key(display):
    return INNER_DASH.sub("", display).casefold()


def _snippet(display, needle):
    folded = _key(display)
    start = folded.find(needle)
    if start < 0:
        return display[:230]
    end = start + len(needle)
    if len(display) == len(folded) and not INNER_DASH.search(display):
        left, right = max(0, start - 90), min(len(display), end + 140)
        return ("…" if left else "") + display[left:right] + ("…" if right < len(display) else "")
    dropped = {match.start() for match in INNER_DASH.finditer(display)}
    position = 0
    for index, character in enumerate(display):
        following = position + (0 if index in dropped else len(character.casefold()))
        if position <= start < following:
            first = index
        if position < end <= following:
            left, right = max(0, first - 90), min(len(display), index + 141)
            return ("…" if left else "") + display[left:right] + ("…" if right < len(display) else "")
        position = following
    return display[:230]


def _version(path, stored):
    try:
        version = file_version(path)
    except OSError:
        return "missing"
    return hashlib.sha256(_encode([stored, version])).hexdigest()


@contextmanager
def _index(library, project_id):
    args, join = (), ""
    if project_id is not None:
        project_id = _identifier(project_id, "项目标识")
        _project(library, project_id)
        args = (project_id,)
        join = " JOIN project_papers pp ON pp.paper_id=papers.id AND pp.project_id=?"
    rows = library.db.execute(
        "SELECT papers.id, substr(papers.title,1,240) AS title, papers.pdf_path"
        " FROM papers" + join +
        " WHERE NOT EXISTS (SELECT 1 FROM paper_archive a WHERE a.paper_id=papers.id)"
        " ORDER BY papers.id", args,
    )
    path = library.root / INDEX_NAME
    with closing(sqlite3.connect(path, timeout=10)) as index:
        os.chmod(path, 0o600)
        index.row_factory = sqlite3.Row
        index.execute("PRAGMA journal_mode=WAL")
        index.executescript(SCHEMA)
        index.execute("CREATE TEMP TABLE scope(paper_id TEXT PRIMARY KEY,title TEXT,stored TEXT,version TEXT)")
        missing = 0
        for row in rows:
            stored = row["pdf_path"]
            if not stored:
                missing += 1
                continue
            index.execute("INSERT INTO scope VALUES(?,?,?,?)",
                          (row["id"], row["title"], stored, _version(library.root / stored, stored)))
        index.commit()
        yield index, missing


def _coverage(index, missing):
    rows = index.execute(
        """SELECT s.paper_id,s.version,d.next_page,d.pages,d.empty,d.skipped,d.unreadable
           FROM scope s LEFT JOIN documents d ON d.paper_id=s.paper_id AND d.version=s.version
           ORDER BY s.paper_id"""
    )
    pdfs = completed = pages = empty = skipped = unreadable = 0
    generation = hashlib.sha256()
    for row in rows:
        generation.update(_encode(tuple(row)))
        pdfs += 1
        if row["next_page"] is None:
            continue
        completed += row["next_page"] > row["pages"]
        pages += row["next_page"] - 1 - row["skipped"] - row["empty"]
        empty += row["empty"]
        skipped += row["skipped"]
        unreadable += row["unreadable"]
    return {
        "pdf_count": pdfs, "pdfs_completed": completed, "pdfs_pending": pdfs - completed,
        "indexed_pages": pages, "no_text_pages": empty, "skipped_pages": skipped,
        "unreadable_pdfs": unreadable, "without_pdf": missing,
    }, generation.hexdigest()


def _index_pdf(library, index, row, budget, deadline):
    paper_id, version = row["paper_id"], row["version"]
    page = row["next_page"] or 1
    if page == 1:
        index.execute("DELETE FROM pages WHERE paper_id=?", (paper_id,))
    empty, skipped, unreadable, pages, attempted = row["empty"] or 0, row["skipped"] or 0, 0, 0, 0
    try:
        path = library.pdf_path(paper_id)
        if _version(path, row["stored"]) != version:
            raise CatalogSearchChanged("PDF 已变化，请继续准备索引以重新读取。")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("PDF exceeds the search file budget")
        with library._open_pdf(path) as doc:
            pages = doc.page_count
            while page <= pages:
                try:
                    _preflight_page(doc, page, text_only=True)
                    text = doc[page - 1].get_text("text", sort=True)
                    if len(text) > MAX_PAGE_CHARACTERS:
                        raise ValueError("Page exceeds the search text budget")
                except (RuntimeError, ValueError):
                    skipped += 1
                else:
                    display = _display(text)
                    if display:
                        index.execute("INSERT INTO pages(paper_id,page,display,body) VALUES(?,?,?,?)",
                                      (paper_id, page, display, _key(display)))
                    else:
                        empty += 1
                page += 1
                attempted += 1
                if attempted >= budget or monotonic() >= deadline:
                    break
        if _version(path, row["stored"]) != version:
            raise CatalogSearchChanged("PDF 已变化，请继续准备索引以重新读取。")
    except CatalogSearchChanged:
        raise
    except (OSError, RuntimeError, ValueError):
        # Keep the indexed prefix when the remaining pages cannot be opened.
        pages, unreadable = page - 1, 1
    index.execute("INSERT OR REPLACE INTO documents VALUES(?,?,?,?,?,?,?)",
                  (paper_id, version, page, pages, empty, skipped, unreadable))
    return attempted


def prepare(library, request):
    _ensure_disk(library, PAGE_LIMIT * MAX_PAGE_CHARACTERS * 12)
    with _index(library, request.get("project_id")) as (index, missing):
        index.execute("BEGIN IMMEDIATE")
        pending = index.execute(
            """SELECT s.*,d.next_page,d.empty,d.skipped
               FROM scope s LEFT JOIN documents d ON d.paper_id=s.paper_id AND d.version=s.version
               WHERE d.next_page IS NULL OR d.next_page<=d.pages
               ORDER BY s.paper_id LIMIT ?""", (FILE_LIMIT,)
        ).fetchall()
        budget, deadline = PAGE_LIMIT, monotonic() + 1.5
        progressed = False
        for row in pending:
            # A replacement between the scope read and extraction invalidates only this PDF.
            index.execute("SAVEPOINT pdf")
            try:
                budget -= _index_pdf(library, index, row, budget, deadline)
                progressed = True
            except CatalogSearchChanged:
                index.execute("ROLLBACK TO pdf")
            finally:
                index.execute("RELEASE pdf")
            if budget <= 0 or monotonic() >= deadline:
                break
        if pending and not progressed:
            raise CatalogSearchChanged("待索引的 PDF 正在变化，请稍后继续准备索引。")
        index.commit()
        coverage, _ = _coverage(index, missing)
        return coverage


def search(library, request):
    query = request.get("query")
    needle = _key(_display(query)) if isinstance(query, str) and len(query) <= 200 else ""
    if not needle or len(needle) > 400:
        raise ValueError("请输入 1–200 个字符的全文搜索词。")
    limit = integer(request, "limit", 40, 1, 40)
    cursor = request.get("cursor")
    with _index(library, request.get("project_id")) as (index, missing):
        index.execute("BEGIN")
        coverage, generation = _coverage(index, missing)
        scope = hashlib.sha256(_encode([str(library.root), request.get("project_id"), needle, generation])).hexdigest()
        offset = 0
        if cursor is not None:
            if (not isinstance(cursor, dict) or set(cursor) != {"scope", "offset"}
                    or type(cursor["offset"]) is not int or not 1 <= cursor["offset"] <= 10_000_000):
                raise ValueError("全文搜索的分页位置无效，请重新搜索。")
            if cursor["scope"] != scope:
                raise CatalogSearchChanged("搜索范围、关键词或索引已更新，请重新搜索。")
            offset = cursor["offset"]
        from_clause = "pages p"
        constraint, value = "instr(p.body, ?) > 0", needle
        if len(needle) >= 3:
            from_clause = "page_search JOIN pages p ON p.id=page_search.rowid"
            constraint, value = "page_search MATCH ?", '"' + needle.replace('"', '""') + '"'
        rows = index.execute(
            f"""SELECT p.paper_id,p.page,p.display,s.title FROM {from_clause}
                JOIN scope s ON s.paper_id=p.paper_id
                JOIN documents d ON d.paper_id=p.paper_id AND d.version=s.version
                WHERE {constraint}
                ORDER BY p.page,p.paper_id LIMIT ? OFFSET ?""", (value, limit + 1, offset)
        ).fetchall()
        return {**coverage, "matches": [
            {"paper_id": row["paper_id"], "page": row["page"], "title": row["title"],
             "snippet": _snippet(row["display"], needle)} for row in rows[:limit]
        ], "next_cursor": {"scope": scope, "offset": offset + limit} if len(rows) > limit else None}
