"""仅用合成 PDF 验证参考文献边界、原文证据、幂等及引用图谱。"""
import hashlib
import json
from contextlib import closing

import pymupdf
import pytest

from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.paper_references import extract, parse_numbered, parse_author_year, parse_references, saved
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


AUTHOR_YEAR_PAGES = [
    (1, 'Synthetic body, Alpha, A., 2020. Not a reference.\nReferences\n'
     'Alpha, A., and Beta, B., 2020. Quantifying synthetic flow. In: C. Sample,\n'
     'D. Example, eds. Proceedings of the synthetic association. 41–49.\n'
     'Gamma, J., et al., 2024. Accurate structure prediction of synthetic\n'
     'fixtures. Journal of Tests, 630 (8), 493–500.\n'
     'Delta, L., Epsilon, I., and'),
    (2, 'Zeta, Y., 2010. An introduction to synthetic data ana-\n'
     'lysis. In: M. M. Fixture and A. Example, eds. Handbook of\n'
     'synthetic analysis. Berlin: Synthetic Press, 73–89.\n'
     'Eta, O.M., Theta, E., and Iota, P., 2019. Presence-only geographical pri-\n'
     'ors for synthetic tests. DOI: 10.1234/synthetic-reference.\nAppendix A\n'
     'Kappa, A., 2021. Appendix text must not become a reference.')]


def test_author_year_multiline_and_cross_page_preserve_original_evidence():
    rows, warnings, ended = parse_author_year(AUTHOR_YEAR_PAGES)
    assert len(rows) == 4 and not warnings and ended
    assert rows[2]['year'] == '2010' and len(rows[2]['parts']) == 2
    assert 'ana-\nlysis' in rows[2]['raw']
    assert 'analysis' in rows[2]['label']
    assert rows[3]['identifiers']['doi'] == ['10.1234/synthetic-reference']
    assert all(row['graph_eligible'] for row in rows)
    assert parse_references(AUTHOR_YEAR_PAGES)[3] == 'author-year'


def test_author_year_pdf_projects_real_nonempty_citations_without_fuzzy_matches(tmp_path):
    with closing(Library(tmp_path / 'library')) as library:
        original = make_pdf(tmp_path / 'author-year.pdf', [text for _, text in AUTHOR_YEAR_PAGES])
        before = original.read_bytes()
        # Running heads and publication page numbers differ from physical PDF numbers.
        with pymupdf.open(original) as doc:
            for index, page in enumerate(doc):
                page.insert_text((50, 24), f'{2710 + index} SYNTHETIC JOURNAL')
            doc.saveIncr()
        before = original.read_bytes()
        item = library.create({'title': 'Synthetic citing paper'})
        library.attach(item['id'], str(original))
        target = library.create({'title': 'Unique DOI target', 'DOI': '10.1234/synthetic-reference'})
        similar = library.create({'title': 'Quantifying synthetic flow', 'authors': ['Alpha'], 'year': 2020})
        snapshot = extract(library, {'id': item['id']})
        assert snapshot['source_kind'] == 'pdf-author-year-bibliography'
        assert snapshot['count'] == snapshot['graph_count'] == 4
        assert all('SYNTHETIC JOURNAL' not in ref['raw'] for ref in snapshot['references'])
        graph = get_graph(library, item['id'], view='citations')
        assert len(graph['edges']) == 4
        targets = {edge['target'] for edge in graph['edges']}
        assert target['id'] in targets and similar['id'] not in targets
        assert any(len(edge['evidence']['parts']) == 2 for edge in graph['edges'])
        assert extract(library, {'id': item['id']})['duplicate']
        assert original.read_bytes() == before


def test_incomplete_and_ambiguous_author_year_entries_remain_visible_but_not_hard_merged(tmp_path):
    text = ('References\nAlpha, A., 2020. Complete synthetic reference. 1–8.\n'
            'Beta, B., 2021. Entry with multiple identifiers. 10.1234/one 10.1234/two.\n'
            'Gamma, G., 2022. A truncated final ref-')
    rows, warnings, ended = parse_author_year([(1, text)])
    assert len(rows) == 3 and not ended
    assert rows[-1]['quality'] == 'needs-review' and rows[-1]['graph_eligible'] is False
    assert any('截断' in warning for warning in warnings)
    assert any('多个标识符' in warning for warning in warnings)
    with closing(Library(tmp_path / 'library')) as library:
        item = library.create({'title': 'Synthetic source'})
        target = library.create({'title': 'Synthetic identifier target', 'DOI': '10.1234/one'})
        library.attach(item['id'], str(make_pdf(tmp_path / 'truncated.pdf', [text])))
        snapshot = extract(library, {'id': item['id']})
        assert snapshot['count'] == 3 and snapshot['graph_count'] == 2
        graph = get_graph(library, item['id'], view='citations')
        assert len(graph['edges']) == 2
        assert all(edge['target'] != target['id'] for edge in graph['edges'])
        assert graph['warnings']


def test_parenthesized_year_and_soft_hyphen_are_supported_without_body_year_splits():
    rows, warnings, _ = parse_author_year([(1, 'Bibliography\n'
        'Alpha, A. (2020). Synthetic inter\u00ad\nnational results.\n'
        'Data were collected in 2013; analyses repeated in 2019.\n'
        'Beta, B., 2020a. Another synthetic result. 20–30.')])
    assert len(rows) == 2 and not warnings
    assert 'international' in rows[0]['label'] and '\u00ad' in rows[0]['raw']
    assert rows[1]['year'] == '2020a'


def test_unrecognized_entry_is_quarantined_instead_of_merging_adjacent_references():
    rows, warnings, _ = parse_author_year([(1, 'References\n'
        'Alpha, A., 2020. Complete synthetic first reference.\n'
        'Beta, B., missing publication year. Uncertain reference.\n'
        'Gamma, C., 2022. Complete synthetic last reference.')])
    assert len(rows) == 3 and warnings
    assert [row['graph_eligible'] for row in rows] == [True, False, True]
    assert all('Beta' not in row['raw'] for row in (rows[0], rows[2]))


def test_broken_author_lines_and_missing_body_do_not_swallow_next_entry():
    rows, warnings, _ = parse_author_year([(1, 'References\n'
        'Alpha,\nA., 2020. Complete synthetic first reference.\n'
        'Beta, B., 2021.\n'
        'van Gamma, C., 2022. Complete synthetic last reference.')])
    assert len(rows) == 3 and warnings
    assert [row['graph_eligible'] for row in rows] == [True, False, True]
    assert rows[-1]['authors_raw'] == 'van Gamma, C.'


def test_unrecognized_author_punctuation_is_not_merged_into_previous_reference():
    rows, warnings, _ = parse_author_year([(1, 'References\n'
        'Alpha, A., 2020. Complete synthetic first reference.\n'
        'Beta, B, 2021. Nonstandard synthetic reference.\n'
        'Gamma, C., 2022. Complete synthetic last reference.')])
    assert len(rows) == 3 and warnings
    assert [row['graph_eligible'] for row in rows] == [True, False, True]


def test_ambiguous_library_doi_keeps_external_node_and_visible_warning(paper):
    library, item, _ = paper
    first = library.create({'title': 'First synthetic duplicate', 'DOI': '10.1234/synthetic-one'})
    second = library.create({'title': 'Second synthetic duplicate'})
    # 模拟旧目录导入的重复 DOI，正常新建入口本身会阻止重复。
    with library.lock():
        library.db.execute('UPDATE papers SET doi=? WHERE id=?', ('10.1234/synthetic-one', second['id']))
    extract(library, {'id': item['id']})
    graph = get_graph(library, item['id'], view='citations')
    assert {e['target'] for e in graph['edges']}.isdisjoint({first['id'], second['id']})
    assert any('多个库内条目' in warning for warning in graph['warnings'])


def test_reference_snapshot_staleness_ignores_native_annotations_but_detects_body_changes(paper):
    library, item, original = paper
    original_bytes = original.read_bytes()
    assert saved(library, item['id']) is None
    snapshot = extract(library, {'id': item['id']})
    assert snapshot['stale'] is False
    managed = library.pdf_path(item['id'])
    with pymupdf.open(managed) as doc:
        page = doc[0]
        page.add_underline_annot((50, 50, 200, 65))
        page.add_text_annot((70, 70), 'Synthetic reading note')
        page.add_freetext_annot((50, 250, 200, 300), 'Synthetic free text note')
        doc.saveIncr()
    assert saved(library, item['id'])['stale'] is False
    repeated = extract(library, {'id': item['id']})
    assert repeated['duplicate'] and repeated['source_version'] == snapshot['source_version']
    with pymupdf.open(managed) as doc:
        doc[0].insert_text((50, 200), 'Changed synthetic body')
        doc.saveIncr()
    assert dispatch({'action': 'graph_references_get', 'library': str(library.root), 'id': item['id']})['stale'] is True
    updated = extract(library, {'id': item['id']})
    assert updated['stale'] is False and updated['duplicate'] is False
    assert updated['source_version'] != snapshot['source_version']
    assert original.read_bytes() == original_bytes


def test_old_snapshot_without_content_identity_is_stale(paper):
    library, item, _ = paper
    extract(library, {'id': item['id']})
    value = saved(library, item['id'], check_source=False)
    value.pop('source_version')
    with library.lock():
        library.db.execute('UPDATE paper_reference_snapshots SET value=? WHERE paper_id=?', (json.dumps(value), item['id']))
    assert saved(library, item['id'])['stale'] is True
    assert extract(library, {'id': item['id']})['stale'] is False
    assert saved(library, item['id'])['source_version']


@pytest.mark.parametrize('body_change', [False, True])
def test_edit_during_extraction_accepts_only_annotation_changes(paper, monkeypatch, body_change):
    from dsh_paper_library import paper_references
    library, item, _ = paper
    baseline = extract(library, {'id': item['id']})
    parse = paper_references.parse_references

    def parse_with_edit(pages):
        result = parse(pages)
        with pymupdf.open(library.pdf_path(item['id'])) as doc:
            if body_change:
                doc[0].insert_text((50, 240), 'Synthetic concurrent body revision')
            else:
                doc[0].add_underline_annot((50, 50, 200, 65))
            doc.saveIncr()
        return result

    monkeypatch.setattr(paper_references, 'parse_references', parse_with_edit)
    if body_change:
        with pytest.raises(ValueError, match='正文'):
            extract(library, {'id': item['id']})
        assert saved(library, item['id'])['source_version'] == baseline['source_version']
    else:
        assert extract(library, {'id': item['id']})['duplicate'] is True


def test_default_bounded_lookback_finds_references_before_long_appendix(tmp_path):
    with closing(Library(tmp_path / 'library')) as library:
        texts = ['Synthetic body.'] * 20 + ['References\nAlpha, A., 2020. Synthetic target study.']
        texts += ['Appendix A\nSynthetic supplementary text.'] + ['Synthetic supplementary text.'] * 15
        original = make_pdf(tmp_path / 'long-appendix.pdf', texts)
        item = library.create({'title': 'Synthetic long appendix'})
        library.attach(item['id'], str(original))
        result = extract(library, {'id': item['id']})
        assert result['count'] == 1 and result['reference_pages'] == [21]
        assert result['scope'] == 'last-40-pages' and len(result['pages']) <= 40
