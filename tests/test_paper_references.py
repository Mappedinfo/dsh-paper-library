"""仅用合成 PDF 验证参考文献边界、原文证据、幂等及引用图谱。"""
import hashlib

import pymupdf
import pytest

from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.paper_references import extract, parse_numbered, saved
from dsh_paper_library.knowledge_graph import get_graph


def make_pdf(path, texts):
    with pymupdf.open() as doc:
        for index, text in enumerate(texts):
            page = doc.new_page(width=600, height=800)
            page.insert_textbox((50, 50, 550, 700), text, fontsize=11)
            page.insert_text((290, 770), str(index + 1))
        doc.save(path)
    return path


@pytest.fixture
def paper(tmp_path):
    library = Library(tmp_path / 'library')
    original = make_pdf(tmp_path / 'synthetic.pdf', [
        'Synthetic paper. A body mention [1] must not become a reference.',
        'References\n[1] Ada Sample. First synthetic study. DOI: 10.1234/synthetic-one, 2025.\n'
        '[2] Bo Example. Another synthetic study. arXiv:2501.12345v2, 2025.',
        '[3] Cy Fixture. A continued synthetic\nreference without an identifier. Journal of Fixtures, 2024.'])
    item = library.create({'title': 'Synthetic citing paper'})
    library.attach(item['id'], str(original))
    yield library, item, original
    library.close()


def test_real_pdf_objects_and_external_references_are_nonempty_and_idempotent(paper):
    library, item, original = paper
    baseline = original.read_bytes()
    before = library.pdf_path(item['id']).read_bytes()
    existing = library.create({'title': 'Existing synthetic target', 'DOI': '10.1234/synthetic-one'})
    result = extract(library, {'id': item['id']})
    assert result['count'] == 3 and result['reference_pages'] == [2, 3]
    assert result['references'][2]['raw'].endswith('Journal of Fixtures, 2024.')
    assert result['references'][1]['identifiers']['arxiv'] == ['2501.12345']
    assert extract(library, {'id': item['id']})['duplicate'] is True
    graph = get_graph(library, item['id'], view='citations')
    assert len(graph['nodes']) == 4 and len(graph['edges']) == 3
    assert all(n['type'] == 'paper' for n in graph['nodes'])
    assert {e['source'] for e in graph['edges']} == {item['id']}
    assert {e['relation'] for e in graph['edges']} == {'cites'}
    assert any(e['target'] == existing['id'] for e in graph['edges'])
    assert sum(n.get('external_reference', False) for n in graph['nodes']) == 2
    assert all(e['evidence']['page'] in (2, 3) and e['evidence']['quote'].startswith('[') for e in graph['edges'])
    assert saved(library, item['id'])['count'] == 3
    assert original.read_bytes() == baseline and library.pdf_path(item['id']).read_bytes() == before
    assert get_graph(library, focus_id=item['id'], view='citations')['edges']


def test_continued_reference_preserves_each_page_without_guessing_metadata():
    rows, warnings, ended = parse_numbered([(1, 'References\n[1] A. Example. Synthetic long reference'), (2, 'continued on the next page. 2025.\n[2] B. Test. Next study. 2024.\nAppendix A\nNo references here')])
    assert len(rows) == 2 and len(rows[0]['parts']) == 2 and ended
    assert rows[0]['parts'][1]['page'] == 2
    assert rows[0]['identifiers'] == {'doi': [], 'arxiv': []}
    assert not warnings


@pytest.mark.parametrize('text', [
    '[1] Synthetic inline mention without bibliography heading.',
    'References\n[2] Missing first reference.',
    'References\n[1] First reference.\n[1] Duplicate reference.',
    'References\n[1] First reference.\n[3] Missing second reference.',
    'References\n[1] ' + 'X' * 4100,
])
def test_unreliable_or_oversized_segmentation_is_rejected(text):
    with pytest.raises(ValueError):
        parse_numbered([(1, text)])


def test_invalid_scope_does_not_replace_saved_results(paper):
    library, item, _ = paper
    result = extract(library, {'id': item['id']})
    for pages in ([2], [2, 2], [3, 2], [1, 3], [True], [4]):
        with pytest.raises(ValueError):
            extract(library, {'id': item['id'], 'pages': pages})
    assert saved(library, item['id']) == {k: v for k, v in result.items() if k != 'duplicate'}


def test_router_and_graph_bounds(paper):
    library, item, _ = paper
    result = dispatch({'action': 'graph_references_extract', 'library': str(library.root), 'id': item['id']})
    assert result['count'] == 3
    graph = get_graph(library, item['id'], limit=2, view='citations')
    assert len(graph['nodes']) == 2 and len(graph['edges']) == 1 and graph['truncated']
    assert dispatch({'action': 'graph_references_get', 'library': str(library.root), 'id': item['id']})['count'] == 3
