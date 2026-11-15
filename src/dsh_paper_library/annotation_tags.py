"""Manual labels on native PDF annotations and the local suggestion history."""
import json
import re
import unicodedata

MAX_TAGS = 32
MAX_TAG_LENGTH = 60
PDF_KEY = "PLAnnotationTags"
SCHEMA = """
CREATE TABLE IF NOT EXISTS annotation_tag_history(
    tag_key TEXT PRIMARY KEY, tag TEXT NOT NULL, used TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS annotation_tag_history_recent ON annotation_tag_history(used DESC, tag_key);
"""


class AnnotationTagsConflict(ValueError):
    code = "STATE_CONFLICT"

    def __init__(self, tags):
        super().__init__("此批注的标签已在另一窗口更新。")
        self.current = {"tags": tags}


def _normalize(value):
    if not isinstance(value, str) or len(value) > MAX_TAG_LENGTH or re.search(r"[\x00-\x1f\x7f]", value):
        raise ValueError(f"标签须为不超过 {MAX_TAG_LENGTH} 个字符的单行文字。")
    clean = " ".join(unicodedata.normalize("NFKC", value).split()).lstrip("#").strip()
    if len(clean) > MAX_TAG_LENGTH:
        raise ValueError(f"标签须为不超过 {MAX_TAG_LENGTH} 个字符的单行文字。")
    return clean


def _tags(values):
    if not isinstance(values, list) or len(values) > MAX_TAGS:
        raise ValueError(f"一条批注最多可添加 {MAX_TAGS} 个标签。")
    result = {}
    for value in values:
        tag = _normalize(value)
        if not tag:
            raise ValueError("标签不能为空。")
        result.setdefault(tag.casefold(), tag)
    return list(result.values())


def read_tags(doc, xref):
    kind, value = doc.xref_get_key(xref, PDF_KEY)
    if kind != "string" or len(value) > 4096:
        return []
    try:
        return _tags(json.loads(value))
    except (ValueError, RecursionError):
        return []


def suggestions(library, request):
    query = _normalize(request.get("query", "")).casefold()
    rows = library.db.execute(
        """SELECT tag FROM annotation_tag_history
           WHERE instr(tag_key, ?) > 0
           ORDER BY (instr(tag_key, ?) = 1) DESC, used DESC, tag_key
           LIMIT 12""",
        (query, query),
    )
    return {"tags": [row["tag"] for row in rows]}


def update(library, request):
    import pymupdf as fitz
    from .core import MAX_ANNOTATIONS, bounded_text, now

    paper_id = bounded_text(request.get("id"), "文献标识", 160, required=True)
    annotation_id = bounded_text(request.get("annotation_id"), "批注标识", 160, required=True)
    page_number = request.get("page")
    if type(page_number) is not int or not 1 <= page_number <= 2000:
        raise ValueError("请提供有效的批注页码。")
    tags = _tags(request.get("tags"))
    expected = _tags(request.get("expected_tags"))

    def checked(doc):
        page = library._page(doc, page_number)
        matches = []
        for index, annot in enumerate(page.annots() or []):
            if index >= MAX_ANNOTATIONS:
                raise ValueError("此页批注超过标签核对上限。")
            if (annot.info.get("id") or f"external-{page_number}-{annot.xref}") == annotation_id:
                matches.append(annot.xref)
        if len(matches) != 1:
            raise ValueError("此批注已不存在或标识不唯一，请刷新批注。")
        xref = matches[0]
        current = read_tags(doc, xref)
        if current != tags and current != expected:
            raise AnnotationTagsConflict(current)
        return xref, current != tags

    def write(doc):
        xref, changed = checked(doc)
        if changed:
            doc.xref_set_key(xref, PDF_KEY, fitz.get_pdf_str(json.dumps(tags, ensure_ascii=False)) if tags else "null")

    with library.lock():
        with library._open_pdf(library.pdf_path(paper_id)) as doc:
            _, changed = checked(doc)
        used = now()
        library.db.executemany(
            """INSERT INTO annotation_tag_history(tag_key,tag,used) VALUES(?,?,?)
               ON CONFLICT(tag_key) DO UPDATE SET used=excluded.used""",
            ((tag.casefold(), tag, used) for tag in tags),
        )
        if changed:
            library._write_pdf(paper_id, write)
    return {"annotation_id": annotation_id, "tags": tags}
