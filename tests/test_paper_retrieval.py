"""合成跨章节证据：背景提到一种算法，方法页使用另一种目标。"""
import hashlib
import base64

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library
from dsh_paper_library.worker import dispatch_request
from dsh_paper_library.paper_retrieval import normalized


@pytest.fixture
def fixture(tmp_path):
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        for index in range(25):
            page = doc.new_page()
            if index == 0:
                page.insert_text((40, 60), "Background: prior systems used Word2Vec. See Method on page 22.")
            elif index == 21:
                page.insert_text((40, 60), "Method: our synthetic system uses a reconstruction objective, not Word2Vec.")
            elif index == 22:
                page.insert_textbox(fitz.Rect(30, 30, 565, 800), "long source text " * 500, fontsize=6)
            elif index != 24:
                page.insert_text((40, 60), f"Synthetic page {index + 1}.")
        doc.save(source)
    library = Library(tmp_path / "library")
    paper = library.create({"title": "Synthetic cross-section retrieval"})
    paper = library.attach(paper["id"], str(source))
    yield library, paper, source
    library.close()


def call(fixture, action, **values):
    library, paper, _ = fixture
    return dispatch_request({"library": str(library.root), "id": paper["id"], "action": action, **values})


def test_search_then_read_distinguishes_background_from_method(fixture, monkeypatch):
    library, paper, original = fixture
    managed = library.pdf_path(paper["id"])
    hashes = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (original, managed)}
    def forbidden(*args, **kwargs):
        pytest.fail("Retrieval must not rasterize pages")
    monkeypatch.setattr(fitz.Page, "get_pixmap", forbidden)
    first = call(fixture, "paper_text_search", query="Word2Vec")
    assert [r["page"] for r in first["matches"]] == [1]
    assert first["next_page"] == 13 and not first["full_document_scanned"]
    second = call(fixture, "paper_text_search", query="Word2Vec", start_page=first["next_page"], expected_version=first["source_version"])
    assert [r["page"] for r in second["matches"]] == [22]
    evidence = call(fixture, "paper_text_read", pages=[21, 22], expected_version=second["source_version"])
    assert "reconstruction objective, not Word2Vec" in evidence["pages"][1]["text"]
    assert evidence["pages"][1]["complete_page"] and not evidence["full_document"]
    assert hashes == {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in hashes}


def test_read_continues_long_page_without_silent_loss(fixture):
    first = call(fixture, "paper_text_read", pages=[23])
    row = first["pages"][0]
    assert len(row["text"]) == 4000 and row["next_offset"] == 4000
    second = call(fixture, "paper_text_read", pages=[23], text_offset=row["next_offset"], expected_version=first["source_version"])
    assert second["pages"][0]["text_offset"] == 4000
    assert not second["pages"][0]["complete_page"]
    assert second["characters"] <= 4000


def test_blank_page_and_no_match_do_not_claim_full_document(fixture):
    result = call(fixture, "paper_text_search", query="not found", start_page=25)
    assert result["matches"] == [] and result["no_text_pages"] == [25]
    assert result["next_page"] is None and not result["full_document_scanned"]
    assert call(fixture, "paper_text_read", pages=[25])["pages"][0]["no_extractable_text"]


@pytest.mark.parametrize("action,args", [
    ("paper_text_search", {"query": ""}),
    ("paper_text_search", {"query": "x", "page_limit": 21}),
    ("paper_text_search", {"query": "x", "start_page": True}),
    ("paper_text_read", {"pages": [1, 2, 3, 4]}),
    ("paper_text_read", {"pages": [1, 1]}),
    ("paper_text_read", {"pages": [26]}),
    ("paper_text_read", {"pages": [True]}),
    ("paper_text_read", {"pages": [1, 2], "text_offset": 1}),
    ("paper_text_read", {"pages": [1], "text_offset": 100000}),
])
def test_invalid_requests_are_bounded(fixture, action, args):
    with pytest.raises(ValueError, match="PAPER_RETRIEVAL_INVALID"):
        call(fixture, action, **args)


def test_stale_pdf_version_is_visible(fixture):
    with pytest.raises(ValueError, match="PAPER_RETRIEVAL_CHANGED"):
        call(fixture, "paper_text_read", pages=[1], expected_version="old-version")


def test_visual_read_includes_image_only_table_and_crops_rotated_display(tmp_path):
    source = tmp_path / 'image-table.pdf'
    with fitz.open() as table:
        p = table.new_page(width=400, height=200)
        p.draw_rect(fitz.Rect(0, 0, 200, 200), color=None, fill=(1, 0, 0))
        p.draw_rect(fitz.Rect(200, 0, 400, 200), color=None, fill=(0, 0, 1))
        p.insert_text((30, 50), 'Area | 42', color=(1, 1, 1), fontsize=18)
        image = p.get_pixmap().tobytes('png')
    with fitz.open() as doc:
        p = doc.new_page(width=400, height=200)
        p.insert_image(p.rect, stream=image)
        # 大块批注不应遮挡提供给模型的原始图表。
        note = p.add_rect_annot(fitz.Rect(0, 0, 400, 200))
        note.set_colors(stroke=(0, 1, 0), fill=(0, 1, 0))
        note.update()
        p.set_rotation(90)
        doc.save(source)
    library = Library(tmp_path / 'library')
    try:
        paper = library.create({'title': 'Synthetic image-only table'})
        paper = library.attach(paper['id'], str(source))
        fixture = (library, paper, source)
        paths = [source, library.pdf_path(paper['id'])]
        before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
        text = call(fixture, 'paper_text_read', pages=[1])
        assert text['pages'][0]['no_extractable_text']
        full = call(fixture, 'paper_visual_read', page=1, expected_version=text['source_version'])
        assert full['source_kind'] == 'pdf-page-image' and full['page_rotation'] == 90
        assert full['height'] > full['width'] and full['full_page']
        crop = call(fixture, 'paper_visual_read', page=1, region=[0, .5, 1, 1], max_edge=1024)
        pix = fitz.Pixmap(base64.b64decode(crop['image']))
        assert pix.pixel(pix.width // 2, pix.height // 2) == (0, 0, 255)
        assert abs(pix.width - pix.height) <= 1 and max(pix.width, pix.height) <= 1024
        assert not crop['annotations_included'] and not crop['full_page']
        assert len(base64.b64decode(full['image'])) <= 2 * 1024 * 1024
        assert before == [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
    finally:
        library.close()


@pytest.mark.parametrize('values', [
    {'page': 0}, {'page': True}, {'page': 26}, {'page': 1, 'max_edge': 2049},
    {'page': 1, 'region': [0, 0, 1]}, {'page': 1, 'region': [0, 0, 2, 1]},
    {'page': 1, 'region': [0, 0, float('nan'), 1]}, {'page': 1, 'region': [1, 0, 0, 1]},
])
def test_visual_read_rejects_invalid_ranges_before_render(fixture, values, monkeypatch):
    monkeypatch.setattr(fitz.Page, 'get_pixmap', lambda *a, **kw: pytest.fail('Invalid visual request rendered'))
    with pytest.raises(ValueError, match='PAPER_RETRIEVAL_INVALID'):
        call(fixture, 'paper_visual_read', **values)


def test_visual_read_respects_version_and_preflight(fixture, monkeypatch):
    with pytest.raises(ValueError, match='PAPER_RETRIEVAL_CHANGED'):
        call(fixture, 'paper_visual_read', page=1, expected_version='stale')
    monkeypatch.setattr(fitz.Page, 'get_pixmap', lambda *a, **kw: pytest.fail('Oversized input rendered'))
    monkeypatch.setattr(fitz.Page, 'get_images', lambda *a, **kw: [(1, 0, 100000, 100000)])
    with pytest.raises(ValueError, match='像素超过预算'):
        call(fixture, 'paper_visual_read', page=1)


def test_pdf_typography_search_normalization():
    assert normalized("adapt\u00ading NLP\ntechniques") == "adapting nlp techniques"
    assert normalized("reconstruc-\ntion  objective") == "reconstruction objective"
