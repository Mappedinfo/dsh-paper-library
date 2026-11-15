"""Bounded, local search across the text layer of catalog PDFs."""

import hashlib
import json
from time import monotonic

from .document_elements import _preflight_page
from .paper_analysis import file_version
from .paper_retrieval import integer, normalized, normalized_spacing
from .projects import _identifier, _project

FILE_LIMIT = 12
PAGE_LIMIT = 96
MAX_FILE_BYTES = 250 * 1024 * 1024
MAX_PAGE_CHARACTERS = 250_000


class CatalogSearchChanged(ValueError):
    code = "CATALOG_SEARCH_CHANGED"


def _encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def _position(cursor):
    if cursor is None:
        return 0, 1, None
    if isinstance(cursor, dict) and set(cursor) == {"scope", "index", "page", "version"}:
        index, page, version = cursor["index"], cursor["page"], cursor["version"]
        if (type(index) is int and index >= 0 and type(page) is int and 1 <= page <= 2000
                and ((page == 1 and version is None) or (page > 1 and isinstance(version, str) and len(version) == 64))):
            return index, page, version
    raise ValueError("全文搜索的续搜位置无效，请重新搜索。")


def _scope(library, project_id, needle, start):
    join, args = "", ()
    if project_id is not None:
        project_id = _identifier(project_id, "项目标识")
        _project(library, project_id)
        join = " JOIN project_papers ON project_papers.paper_id = papers.id AND project_papers.project_id = ?"
        args = (project_id,)
    rows = library.db.execute(
        "SELECT papers.id, substr(papers.title, 1, 240) AS title, papers.pdf_path"
        " FROM papers" + join +
        " WHERE NOT EXISTS (SELECT 1 FROM paper_archive WHERE paper_archive.paper_id = papers.id)"
        " ORDER BY papers.id", args,
    )
    fingerprint = hashlib.sha256(_encoded([str(library.root), project_id, needle]))
    pdf_count = without_pdf = 0
    batch = []
    for row in rows:
        fingerprint.update(_encoded([row["id"], row["pdf_path"]]))
        if not row["pdf_path"]:
            without_pdf += 1
            continue
        if start <= pdf_count < start + FILE_LIMIT:
            batch.append(row)
        pdf_count += 1
    return batch, pdf_count, without_pdf, fingerprint.hexdigest()


def _snippet(text, needle):
    original = normalized_spacing(text)
    folded = original.casefold()
    start = folded.find(needle)
    if start < 0:
        return None
    end = start + len(needle)
    if len(original) != len(folded):
        position = 0
        for index, char in enumerate(original):
            following = position + len(char.casefold())
            if position <= start < following:
                first = index
            if position < end <= following:
                start, end = first, index + 1
                break
            position = following
    left, right = max(0, start - 90), min(len(original), end + 140)
    return ("…" if left else "") + original[left:right] + ("…" if right < len(original) else "")


def search(library, request):
    query = request.get("query")
    needle = normalized(query) if isinstance(query, str) and len(query) <= 200 else ""
    if not needle or len(needle) > 400:
        raise ValueError("请输入 1–200 个字符的全文搜索词。")
    limit = integer(request, "limit", 40, 1, 40)
    cursor = request.get("cursor")
    index, page, version = _position(cursor)
    rows, total, missing, scope = _scope(library, request.get("project_id"), needle, index)
    if cursor is not None and (cursor["scope"] != scope or index >= total):
        raise CatalogSearchChanged("搜索范围或关键词已变化，请重新搜索。")

    matches = []
    scanned = empty = skipped = unreadable = 0
    deadline = monotonic() + 1.5
    for row in rows:
        try:
            path = library.pdf_path(row["id"])
            before = file_version(path)
            current = hashlib.sha256(_encoded(before)).hexdigest()
            if version is not None and version != current:
                raise CatalogSearchChanged("续搜的 PDF 已变化，请重新搜索以核对页码。")
            if before["bytes"] > MAX_FILE_BYTES:
                raise ValueError("PDF exceeds the search file budget")
            with library._open_pdf(path) as doc:
                if page > doc.page_count:
                    raise ValueError("Search page is unavailable")
                while page <= doc.page_count:
                    try:
                        _preflight_page(doc, page)
                        text = doc[page - 1].get_text("text", sort=True)
                        if len(text) > MAX_PAGE_CHARACTERS:
                            raise ValueError("Page exceeds the search text budget")
                    except (RuntimeError, ValueError):
                        skipped += 1
                    else:
                        scanned += 1
                        if text.strip():
                            snippet = _snippet(text, needle)
                            if snippet is not None:
                                matches.append({"paper_id": row["id"], "title": row["title"], "page": page, "snippet": snippet})
                        else:
                            empty += 1
                    page += 1
                    if scanned + skipped >= PAGE_LIMIT or len(matches) >= limit or monotonic() >= deadline:
                        break
                finished = page > doc.page_count
            if file_version(path) != before:
                raise CatalogSearchChanged("搜索时 PDF 已变化，请重新搜索以核对页码。")
        except CatalogSearchChanged:
            raise
        except (OSError, RuntimeError, ValueError):
            if version is not None or page != 1:
                raise CatalogSearchChanged("搜索时 PDF 已不可读，请重新搜索。") from None
            unreadable += 1
            finished = True
        if not finished:
            version = current
            break
        index, page, version = index + 1, 1, None
        if scanned + skipped >= PAGE_LIMIT or len(matches) >= limit or monotonic() >= deadline:
            break

    return {
        "matches": matches, "scanned_pages": scanned, "no_text_pages": empty, "skipped_pages": skipped,
        "unreadable_pdfs": unreadable, "pdf_count": total, "without_pdf": missing, "pdfs_completed": index,
        "next_cursor": {"scope": scope, "index": index, "page": page, "version": version} if index < total else None,
    }
