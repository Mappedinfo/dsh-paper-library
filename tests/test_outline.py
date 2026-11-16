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
            doc.set_toc([[1, 'Introduction', 1], [1, 'Methodology', -1],
                         [2, 'Synthetic method', 1], [2, 'Experiment', 2],
                         [3, 'Setup', 2], [2, 'Analysis', 2], [1, 'Conclusion', 2]])
        doc.save(source)
    library = str(tmp_path / 'library')
    item = dispatch({'library': library, 'action': 'import', 'path': str(source)})['items'][0]
    return {'library': library, 'id': item['id'], 'action': 'paper_outline'}


def test_bookmark_hierarchy_and_pages(tmp_path):
    result = dispatch(paper(tmp_path, bookmarks=True))
    expected = [
        (None, 'Introduction', 1, 1), (None, 'Methodology', 1, None),
        ('bookmark-2', 'Synthetic method', 2, 1), ('bookmark-2', 'Experiment', 2, 2),
        ('bookmark-4', 'Setup', 3, 2), ('bookmark-2', 'Analysis', 2, 2),
        (None, 'Conclusion', 1, 2),
    ]
    assert [(item['parent_id'], item['title'], item['level'], item['page']) for item in result['items']] == expected
    assert [item['id'] for item in result['items']] == [f'bookmark-{index}' for index in range(1, 8)]
    assert not result['truncated']


@pytest.mark.parametrize("rotation", [0, 90])
def test_search_sections_use_text_order_and_prior_bookmarks(tmp_path, rotation):
    source = tmp_path / "synthetic-search-sections.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 60), "needle before the first title")
        page.insert_text((40, 100), "Abstract", fontname="hebo", fontsize=16)
        page.insert_text((40, 150), "needle in the abstract")
        page.insert_text((40, 410), "2.1 Study", fontsize=12)
        page.insert_text((55, 426), "design", fontsize=12)
        page.insert_text((40, 455), "needle in the lower left column")
        page.insert_text((325, 55), "needle continuing in the right column")
        page.set_rotation(rotation)
        doc.new_page().insert_text((40, 60), "needle on the following page")
        doc.set_toc([[1, "Study design", 1]])
        doc.save(source)
    library = str(tmp_path / "library")
    item = dispatch({"library": library, "action": "import", "path": str(source)})["items"][0]
    request = {"library": library, "id": item["id"], "action": "paper_text_find", "query": "needle"}
    assert "section_context" not in dispatch(request)
    page_one = dispatch({**request, "include_sections": True})
    assert [match["section"]["title"] if match["section"] else None for match in page_one["matches"]] == [
        None, "Abstract", "2.1 Study design", "2.1 Study design",
    ]
    continued = dispatch({**request, "page": 2, "include_sections": True})
    assert continued["matches"][0]["section"] is None
    assert continued["section_context"] == {"before": {"title": "Study design", "page": 1}, "last": None}


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
