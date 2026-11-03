"""Read-only search in the PDF currently shown by the LaTeX workbench."""

from pathlib import Path
from time import monotonic

from .latex_review import MAX_PDF_BYTES


MAX_QUERY = 200
MAX_BATCH_PAGES = 40
MAX_BATCH_HITS = 120
MAX_PAGE_CHARACTERS = 100_000
MAX_BATCH_SECONDS = 2.0


def _signature(metadata):
    return metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns


def search(library, id=None, query=None, start_page=1, expected_version=None,
           version_id=None, review_pdf_version=None):
    from pymupdf import TEXTFLAGS_SEARCH
    from .latex import _project, _project_pdf
    from .latex_versions import get as get_version

    if not isinstance(query, str) or len(query) > MAX_QUERY or "\0" in query:
        raise ValueError(f"PDF 搜索词须为 1–{MAX_QUERY} 个字符")
    query = " ".join(query.split())
    if not query:
        raise ValueError("请输入 PDF 搜索词")
    if isinstance(start_page, bool) or not isinstance(start_page, int) or start_page < 1:
        raise ValueError("PDF 起始页须为正整数")

    row = _project(library, id)
    if version_id is not None:
        found = get_version(library, version_id, review_pdf_version)
        if found["version"]["project_id"] != row["id"]:
            raise ValueError("历史版本不属于当前项目")
        path = Path(found["pdf_path"])
    else:
        if review_pdf_version is not None:
            raise ValueError("历史审阅 PDF 需要指定版本")
        # Review annotations change the overlay, not the compiled page text.
        path = _project_pdf(library, row)

    before = path.stat()
    if before.st_size > MAX_PDF_BYTES:
        raise ValueError("PDF 超过搜索读取预算")
    version = (f"{version_id}:{review_pdf_version or 'current'}" if version_id is not None
               else f"{before.st_mtime_ns}:{before.st_size}")
    if expected_version is not None and expected_version != version:
        raise ValueError("PDF 已更新，请重新打开预览后搜索")

    deadline = monotonic() + MAX_BATCH_SECONDS
    matches, truncated = [], False
    cursor = start_page
    with library._open_pdf(path) as document:
        page_count = len(document)
        if start_page > max(page_count, 1):
            raise ValueError("PDF 起始页超出范围")
        last = min(page_count, start_page + MAX_BATCH_PAGES - 1)
        while cursor <= last:
            # Always try one page to make progress even on a slow machine.
            if cursor != start_page and (monotonic() >= deadline or len(matches) >= MAX_BATCH_HITS):
                break
            page = document[cursor - 1]
            text_page = page.get_textpage(flags=TEXTFLAGS_SEARCH)
            if len(text_page.extractText()) > MAX_PAGE_CHARACTERS:
                truncated = True
                cursor += 1
                continue
            hits = text_page.search(query, quads=False)
            remaining = MAX_BATCH_HITS - len(matches)
            if len(hits) > remaining and matches:
                # Restart this page on the next batch instead of dropping hits.
                break
            if len(hits) > remaining:
                truncated = True
            for hit in hits[:remaining]:
                rect = library._rect(hit, page) & page.rect
                if rect.is_empty:
                    continue
                text = " ".join(page.get_textbox(hit, textpage=text_page).split())[:MAX_QUERY]
                matches.append({"page": cursor, "rects": [list(rect)], "text": text or query})
            cursor += 1

    if _signature(path.stat()) != _signature(before):
        raise ValueError("PDF 在搜索期间已更新，请重新打开预览后搜索")
    return {"version": version, "page_count": page_count, "pages_searched": cursor - start_page,
            "matches": matches, "next_page": cursor if cursor <= page_count else None,
            "truncated": truncated}
