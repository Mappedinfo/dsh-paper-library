"""按需读取书签；无书签时逐页识别章节标题，不加载图片或调用模型。"""
import re
from statistics import median
import pymupdf as fitz

HEADING = re.compile(r"^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+\S|(?:abstract|introduction|background|methods?|methodology|results?|discussion|conclusions?|references|bibliography|acknowledg(?:e)?ments?|appendix\b.*|摘要|引言|结论|参考文献)$)", re.I)


def read(library, request):
    with library._open_pdf(library.pdf_path(request['id'])) as doc:
        if request.get('page') is None:
            items, stack, visited = [], [], 0
            node = doc.outline
            # PyMuPDF can wrap a null outline pointer for PDFs without bookmarks.
            # Match its own get_toc guard before accessing native properties.
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
            return {'items': items, 'source': 'bookmarks', 'page_count': doc.page_count,
                    'truncated': node is not None}
        number = request['page']
        if type(number) is not int or not 1 <= number <= doc.page_count:
            raise ValueError('大纲页码无效。')
        page = doc[number - 1]
        blocks = page.get_text('dict', flags=fitz.TEXTFLAGS_TEXT)['blocks']
        sizes = [span['size'] for block in blocks[:2000] for line in block.get('lines', [])[:300]
                 for span in line.get('spans', []) if len(span.get('text', '').strip()) > 20]
        body_size = median(sizes) if sizes else 11
        items = []
        for block in blocks[:2000]:
            for line in block.get('lines', [])[:300]:
                spans = line.get('spans', [])
                text = ''.join(span['text'] for span in spans).strip()
                # Short, standalone headings only. Body sentences and citation rows
                # must not become a navigational hierarchy merely for being bold.
                if not 2 <= len(text) <= 150 or not HEADING.match(text):
                    continue
                numbered = re.match(r'^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+', text)
                if numbered and (len(text.split()) > 16 or text.endswith(('.', ';', ','))):
                    continue
                if numbered and not any(span.get('flags', 0) & 16 or span.get('size', 0) > body_size * 1.12 for span in spans):
                    continue
                rect = fitz.Rect(line['bbox']) * page.rotation_matrix
                items.append({'title': text, 'level': min(numbered[1].count('.') + 1, 4) if numbered else 1,
                              'page': number, 'rects': [list(rect)]})
                if len(items) >= 60:
                    break
            if len(items) >= 60:
                break
        return {'items': items, 'source': 'inferred', 'page_count': doc.page_count, 'page': number}
