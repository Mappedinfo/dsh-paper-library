"""On-demand search projection of starred and PDF-tagged annotations."""
from contextlib import closing, contextmanager
from itertools import islice
from time import monotonic
import hashlib
import json
import os
import sqlite3
import unicodedata

from .annotation_tags import read_tags
from .catalog_search import _version
from .core import MAX_ANNOTATIONS, bounded_text
from .projects import _identifier, _project
from .paper_retrieval import integer

PAGE_SIZE, FILE_LIMIT, PAGE_LIMIT = 24, 24, 240
SCHEMA = """
CREATE TABLE IF NOT EXISTS documents(
  paper_id TEXT PRIMARY KEY, version TEXT NOT NULL, next_page INTEGER NOT NULL,
  page_count INTEGER NOT NULL, incomplete INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes(
  paper_id TEXT NOT NULL, annotation_id TEXT NOT NULL, page INTEGER NOT NULL,
  text TEXT NOT NULL, comment TEXT NOT NULL, tags TEXT NOT NULL,
  favorite INTEGER NOT NULL, stamp TEXT NOT NULL, available INTEGER NOT NULL,
  PRIMARY KEY(paper_id,annotation_id)
);
"""


def _fold(value):
    return " ".join(unicodedata.normalize("NFKC", value or "").replace("\u00ad", "").casefold().split())


def _tag(value):
    return _fold(value).lstrip("#").strip()


def _digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


@contextmanager
def _open_index(library, request):
    paper_id, project_id = request.get("paper_id"), request.get("project_id")
    if paper_id is not None and project_id is not None:
        raise ValueError("请选择一个笔记检索范围。")
    where = ["p.pdf_path IS NOT NULL", "NOT EXISTS(SELECT 1 FROM paper_archive a WHERE a.paper_id=p.id)"]
    args = []
    if paper_id is not None:
        where.append("p.id=?")
        args.append(bounded_text(paper_id, "文献标识", 160, required=True))
    if project_id is not None:
        project_id = _identifier(project_id, "项目标识")
        _project(library, project_id)
        where.append("EXISTS(SELECT 1 FROM project_papers m WHERE m.paper_id=p.id AND m.project_id=?)")
        args.append(project_id)
    scope_clause = " FROM papers p WHERE " + " AND ".join(where)
    papers = library.db.execute("SELECT p.id,p.title,p.pdf_path" + scope_clause, args).fetchall()
    favorites = {}
    for row in library.db.execute(
        "SELECT f.paper_id,f.annotation_id,f.page,f.saved FROM annotation_favorites f "
        "WHERE f.paper_id IN (SELECT p.id" + scope_clause + ") ORDER BY f.paper_id,f.annotation_id", args,
    ):
        favorites.setdefault(row["paper_id"], {})[row["annotation_id"]] = (row["page"], row["saved"])
    path = library.root / "annotation-notes-v1.sqlite3"
    with closing(sqlite3.connect(path, timeout=5)) as index:
        os.chmod(path, 0o600)
        index.row_factory = sqlite3.Row
        index.create_function("fold", 1, _fold, deterministic=True)
        index.execute("PRAGMA journal_mode=WAL")
        index.executescript(SCHEMA)
        index.execute("CREATE TEMP TABLE scope(paper_id TEXT PRIMARY KEY,title TEXT,stored TEXT,pdf_version TEXT,version TEXT,star_count INTEGER)")
        rows = []
        for paper in papers:
            stored = paper["pdf_path"]
            version = _version(library.root / stored, stored)
            saved = favorites.get(paper["id"], {})
            rows.append((paper["id"], paper["title"][:500], stored, version, _digest([version, saved]), len(saved)))
        index.executemany("INSERT INTO scope VALUES (?,?,?,?,?,?)", rows)
        index.commit()
        yield index, favorites


def _coverage(index):
    total, done, incomplete = index.execute(
        """SELECT COUNT(*), COALESCE(SUM(d.next_page>d.page_count),0), COALESCE(SUM(d.incomplete>0),0)
           FROM scope s LEFT JOIN documents d ON d.paper_id=s.paper_id AND d.version=s.version"""
    ).fetchone()
    return {"documents": total, "indexed": done, "pending": total - done, "incomplete": incomplete}


def _date_key(value):
    return "".join(character for character in (value or "")[:64] if character.isascii() and character.isdigit())[:14]


def _slice_page(library, index, paper_id, page, favorites):
    annotations = list(islice(page.annots() or [], MAX_ANNOTATIONS + 1))
    number = page.number + 1
    handwriting = None
    incomplete = int(len(annotations) > MAX_ANNOTATIONS)
    for annotation in annotations[:MAX_ANNOTATIONS]:
        identity = annotation.info.get("id") or f"external-{number}-{annotation.xref}"
        if not isinstance(identity, str) or len(identity) > 160:
            continue
        saved = favorites.get(identity)
        tags = read_tags(page.parent, annotation.xref)
        if not saved and not tags:
            continue
        if handwriting is None:
            handwriting = library._handwriting_page(page)
        try:
            note = library._annotation(page, annotation, handwriting=handwriting)
        except (ValueError, RuntimeError, TypeError):
            incomplete += 1
            continue
        comment = note["comment"] or (note.get("handwriting") or {}).get("transcript") or (note.get("linked_ink") or {}).get("transcript") or ""
        stamp = max(_date_key(note["modified"] or note["created"]), _date_key(saved[1]) if saved else "")
        index.execute("INSERT OR REPLACE INTO notes VALUES (?,?,?,?,?,?,?,?,?)",
                      (paper_id, identity, number, note["text"][:20000], comment[:16000],
                       json.dumps(tags, ensure_ascii=False), int(bool(saved)), stamp, 1))
    return incomplete


def _scan(library, index, entry, favorites, budget, deadline):
    paper_id, version = entry["paper_id"], entry["version"]
    number, incomplete, attempted = entry["next_page"] or 1, entry["incomplete"] or 0, 0
    if number == 1:
        index.execute("DELETE FROM notes WHERE paper_id=?", (paper_id,))
        index.executemany("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?)", (
            (paper_id, annotation_id, page, "", "", "[]", 1, _date_key(saved), 0)
            for annotation_id, (page, saved) in favorites.items()
        ))
    try:
        path = library.pdf_path(paper_id)
        if _version(path, entry["stored"]) != entry["pdf_version"]:
            return None
        with library._open_pdf(path) as doc:
            count = doc.page_count
            while number <= count and attempted < budget and (attempted == 0 or monotonic() < deadline):
                try:
                    incomplete += _slice_page(library, index, paper_id, doc[number - 1], favorites)
                except (ValueError, RuntimeError, OSError):
                    incomplete += 1
                number += 1
                attempted += 1
        if _version(path, entry["stored"]) != entry["pdf_version"]:
            return None
    except (ValueError, RuntimeError, OSError):
        count, incomplete = number - 1, incomplete + 1
    index.execute("INSERT OR REPLACE INTO documents VALUES (?,?,?,?,?)",
                  (paper_id, version, number, count, incomplete))
    return attempted


def prepare(library, request):
    with _open_index(library, request) as (index, favorites):
        index.execute("BEGIN IMMEDIATE")
        if request.get("retry_incomplete") is True:
            index.execute("""DELETE FROM documents WHERE incomplete>0 AND next_page>page_count
                             AND paper_id IN (SELECT paper_id FROM scope)""")
        rows = index.execute(
            """SELECT s.*,d.next_page,d.incomplete FROM scope s
               LEFT JOIN documents d ON d.paper_id=s.paper_id AND d.version=s.version
               WHERE d.next_page IS NULL OR d.next_page<=d.page_count
               ORDER BY s.star_count DESC,s.paper_id LIMIT ?""", (FILE_LIMIT,)
        ).fetchall()
        budget, deadline, attempted = PAGE_LIMIT, monotonic() + 1.2, 0
        for entry in rows:
            index.execute("SAVEPOINT pdf")
            scanned = _scan(library, index, entry, favorites.get(entry["paper_id"], {}), budget, deadline)
            if scanned is None:
                index.execute("ROLLBACK TO pdf")
            else:
                attempted += 1
                budget -= scanned
            index.execute("RELEASE pdf")
            if not budget or monotonic() >= deadline:
                break
        index.commit()
        return {**_coverage(index), "progressed": bool(attempted)}


def listing(library, request):
    offset = integer(request, "offset", 0, 0, 1000000)
    category, field = request.get("category", "all"), request.get("field", "all")
    field_sql = {
        "all": "n.text || ' ' || n.comment || ' ' || s.title || ' ' || n.tags",
        "content": "n.text || ' ' || n.comment",
        "paper": "s.title",
        "tags": "n.tags",
    }
    category_sql = {"all": "1", "starred": "n.favorite=1", "tagged": "n.tags!='[]'", "both": "n.favorite=1 AND n.tags!='[]'"}
    if not isinstance(category, str) or not isinstance(field, str) or category not in category_sql or field not in field_sql:
        raise ValueError("笔记筛选条件无效。")
    query = _fold(bounded_text(request.get("query", ""), "笔记检索词", 200))
    tag = _tag(bounded_text(request.get("tag", ""), "批注标签", 60))
    with _open_index(library, request) as (index, _):
        base = """ FROM notes n JOIN scope s ON s.paper_id=n.paper_id
                   JOIN documents d ON d.paper_id=s.paper_id AND d.version=s.version
                   WHERE (n.available=1 OR d.next_page>d.page_count)"""
        base += " AND " + category_sql[category]
        args = []
        if query:
            base += f" AND instr(fold({field_sql[field]}),?)>0"
            args.append(query)
        facets = index.execute("SELECT min(j.value) tag,COUNT(*) total" +
                               base.replace(" WHERE ", ",json_each(n.tags) j WHERE ", 1) +
                               " GROUP BY fold(j.value) ORDER BY total DESC,tag LIMIT 80", args)
        tags = [dict(row) for row in facets]
        if tag:
            base += " AND EXISTS(SELECT 1 FROM json_each(n.tags) j WHERE fold(j.value)=?)"
            args.append(tag)
        total = index.execute("SELECT count(*)" + base, args).fetchone()[0]
        rows = index.execute(
            "SELECT n.paper_id,n.annotation_id,n.page,substr(n.text,1,800) text,substr(n.comment,1,800) comment,"
            "n.tags,n.favorite,n.available,s.title" + base +
            " ORDER BY n.stamp DESC,n.paper_id,n.page,n.annotation_id LIMIT ? OFFSET ?", [*args, PAGE_SIZE, offset]
        )
        items = [{**dict(row), "tags": json.loads(row["tags"]), "favorite": bool(row["favorite"]),
                  "unavailable": not row["available"]} for row in rows]
        return {"items": items, "tags": tags, "total": total, "offset": offset,
                "has_more": offset + len(items) < total, "coverage": _coverage(index)}
