"""Local bookmarks pointing to native PDF annotations."""

from .core import MAX_ANNOTATIONS, bounded_text, now

SCHEMA = """
CREATE TABLE IF NOT EXISTS annotation_favorites(
  paper_id TEXT NOT NULL, annotation_id TEXT NOT NULL, page INTEGER NOT NULL,
  saved TEXT NOT NULL, PRIMARY KEY(paper_id,annotation_id)
);
CREATE INDEX IF NOT EXISTS annotation_favorites_recent ON annotation_favorites(saved DESC,paper_id,annotation_id);
"""


def ids(library, paper_id):
    return [row[0] for row in library.db.execute(
        "SELECT annotation_id FROM annotation_favorites WHERE paper_id=? ORDER BY saved DESC LIMIT ?",
        (paper_id, MAX_ANNOTATIONS))]


def _read(library, paper_id, annotation_id, page_number):
    with library._open_pdf(library.pdf_path(paper_id)) as doc:
        page = library._page(doc, page_number)
        matches = []
        for index, annot in enumerate(page.annots() or []):
            if index >= MAX_ANNOTATIONS:
                raise ValueError("此页批注超过收藏核对上限")
            if annot.info.get("id") == annotation_id:
                matches.append(annot)
        if len(matches) != 1 or library._annotation_metadata(matches[0]).get("kind") == "ai-feedback":
            raise ValueError("此批注已不存在或标识不唯一")
        value = library._annotation(page, matches[0], exact=True)
        return {key: (value[key] or "")[:500] for key in ("text", "comment")}


def update(library, request):
    paper_id = bounded_text(request.get("id"), "文献标识", 160, required=True)
    annotation_id = bounded_text(request.get("annotation_id"), "批注标识", 160, required=True)
    favorite, page = request.get("favorite"), request.get("page")
    if type(favorite) is not bool or favorite and (type(page) is not int or not 1 <= page <= 2000):
        raise ValueError("需要有效的收藏状态和批注页码")
    with library.lock():
        if favorite:
            _read(library, paper_id, annotation_id, page)
            library.db.execute("INSERT OR IGNORE INTO annotation_favorites VALUES(?,?,?,?)",
                               (paper_id, annotation_id, page, now()))
        else:
            library.db.execute("DELETE FROM annotation_favorites WHERE paper_id=? AND annotation_id=?",
                               (paper_id, annotation_id))
    return {"favorite": favorite, "annotation_id": annotation_id}


def listing(library, request):
    offset = request.get("offset", 0)
    if type(offset) is not int or not 0 <= offset <= 1000000:
        raise ValueError("收藏分页超出范围")
    scope = """FROM annotation_favorites f JOIN papers p ON p.id=f.paper_id
        WHERE NOT EXISTS (SELECT 1 FROM paper_archive a WHERE a.paper_id=p.id)"""
    total = library.db.execute("SELECT count(*) " + scope).fetchone()[0]
    rows = library.db.execute("SELECT f.*,p.title " + scope +
                              " ORDER BY f.saved DESC,f.paper_id,f.annotation_id LIMIT 12 OFFSET ?", (offset,))
    items = []
    for row in rows:
        item = dict(row)
        try:
            item.update(_read(library, item["paper_id"], item["annotation_id"], item["page"]))
        except (ValueError, OSError, RuntimeError):
            item["unavailable"] = True
        items.append(item)
    return {"items": items, "offset": offset, "total": total, "has_more": offset + len(items) < total}
