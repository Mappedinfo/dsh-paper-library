"""One portable, human-authored PDF Text annotation on the first page."""
from datetime import datetime, timezone
import hashlib
import re
import uuid


PREFIX = "paper-library-remark-"
KIND = "paper-remark"
MAX_COMMENT = 6000
MAX_BATCH = 12
MAX_FIRST_PAGE_ANNOTATIONS = 2000


def is_paper_remark(annot, info):
    return (re.fullmatch(PREFIX + r"[0-9a-f]{32}", info.get("id") or "") is not None
            and annot.type[0] == 0 and not annot.irt_xref and annot.parent.number == 0)


def _find(page):
    matched = None
    for count, annot in enumerate(page.annots() or (), 1):
        if count > MAX_FIRST_PAGE_ANNOTATIONS:
            raise ValueError("第一页的批注过多，无法安全核对文献备注。")
        info = annot.info
        if not is_paper_remark(annot, info):
            continue
        if matched is not None:
            raise ValueError("PDF 第一页有多条文献备注，请核对后再编辑。")
        matched = (annot, info)
    return matched


def _value(found):
    if found is None:
        return None
    _, info = found
    content = info.get("content", "")
    if len(content) > MAX_COMMENT:
        raise ValueError("PDF 中的文献备注超过 6000 字符。")
    version = hashlib.sha256((info["id"] + "\0" + content).encode()).hexdigest()
    return {"annotation_id": info["id"], "comment": content, "version": version, "page": 1}


def listing(library, ids):
    if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_BATCH
            or any(not isinstance(value, str) or not 1 <= len(value) <= 160 for value in ids)):
        raise ValueError("每次读取 1–12 篇 PDF 的文献备注。")
    items = []
    for paper_id in dict.fromkeys(ids):
        try:
            with library._open_pdf(library.pdf_path(paper_id)) as doc:
                items.append({"id": paper_id, "remark": _value(_find(doc[0])) if doc.page_count else None})
        except (OSError, RuntimeError, ValueError) as exc:
            items.append({"id": paper_id, "error": str(exc)[:240]})
    return {"items": items}


class RemarkConflict(ValueError):
    code = "PAPER_REMARK_CONFLICT"


def save(library, paper_id, comment, expected_version):
    if not isinstance(comment, str) or len(comment) > MAX_COMMENT or "\0" in comment:
        raise ValueError("文献备注须为不超过 6000 字符的文本。")
    if expected_version is not None and (
            not isinstance(expected_version, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_version)):
        raise ValueError("文献备注版本无效。")
    if not comment.strip():
        comment = ""

    def check(found):
        current = _value(found)
        if (current["comment"] if current else "") == comment:
            return True
        if (current["version"] if current else None) != expected_version:
            raise RemarkConflict("文献备注已在其他窗口修改。请读取当前版本并核对后再保存。")
        return False

    def write(doc):
        import pymupdf as fitz

        page = doc[0]
        found = _find(page)
        if check(found):
            return {"remark": _value(found)}
        if not comment:
            annot, _ = found
            if any(child.irt_xref == annot.xref for child in page.annots() or ()):
                raise ValueError("PDF 中仍有此便笺的回复。请处理回复后再清空备注。")
            page.delete_annot(annot)
            return {"remark": None}
        stamp = datetime.now(timezone.utc).strftime("D:%Y%m%d%H%M%SZ")
        if found:
            annot, _ = found
        else:
            bounds = page.rect
            anchor = fitz.Point(max(bounds.width / 2, bounds.width - 34), min(bounds.height / 2, 26))
            annot = page.add_text_annot(anchor * page.derotation_matrix, comment, icon="Comment")
            annot.set_info(subject="文献备注", creationDate=stamp)
            doc.xref_set_key(annot.xref, "NM", fitz.get_pdf_str(PREFIX + uuid.uuid4().hex))
        annot.set_info(content=comment, modDate=stamp)
        annot.update()
        return {"remark": _value((annot, annot.info))}

    with library.lock():
        with library._open_pdf(library.pdf_path(paper_id)) as doc:
            found = _find(doc[0])
            if check(found):
                return {"remark": _value(found)}
        return library._write_pdf(paper_id, write)
