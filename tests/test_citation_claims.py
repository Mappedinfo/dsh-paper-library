"""Synthetic citation contexts and transactional, source-attributed claims."""
from contextlib import closing

import pymupdf as fitz
import pytest

from dsh_paper_library import citation_claims as claims
from dsh_paper_library import citation_contexts as contexts
from dsh_paper_library.core import Library
from dsh_paper_library.paper_references import read_snapshot


def make_pdf(path, texts, *, double_column=False):
    with fitz.open() as doc:
        for index, body in enumerate(texts):
            page = doc.new_page(width=650, height=800)
            for line_index, line in enumerate(body.splitlines()):
                x = 50 if not double_column or index != 2 or line_index < 3 else 330
                y = 62 + 22 * (line_index if x == 50 else line_index - 2)
                page.insert_text((x, y), line, fontsize=10)
        doc.save(path)
    return path


def paper(library, title, **metadata):
    return library.create({'title': title, **metadata})


@pytest.fixture
def corpus(tmp_path):
    with closing(Library(tmp_path / 'library')) as library:
        source = paper(library, 'Synthetic citing paper')
        target = paper(library, 'Paper A', DOI='10.1234/synth-a')
        other = paper(library, 'Paper B', DOI='10.1234/synth-b')
        dataset = paper(library, 'Paper Dataset', DOI='10.1234/synth-data')
        pdf = make_pdf(tmp_path / 'a.pdf', [
            '1 Introduction\nAlpha [1] and Beta [2] both use sparse matching.\nThe former uses linear search; the latter uses a logarithmic index.\n'
            'Alpha [1] requires costly training and may need more data.\n'
            'Although Alpha could not beat the old baseline, it',
            'improved recall when paired with new features.\nAlpha [1] and Beta [2] are examples of city retrieval.\n'
            'Taken together they cover several application areas.\n'
            'We report that our model beats Alpha [1] on the Example benchmark [3].\n'
            'Earlier systems [1,2-4] use a common protocol.\n2 Methods\nExcluded body [3].',
            'References\n[1] Sample Alice. Alpha research. 2024. doi:10.1234/synth-a.\n'
            '[2] Sample Bob. Beta research. 2024. doi:10.1234/synth-b.\n'
            '[3] Sample Cy. Benchmark research. 2024. doi:10.1234/synth-data.\n'
            '[4] Sample Dee. External work. 2023. arXiv:2301.10001v2.',
        ])
        library.attach(source['id'], str(pdf))
        yield library, source, target, other, dataset, pdf


def item(frozen, contains, relation, markers, *, scope='individual', negated=False, hedged=False):
    for candidate in frozen['candidates']:
        matching = next(((index, part) for index, part in enumerate(candidate['parts']) if contains in part['text']), None)
        if not matching:
            continue
        chosen = []
        for number, role in markers:
            target = next(target for target in frozen['targets'] if target['number'] == number)
            mention = next((binding for mention in candidate['mentions'] for binding in mention['bindings'] if binding['target_id'] == target['id']), None)
            if mention:
                chosen.append({'mention_id': mention['id'], 'role': role})
        if len(chosen) == len(markers):
            return {'context_id': candidate['id'], 'statement': contains, 'scope': scope, 'relation': relation,
                    'methods': ['sparse matching'], 'tasks': ['city retrieval'], 'conditions': ['Example setting'], 'negated': negated, 'hedged': hedged,
                    'targets': chosen, 'evidence': [{'part': matching[0], 'quote': contains}]}
    raise AssertionError(f'Cannot locate {contains!r} and {markers} in candidate windows')


def write(library, frozen, outputs, *, force=False):
    return claims.commit(library, {'frozen': frozen, 'outputs': outputs, 'force': force, 'warnings': [],
                                   'model': {'provider': 'synthetic', 'model': 'fixture'},
                                   'model_candidate_count': len(frozen['candidates']), 'model_truncated': False})


def test_atomic_attribution_and_index_round_trip(corpus):
    library, source, target, other, dataset, pdf = corpus
    before = [path.read_bytes() for path in (pdf, library.pdf_path(source['id']))]
    frozen = claims.prepare(library, {'id': source['id']})
    assert frozen['coverage']['sections'][0]['section'] == 'Introduction'
    assert len(frozen['targets']) == 4 and frozen['targets'][0]['bibliography']
    assert not any('Excluded body' in part['text'] for row in frozen['candidates'] for part in row['parts'])
    assert any({part['page'] for part in row['parts']} == {1, 2} for row in frozen['candidates'])
    assert {target['binding'] for target in frozen['targets']} == {'doi', 'bibliography-only'}
    known = [row for row in frozen['candidates'] if any('[1,2-4]' in m['surface'] for m in row['mentions'])]
    assert len(next(m['bindings'] for m in known[0]['mentions'] if '[1,2-4]' in m['surface'])) == 4
    outputs = [
        item(frozen, 'both use sparse matching', 'uses', [(1, 'subject'), (2, 'subject')], scope='shared'),
        item(frozen, 'former uses linear search', 'uses', [(1, 'subject')]),
        item(frozen, 'latter uses a logarithmic index', 'uses', [(2, 'subject')]),
        item(frozen, 'may need more data', 'limitation', [(1, 'subject')], hedged=True),
        item(frozen, 'could not beat the old baseline', 'limitation', [(1, 'subject')], negated=True),
        item(frozen, 'improved recall when paired with new features', 'strength', [(1, 'subject')]),
        item(frozen, 'Taken together they cover several application areas', 'reports', [(1, 'subject'), (2, 'subject')], scope='group'),
        item(frozen, 'our model beats Alpha', 'compares', [(1, 'baseline'), (3, 'dataset')]),
        item(frozen, 'use a common protocol', 'uses', [(4, 'subject')]),
    ]
    first = write(library, frozen, outputs)
    assert first['count'] == 9 and first['review_status'] == 'needs-review'
    assert claims.prepare(library, {'id': source['id']})['reused']
    incoming = claims.search(library, {'target_id': target['id']})
    assert incoming['total'] == 7 and all(claim['source']['id'] == source['id'] for claim in incoming['items'])
    assert [claim['statement'] for claim in claims.search(library, {'target_id': other['id'], 'relation': 'uses'})['items']] == [
        'both use sparse matching', 'latter uses a logarithmic index']
    assert claims.search(library, {'target_id': dataset['id']})['total'] == 0
    assert claims.search(library, {'target_id': 'doi:10.1234/synth-a', 'relation': 'limitation'})['total'] == 2
    assert claims.search(library, {'target_id': 'arxiv:2301.10001v2'})['total'] == 1
    assert claims.search(library, {'source_id': source['id'], 'method': 'Sparse', 'task': 'retrieval', 'individual_only': True})['total'] == 8
    page = claims.search(library, {'source_id': source['id'], 'limit': 2})
    assert page['next_offset'] == 2
    next_page = claims.search(library, {'source_id': source['id'], 'offset': page['next_offset'], 'limit': 2})
    assert not {item['id'] for item in page['items']} & {item['id'] for item in next_page['items']}
    positive = claims.search(library, {'target_id': target['id'], 'relation': 'strength'})['items'][0]
    assert positive['evidence'][0]['page'] == 2 and positive['source']['status'] == 'current'
    assert [path.read_bytes() for path in (pdf, library.pdf_path(source['id']))] == before


def test_forged_quote_foreign_mention_and_revision_conflicts_preserve_prior_run(corpus):
    library, source, target, _, _, _ = corpus
    first = claims.prepare(library, {'id': source['id']})
    legitimate = item(first, 'may need more data', 'limitation', [(1, 'subject')], hedged=True)
    write(library, first, [legitimate])
    current = claims.prepare(library, {'id': source['id'], 'force': True})
    with pytest.raises(ValueError, match='精确'):
        write(library, current, [{**legitimate, 'evidence': [{'part': 0, 'quote': 'Fabricated exact excerpt.'}]}], force=True)
    with pytest.raises(ValueError, match='未绑定'):
        write(library, current, [{**legitimate, 'targets': [{'mention_id': 'invented', 'role': 'subject'}]}], force=True)
    write(library, current, [legitimate], force=True)
    with pytest.raises(ValueError, match='其他请求'):
        write(library, current, [legitimate], force=True)
    assert claims.search(library, {'target_id': target['id']})['total'] == 1
    assert claims.search(library, {'target_id': target['id']})['items'][0]['hedged']


def test_plain_title_match_and_full_name_author_year_suffixes(tmp_path):
    with closing(Library(tmp_path / 'library')) as library:
        source = paper(library, 'Synthetic ACL-style citing paper')
        alpha = paper(library, 'Alpha city retrieval', author=[{'family': 'Example'}], issued={'date-parts': [[2020]]})
        pdf = make_pdf(tmp_path / 'full.pdf', [
            '1 Introduction\nExample et al. (2020) used a model.\n'
            'Earlier systems (Example et al., 2020a,b) share data.\n'
            'Example and Sample (2020a) proposed a system.',
            'References\nAlice Example and Bob Sample.\n2020a. Alpha city retrieval. In Synthetic Proceedings.\n'
            'Alice Example and Cy Fixture.\n2020b. Beta city retrieval. In Synthetic Proceedings.',
        ])
        library.attach(source['id'], str(pdf))
        result = contexts.public_candidates(library, {'id': source['id']})
        assert result['coverage']['reference_count'] == 2
        assert any(row['binding'] == 'title-author-year' and row['paper_id'] == alpha['id'] for row in result['targets'])
        by_surface = {mention['surface']: mention['bindings'] for row in result['items'] for mention in row['mentions']}
        assert by_surface['Example et al. (2020)'][0]['binding'] == 'ambiguous-bibliography'
        assert by_surface['Example et al. (2020)'][0]['choices'] == [1, 2]
        assert [value['binding'] for value in by_surface['Example et al., 2020a,b']] == ['author-year', 'author-year']
        assert by_surface['Example and Sample (2020a)'][0]['target_id']


def test_double_column_reference_fallback_and_version_conflict(tmp_path):
    with closing(Library(tmp_path / 'library')) as library:
        source = paper(library, 'Two-column source')
        paper(library, 'Different archive version', archive='arXiv', archive_location='2301.10001v1')
        pdf = make_pdf(tmp_path / 'columns.pdf', [
            'Introduction\nPrevious work [3] describes a fixture.', '2 Methods\nMethod body.',
            'References\n[1] Synthetic long reference in column one.\n[2] Synthetic second reference in column one.\n'
            '[3] Synthetic third reference. arXiv:2301.10001v2.\n[4] Synthetic final reference in column two.',
        ], double_column=True)
        library.attach(source['id'], str(pdf))
        assert read_snapshot(library, {'id': source['id']})['count'] == 4
        frozen = claims.prepare(library, {'id': source['id']})
        assert frozen['targets'][0]['binding'] == 'version-conflict'
        assert frozen['targets'][0]['paper_id'] is None


def test_replaced_pdf_marks_old_claims_without_invalidating_annotations(corpus, tmp_path):
    library, source, target, _, _, _ = corpus
    frozen = claims.prepare(library, {'id': source['id']})
    output = item(frozen, 'may need more data', 'limitation', [(1, 'subject')], hedged=True)
    write(library, frozen, [output])
    checked = claims.verify_source(library, {'id': source['id'], 'sha256': frozen['source_version']['sha256']})
    assert checked['source_status'] == 'current'
    # A native PDF annotation changes the file observation but preserves its body identity.
    managed = library.pdf_path(source['id'])
    with fitz.open(managed) as doc:
        doc[0].add_text_annot((75, 75), 'Synthetic private reading note')
        doc.saveIncr()
    assert claims.verify_source(library, {'id': source['id'], 'sha256': frozen['source_version']['sha256']})['source_status'] == 'current'
    refresh = claims.prepare(library, {'id': source['id'], 'force': True})
    replacement = make_pdf(tmp_path / 'replacement.pdf', ['Introduction\nChanged body [1].', 'References\n[1] Alternate synthetic fixture.'])
    replacement.replace(managed)
    assert claims.verify_source(library, {'id': source['id'], 'sha256': frozen['source_version']['sha256']})['source_status'] == 'stale'
    with pytest.raises(ValueError, match='正文已变化'):
        write(library, refresh, [output], force=True)
    assert claims.search(library, {'target_id': target['id']})['items'][0]['source']['status'] == 'needs-source-check'


def test_native_link_narrows_same_author_year_only_at_its_marker(tmp_path):
    with closing(Library(tmp_path / 'library')) as library:
        source = paper(library, 'Synthetic linked citation')
        path = make_pdf(tmp_path / 'linked.pdf', [
            'Introduction\nTwo variants are described by Example (2020).',
            'References\nAlice Example. 2020a. First variant with more detail. In Proceedings.\n'
            'Alice Example. 2020b. Second variant with more detail. In Proceedings.',
        ])
        with fitz.open(path) as doc:
            marker = doc[0].search_for('Example (2020)')[0]
            destination = doc[1].search_for('Alice Example. 2020b.')[0]
            doc[0].insert_link({'kind': fitz.LINK_GOTO, 'from': marker, 'page': 1,
                                'to': fitz.Point(destination.x0, destination.y0)})
            doc.saveIncr()
        library.attach(source['id'], str(path))
        result = contexts.public_candidates(library, {'id': source['id']})
        binding = result['items'][0]['mentions'][0]['bindings'][0]
        assert binding['binding'] == 'pdf-link'
        assert result['targets'][0]['number'] == 2
