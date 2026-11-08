"""合成矩形的视觉描述原生保存、来源版本与可携带性。"""
import hashlib
import pymupdf as fitz
import pytest
from dsh_paper_library.core import Library


def prepare(tmp_path):
    source = tmp_path / 'source.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=500, height=600)
        page.draw_rect(fitz.Rect(100, 100, 250, 220), fill=(1, 0, 0))
        doc.save(source)
    library = Library(tmp_path / 'library')
    paper = library.import_items(path=str(source))['items'][0]
    note = library.annotate(paper['id'], page=1, type='square', rects=[[90, 90, 260, 230]])['annotation']
    return library, paper['id'], note['id'], source


def test_caption_is_one_portable_reply_and_unrelated_annotations_keep_version(tmp_path):
    library, paper, note, source = prepare(tmp_path)
    try:
        original = hashlib.sha256(source.read_bytes()).hexdigest()
        preview = library.annotation_preview(paper, note, 1, render_width=640)
        version = preview['source_version']
        assert not library.annotation_caption_result(paper, note, 1, version)['saved']
        result = library.annotation_caption_result(paper, note, 1, version, '一个红色矩形。', 'synthetic/vision')
        reply = result['annotation']
        assert reply['source_kind'] == 'annotation-caption' and reply['reply_to'] == note
        assert reply['comment'].startswith('图像描述：一个红色矩形。')
        library.annotate(paper, page=1, type='note', comment='Unrelated note')
        assert library.annotation_preview(paper, note, 1, render_width=640)['source_version'] == version
        again = library.annotation_caption_result(paper, note, 1, version, 'Must not duplicate', 'other/model')
        assert again['duplicate'] and again['annotation']['id'] == reply['id']
        exported = tmp_path / 'export.pdf'
        exported.write_bytes(library.pdf_path(paper).read_bytes())
        with fitz.open(exported) as doc:
            annotations = list(doc[0].annots())
            assert len(annotations) == 3
        second = Library(tmp_path / 'second')
        try:
            imported = second.import_items(path=str(exported))['items'][0]
            restored = second.annotation_caption_result(imported['id'], note, 1, version)
            assert restored['duplicate'] and restored['annotation']['reply_to'] == note
        finally:
            second.close()
        assert hashlib.sha256(source.read_bytes()).hexdigest() == original
    finally:
        library.close()


def test_remarks_preserve_caption_but_changed_geometry_or_pixels_reject_stale_caption(tmp_path):
    library, paper, note, _ = prepare(tmp_path)
    try:
        version = library.annotation_preview(paper, note, 1, render_width=640)['source_version']
        library.annotation_update(paper, note, 'New remark ' * 900)
        assert library.annotation_preview(paper, note, 1, render_width=640)['source_version'] == version
        for change in ['geometry', 'pixels']:
            version = library.annotation_preview(paper, note, 1, render_width=640)['source_version']
            def mutate(doc):
                page = doc[0]
                if change == 'geometry':
                    annot = next(page.annots()); annot.set_rect(fitz.Rect(85, 85, 280, 240)); annot.update()
                else:
                    page.draw_rect(fitz.Rect(110, 110, 180, 180), fill=(0, 0, 1))
            library._write_pdf(paper, mutate)
            with pytest.raises(ValueError, match='ANNOTATION_STALE'):
                library.annotation_caption_result(paper, note, 1, version, 'Stale output')
        assert len(library.annotations(paper)['annotations']) == 1
    finally:
        library.close()
