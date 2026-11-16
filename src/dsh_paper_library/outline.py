"""按需读取书签；无书签时逐页识别章节标题，不加载图片或调用模型。"""
import re
import unicodedata
from itertools import islice
from statistics import median
import pymupdf as fitz

HEADING = re.compile(r"^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+\S|(?:abstract|introduction|background|methods?|methodology|results?|discussion|conclusions?|references|bibliography|acknowledg(?:e)?ments?|appendix\b.*|摘要|引言|结论|参考文献)$)", re.I)
NUMBERED = re.compile(r'^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+')


def bookmarks(doc):
    items, stack, visited = [], [], 0
    node = doc.outline
    # PyMuPDF can wrap a null outline pointer for PDFs without bookmarks.
    if node is not None and not node.this.m_internal:
        node = None
    while node is not None and visited < 1000:
        visited += 1
        bookmark_id = f"bookmark-{visited}"
        child = node.down
        page = node.page + 1 if not node.is_external and 0 <= node.page < doc.page_count else None
        if page is not None or child is not None:
            items.append({'id': bookmark_id, 'parent_id': stack[-1][1] if stack else None,
                          'title': str(node.title or '未命名章节')[:240],
                          'level': len(stack) + 1, 'page': page})
        if child is not None:
            stack.append((node.next, bookmark_id))
            node = child
        else:
            node = node.next
            while node is None and stack:
                node, _ = stack.pop()
    return items, node is not None


def heading_key(text):
    normalized = unicodedata.normalize("NFKC", text).replace("\u00ad", "").strip()
    return " ".join(NUMBERED.sub("", normalized).split()).casefold()


def page_lines(blocks):
    return list(islice((line for block in blocks[:2000] for line in block.get('lines', [])[:300]), 6000))


def headings(page, lines, bookmark_titles=()):
    sizes = [span['size'] for line in lines for span in line.get('spans', [])
             if len(span.get('text', '').strip()) > 20]
    body_size = median(sizes) if sizes else 11
    texts = [''.join(span['text'] for span in line.get('spans', [])).strip() for line in lines]
    found, covered_until = 0, -1
    for index, line in enumerate(lines):
        if index <= covered_until or abs(line.get('dir', (1, 0))[1]) > .2:
            continue
        spans = line.get('spans', [])
        text = texts[index]
        title_end = index
        linked = heading_key(text) in bookmark_titles
        if bookmark_titles and not linked and text:
            # Publisher bookmarks often omit the section number and hard wraps.
            # Join only neighbouring horizontal lines in the same column.
            combined = text
            for following in range(index + 1, min(len(lines), index + 3)):
                x0, y0, _, y1 = lines[following - 1]['bbox']
                x, y, _, _ = lines[following]['bbox']
                if (abs(lines[following].get('dir', (1, 0))[1]) > .2 or abs(x - x0) > 36
                        or not y0 < y <= y1 + (y1 - y0) * 1.2):
                    break
                combined += ' ' + texts[following]
                if heading_key(combined) in bookmark_titles:
                    text, title_end, linked = combined, following, True
                    break
        if not 2 <= len(text) <= 150 or not (linked or HEADING.match(text)):
            continue
        numbered = NUMBERED.match(text)
        # An exact bookmark title can confirm an otherwise ambiguous text run.
        # Other numbered lines still need the typography of a short heading.
        if numbered and not linked:
            if len(text.split()) > 16 or text.endswith(('.', ';', ',')):
                continue
            if not any(span.get('flags', 0) & 16 or span.get('size', 0) > body_size * 1.12 for span in spans):
                continue
        rects = [list(fitz.Rect(part['bbox']) * page.rotation_matrix) for part in lines[index:title_end + 1]]
        yield index, {'title': text, 'level': min(numbered[1].count('.') + 1, 4) if numbered else 1,
                      'page': page.number + 1, 'rects': rects}
        covered_until = title_end
        found += 1
        if found >= 60:
            break


def read(library, request):
    with library._open_pdf(library.pdf_path(request['id'])) as doc:
        if request.get('page') is None:
            items, truncated = bookmarks(doc)
            return {'items': items, 'source': 'bookmarks', 'page_count': doc.page_count,
                    'truncated': truncated}
        number = request['page']
        if type(number) is not int or not 1 <= number <= doc.page_count:
            raise ValueError('大纲页码无效。')
        page = doc[number - 1]
        blocks = page.get_text('dict', flags=fitz.TEXTFLAGS_TEXT)['blocks']
        items = [item for _, item in headings(page, page_lines(blocks))]
        return {'items': items, 'source': 'inferred', 'page_count': doc.page_count, 'page': number}
