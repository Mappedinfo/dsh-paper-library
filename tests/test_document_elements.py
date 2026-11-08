"""结构索引仅使用合成资料，验证版面候选、坐标、分页和原生写入。"""
import base64
import hashlib

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, dispatch as core_dispatch
from dsh_paper_library.document_elements import dispatch


def make_library(tmp_path, rotation=0):
    source = tmp_path / 'source.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=500, height=700)
        page.insert_text((55, 55), 'Synthetic structures')
        page.draw_rect(fitz.Rect(70, 90, 270, 190), color=(1, 0, 0), fill=(1, 0, 0))
        page.insert_text((70, 210), 'Figure 1. Workflow for synthetic data')
        page.insert_text((70, 260), 'y = a*x + b (1)')
        page.insert_text((70, 280), 'where x denotes input and a is the slope.')
        page.insert_text((70, 320), 'Table 1. Synthetic measurements')
        for x in (70, 170, 270):
            page.draw_line((x, 340), (x, 400))
        for y in (340, 370, 400):
            page.draw_line((70, y), (270, y))
        for x, y, t in [(80, 360, 'A'), (180, 360, 'B'), (80, 390, '1'), (180, 390, '2')]:
            page.insert_text((x, y), t)
        page.insert_text((70, 450), 'Algorithm 1. Process synthetic data')
        for index, text in enumerate(['1 Input values', '2 for each value do', '3   Update value', '4 end for', '5 return values']):
            page.insert_text((70, 470 + 16 * index), text)
        page.set_cropbox(fitz.Rect(20, 20, 480, 680))
        page.set_rotation(rotation)
        for _ in range(6):
            doc.new_page()
        doc.save(source)
    root = tmp_path / 'library'
    paper = core_dispatch({'library': str(root), 'action': 'import', 'path': str(source)})['items'][0]
    return Library(root), paper['id'], source


def call(library, paper, action, **kwargs):
    return dispatch(library, {'id': paper, 'action': action, **kwargs})


def test_bounded_incremental_scan_search_and_definition(tmp_path):
    library, paper, _ = make_library(tmp_path)
    first = call(library, paper, 'document_elements_scan', limit=2)
    assert first['scanned_batch'] == [1, 2]
    assert first['coverage']['next_page'] == 3
    assert not first['coverage']['complete']
    values = call(library, paper, 'document_elements_list')['elements']
    assert {item['kind'] for item in values} == {'figure', 'formula', 'table', 'algorithm'}
    formula = next(item for item in values if item['kind'] == 'formula')
    assert 'where x denotes' in formula['definition']
    algorithm = next(item for item in values if item['kind'] == 'algorithm')
    assert '5 return values' in algorithm['text']
    assert call(library, paper, 'document_elements_list', query='slope')['total'] >= 1
    again = call(library, paper, 'document_elements_scan', start_page=1, limit=2)
    assert again['cached_pages'] == [1, 2] and again['scanned_batch'] == []
    final = call(library, paper, 'document_elements_scan', limit=6)
    assert final['scanned_batch'] == [3, 4, 5, 6, 7]
    assert final['coverage']['complete'] and final['coverage']['next_page'] is None
    warnings = call(library, paper, 'document_elements_list')['page_warnings']
    assert any('没有可提取文字' in ' '.join(row['warnings']) for row in warnings)
    assert len(call(library, paper, 'document_elements_list', limit=1)['elements']) == 1


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_preview_rotation_and_idempotent_native_annotation(tmp_path, rotation):
    library, paper, source = make_library(tmp_path, rotation)
    original = hashlib.sha256(source.read_bytes()).hexdigest()
    result = call(library, paper, 'document_elements_scan', limit=1)
    figure = next(item for item in result['elements'] if item['kind'] == 'figure')
    preview = call(library, paper, 'document_element_preview', element_id=figure['id'])
    pix = fitz.Pixmap(base64.b64decode(preview['image']))
    assert pix.width * pix.height <= 303000
    assert pix.pixel(pix.width // 2, pix.height // 2) == (255, 0, 0)
    annotated = call(library, paper, 'document_element_annotate', element_id=figure['id'])
    assert annotated['annotation']['type'] == 'square'
    # PDF /Square 的 /Rect 包括默认 2pt 边框的半宽。
    assert annotated['annotation']['rect'] == pytest.approx(list(fitz.Rect(figure['rect']) + (-1,-1,1,1)), abs=.1)
    repeated = call(library, paper, 'document_element_annotate', element_id=figure['id'])
    assert repeated['reused'] is True
    assert repeated['annotation']['id'] == annotated['annotation']['id']
    assert len(library.annotations(paper)['annotations']) == 1
    refreshed = call(library, paper, 'document_elements_list')
    assert refreshed['source_version'] == result['source_version']
    assert not refreshed['stale']
    assert original == hashlib.sha256(source.read_bytes()).hexdigest()
    assert list((library.root / 'backups').rglob('*.pdf.bak'))


def test_content_change_rejects_old_geometry_but_annotations_do_not(tmp_path):
    library, paper, _ = make_library(tmp_path)
    first = call(library, paper, 'document_elements_scan', limit=1)
    element_id = first['elements'][0]['id']
    library.annotate(paper, page=1, type='underline', rects=[[30, 30, 120, 50]], text='Synthetic')
    assert call(library, paper, 'document_elements_list')['source_version'] == first['source_version']
    with library.lock():
        library._write_pdf(paper, lambda doc: doc[0].insert_text((55, 620), 'New actual content'))
    assert call(library, paper, 'document_elements_list')['stale']
    with pytest.raises(ValueError, match='stale'):
        call(library, paper, 'document_element_preview', element_id=element_id)
    fresh = call(library, paper, 'document_elements_scan', limit=1)
    assert fresh['source_version'] != first['source_version']
    assert not fresh['stale']


@pytest.mark.parametrize('kwargs', [{'limit': 7}, {'limit': True}, {'start_page': 0}, {'start_page': 8}])
def test_scan_limits(tmp_path, kwargs):
    library, paper, _ = make_library(tmp_path)
    with pytest.raises(ValueError):
        call(library, paper, 'document_elements_scan', **kwargs)


def test_flowchart_subtype_and_algorithm_parse(tmp_path):
    library, paper, _ = make_library(tmp_path)
    call(library, paper, 'document_elements_scan', limit=1)
    figures = call(library, paper, 'document_elements_list', kind='figure', subtype='flowchart')['elements']
    assert len(figures) == 1 and figures[0]['subtype_method'] == 'caption-keywords'
    algorithms = call(library, paper, 'document_elements_list', kind='algorithm')['elements']
    result = call(library, paper, 'document_element_flow', element_id=algorithms[0]['id'])
    assert any(node['kind'] == 'loop' for node in result['flow']['nodes'])
    assert result['flow']['warnings']
    with pytest.raises(ValueError, match='Only algorithm'):
        call(library, paper, 'document_element_flow', element_id=figures[0]['id'])


def test_literal_search_and_preview_limits(tmp_path):
    library, paper, _ = make_library(tmp_path)
    result = call(library, paper, 'document_elements_scan', limit=1)
    assert call(library, paper, 'document_elements_list', query='%')['total'] == 0
    for value in (0, 641, True, float('nan')):
        with pytest.raises(ValueError, match='render_width'):
            call(library, paper, 'document_element_preview', element_id=result['elements'][0]['id'], render_width=value)
    with pytest.raises(ValueError, match='warning_offset'):
        call(library, paper, 'document_elements_list', warning_offset=-1)


def test_caption_only_and_embedded_image_are_explicit_candidates(tmp_path):
    source = tmp_path / 'source.pdf'
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 30, 30), False)
    pix.clear_with(140)
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 80), 'Figure 1. Unresolved illustration')
        page.insert_image(fitz.Rect(50, 300, 200, 450), pixmap=pix)
        doc.save(source)
    paper = core_dispatch({'library': str(tmp_path / 'library'), 'action': 'import', 'path': str(source)})['items'][0]['id']
    library = Library(tmp_path / 'library')
    result = call(library, paper, 'document_elements_scan')
    assert any(value['method'] == 'caption-only' and value['warnings'] for value in result['elements'])
    assert any(value['method'] == 'embedded-image' for value in result['elements'])


def test_split_equation_number_and_table_rows_survive_caption(tmp_path):
    library, paper, _ = make_library(tmp_path)
    with library.lock():
        def write(doc):
            page = doc[1]
            page.insert_text((160, 180), 'f(x)')
            page.insert_text((195, 180), '=')
            page.insert_text((220, 180), 'a + b')
            page.insert_text((440, 180), '(13)')
            page.insert_text((55, 210), 'where a denotes the input and b is the bias.')
        library._write_pdf(paper, write)
    call(library, paper, 'document_elements_scan', limit=2)
    formulas = call(library, paper, 'document_elements_list', kind='formula')['elements']
    split = next(value for value in formulas if '(13)' in value['title'])
    assert 'f(x)' in split['text'] and 'a + b' in split['text']
    assert 'where a denotes' in split['definition']
    tables = call(library, paper, 'document_elements_list', kind='table')['elements']
    assert len(tables) == 1
    assert tables[0]['method'] == 'pymupdf-table'
    assert tables[0]['rows'] == [['A', 'B'], ['1', '2']]
    assert tables[0]['caption'] == 'Table 1. Synthetic measurements'


def test_algorithm_continuation_has_source_segments_and_bounded_lookahead(tmp_path):
    source = tmp_path / 'cross.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=500, height=700)
        page.insert_text((60, 610), 'Algorithm 1. Bounded iteration')
        page.insert_text((60, 635), '1 for each item do')
        page.insert_text((60, 655), '2 Update item')
        page = doc.new_page(width=500, height=700)
        page.insert_text((60, 60), '3 end for')
        page.insert_text((60, 80), '4 return result')
        page.insert_text((60, 140), 'A separate prose paragraph should not be in the algorithm.')
        doc.save(source)
    paper = core_dispatch({'library': str(tmp_path / 'library'), 'action': 'import', 'path': str(source)})['items'][0]['id']
    library = Library(tmp_path / 'library')
    result = call(library, paper, 'document_elements_scan', limit=1)
    algorithm = next(value for value in result['elements'] if value['kind'] == 'algorithm')
    assert result['lookahead_pages'] == [2]
    assert result['coverage']['scanned_pages'] == [1]
    assert [segment['page'] for segment in algorithm['source_segments']] == [1, 2]
    assert '3 end for' in algorithm['text'] and '4 return result' in algorithm['text']
    assert 'separate prose' not in algorithm['text']
    result = call(library, paper, 'document_element_flow', element_id=algorithm['id'])
    assert result['flow']['complete']


def test_annotation_appearances_do_not_enter_initial_structure_index(tmp_path):
    library, paper, _ = make_library(tmp_path)
    with library.lock():
        def write(doc):
            page = doc[1]
            note = page.add_freetext_annot(fitz.Rect(50, 50, 400, 100), 'Figure 99. Fake annotation figure')
            note.update()
            note = page.add_rect_annot(fitz.Rect(50, 110, 400, 250))
            note.update()
        library._write_pdf(paper, write)
    result = call(library, paper, 'document_elements_scan', start_page=2, limit=1)
    assert result['elements'] == []
    assert call(library, paper, 'document_elements_list', query='Fake annotation')['total'] == 0


def test_continuation_deferred_by_six_page_budget_resumes_in_next_batch(tmp_path):
    source = tmp_path / 'boundary.pdf'
    with fitz.open() as doc:
        for _ in range(5):
            doc.new_page(width=500, height=700)
        page = doc.new_page(width=500, height=700)
        page.insert_text((60, 610), 'Algorithm 1. Bounded iteration')
        page.insert_text((60, 635), '1 for each item do')
        page.insert_text((60, 655), '2 Update item')
        page = doc.new_page(width=500, height=700)
        page.insert_text((60, 60), '3 end for')
        page.insert_text((60, 80), '4 return result')
        doc.save(source)
    paper = core_dispatch({'library': str(tmp_path / 'library'), 'action': 'import', 'path': str(source)})['items'][0]['id']
    library = Library(tmp_path / 'library')
    first = call(library, paper, 'document_elements_scan', limit=6)
    algorithm = next(value for value in first['elements'] if value['kind'] == 'algorithm')
    assert first['lookahead_pages'] == [] and algorithm['extraction_incomplete']
    final = call(library, paper, 'document_elements_scan')
    assert final['coverage']['complete']
    algorithm = call(library, paper, 'document_elements_list', kind='algorithm')['elements'][0]
    assert not algorithm.get('extraction_incomplete')
    assert len(algorithm['source_segments']) == 2 and '4 return result' in algorithm['text']


def test_default_is_one_page_and_low_disk_preserves_readable_index(tmp_path, monkeypatch):
    from dsh_paper_library import document_elements as elements
    library, paper, source = make_library(tmp_path)
    first = call(library, paper, 'document_elements_scan')
    assert first['scanned_batch'] == [1]
    assert first['usage']['index_bytes'] > 0
    monkeypatch.setattr(elements, '_disk_free', lambda _: 0)
    paused = call(library, paper, 'document_elements_scan')
    assert paused['paused'] and '磁盘' in paused['budget_reason']
    assert paused['coverage']['scanned_pages'] == [1]
    values = call(library, paper, 'document_elements_list')
    assert values['total'] > 0 and not values.get('paused')
    image = call(library, paper, 'document_element_preview', element_id=values['elements'][0]['id'])
    assert image['image']


def test_low_disk_before_identity_does_not_create_temporary_base(tmp_path, monkeypatch):
    from dsh_paper_library import document_elements as elements
    library, paper, _ = make_library(tmp_path)
    monkeypatch.setattr(elements, '_disk_free', lambda _: 0)
    monkeypatch.setattr(elements, 'content_version', lambda *args: pytest.fail('must stop before copying PDF'))
    result = call(library, paper, 'document_elements_scan')
    assert result['paused'] and not result['source_verified']
    assert result['coverage']['scanned_pages'] == []


@pytest.mark.parametrize('quota', ['MAX_INDEX_BYTES', 'MAX_LIBRARY_INDEX_BYTES', 'MAX_PAGE_BYTES'])
def test_index_quotas_pause_without_losing_scanned_pages(tmp_path, monkeypatch, quota):
    from dsh_paper_library import document_elements as elements
    library, paper, _ = make_library(tmp_path)
    first = call(library, paper, 'document_elements_scan')
    used = first['usage']['index_bytes']
    monkeypatch.setattr(elements, quota, 10 if quota == 'MAX_PAGE_BYTES' else used + 10)
    result = call(library, paper, 'document_elements_scan')
    assert result['paused'] and result['budget_reason']
    assert result['coverage']['scanned_pages'] == [1]
    assert result['usage']['index_bytes'] == used
    assert call(library, paper, 'document_elements_list')['total'] > 0


def test_per_page_pause_commits_earlier_page_in_same_batch(tmp_path, monkeypatch):
    from dsh_paper_library import document_elements as elements
    library, paper, _ = make_library(tmp_path)
    original = elements._extract
    def extract(page, version, page_number=None):
        if page_number == 2:
            raise elements.ElementBudgetError('Synthetic page resource budget')
        return original(page, version, page_number)
    monkeypatch.setattr(elements, '_extract', extract)
    result = call(library, paper, 'document_elements_scan', limit=2)
    assert result['paused'] and result['scanned_batch'] == [1]
    assert call(library, paper, 'document_elements_list')['coverage']['scanned_pages'] == [1]


def test_explicit_clear_only_removes_derived_rows(tmp_path, monkeypatch):
    from dsh_paper_library import document_elements as elements
    library, paper, source = make_library(tmp_path)
    first = call(library, paper, 'document_elements_scan')
    call(library, paper, 'document_element_annotate', element_id=first['elements'][0]['id'])
    before = library.pdf_path(paper).read_bytes()
    monkeypatch.setattr(elements, '_disk_free', lambda _: 0)
    result = call(library, paper, 'document_elements_clear')
    assert result['cleared'] and result['usage']['index_bytes'] == 0
    assert library.pdf_path(paper).read_bytes() == before
    assert len(library.annotations(paper)['annotations']) == 1
    assert source.exists()


def test_compressed_stream_expansion_stops_before_parsing(tmp_path, monkeypatch):
    from dsh_paper_library import document_elements as elements
    library, paper, _ = make_library(tmp_path)
    with library.lock():
        def write(doc):
            xref = doc.get_new_xref()
            doc.update_object(xref, '<<>>')
            doc.update_stream(xref, b'0 0 m 1 1 l S\n' * 10000, compress=True)
            doc[1].set_contents(xref)
        library._write_pdf(paper, write)
    monkeypatch.setattr(elements, 'MAX_PAGE_DECODED_BYTES', 65536)
    result = call(library, paper, 'document_elements_scan', start_page=2)
    assert result['paused'] and '解压' in result['budget_reason']
    assert not result['scanned_batch']


def test_usage_counters_are_exact_and_legacy_pages_initialize_in_batches(tmp_path):
    library, paper, _ = make_library(tmp_path)
    result = call(library, paper, 'document_elements_scan', limit=2)
    exact = library.db.execute('SELECT sum(length(CAST(value AS BLOB))+length(CAST(search_text AS BLOB))+512) FROM document_elements WHERE paper_id=?', (paper,)).fetchone()[0]
    exact += library.db.execute('SELECT sum(length(CAST(warnings AS BLOB))+256) FROM document_element_pages WHERE paper_id=?', (paper,)).fetchone()[0]
    assert result['usage']['index_bytes'] == exact
    with library.lock():
        library.db.execute('UPDATE document_element_pages SET index_bytes=NULL WHERE paper_id=?', (paper,))
    reloaded = call(library, paper, 'document_elements_list')
    assert reloaded['usage']['index_bytes'] == exact
    assert reloaded['usage']['estimated_legacy_pages'] == 0


def test_library_quota_counts_other_papers_and_clear_releases_only_budget(tmp_path, monkeypatch):
    from dsh_paper_library import document_elements as elements
    library, first, _ = make_library(tmp_path)
    first_scan = call(library, first, 'document_elements_scan')
    other = tmp_path / 'other.pdf'
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 70), 'A second synthetic paper')
        doc.save(other)
    second = core_dispatch({'library': str(library.root), 'action': 'import', 'path': str(other)})['items'][0]['id']
    monkeypatch.setattr(elements, 'MAX_LIBRARY_INDEX_BYTES', first_scan['usage']['index_bytes'] + 10)
    paused = call(library, second, 'document_elements_scan')
    assert paused['paused'] and '全库' in paused['budget_reason']
    assert paused['usage']['index_bytes'] == 0
    assert call(library, first, 'document_elements_list')['total'] > 0
    cleared = call(library, first, 'document_elements_clear')
    assert cleared['usage']['library_index_bytes'] == 0
    assert not call(library, second, 'document_elements_scan')['paused']
