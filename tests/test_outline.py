import pymupdf as fitz
import pytest
from dsh_paper_library.core import dispatch


def paper(tmp_path, bookmarks=False, rotation=0):
    source = tmp_path / 'synthetic.pdf'
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 60), '1 Introduction', fontname='hebo', fontsize=15)
        page.insert_text((50, 100), 'This is ordinary synthetic body text for testing.', fontsize=11)
        page.insert_text((50, 140), '1 Input values', fontsize=11)
        page.insert_text((50, 180), '1 A numbered sentence should not become a heading.', fontname='hebo')
        page.set_rotation(rotation)
        doc.new_page().insert_text((50, 60), '2.1 Synthetic method', fontname='hebo', fontsize=15)
        if bookmarks:
            doc.set_toc([[1, 'Introduction', 1], [2, 'Synthetic method', 2]])
        doc.save(source)
    library = str(tmp_path / 'library')
    item = dispatch({'library': library, 'action': 'import', 'path': str(source)})['items'][0]
    return {'library': library, 'id': item['id'], 'action': 'paper_outline'}


def test_bookmark_hierarchy_and_pages(tmp_path):
    result = dispatch(paper(tmp_path, bookmarks=True))
    assert result['items'] == [{'title': 'Introduction', 'level': 1, 'page': 1},
                               {'title': 'Synthetic method', 'level': 2, 'page': 2}]
    assert not result['truncated']


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_inference_is_explicit_page_bounded_and_ignores_numbered_body(tmp_path, rotation):
    request = paper(tmp_path, rotation=rotation)
    assert dispatch(request)['items'] == []
    result = dispatch({**request, 'page': 1})
    assert [item['title'] for item in result['items']] == ['1 Introduction']
    rect = result['items'][0]['rects'][0]
    assert rect[2] > rect[0] >= 0 and rect[3] > rect[1] >= 0
    assert dispatch({**request, 'page': 2})['items'][0]['level'] == 2
    for value in [0, 3, True, '1']:
        with pytest.raises(ValueError, match='页码'):
            dispatch({**request, 'page': value})
