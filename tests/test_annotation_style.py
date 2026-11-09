"""仅用合成 PDF 验证样式写回、原件保护和并发备注。"""
import hashlib
import pymupdf as fitz
import pytest
from dsh_paper_library.core import dispatch


def call(root, action, **args):
    return dispatch({"library": str(root / "library"), "action": action, **args})


def blue_pixels(page):
    pixels = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).samples
    return sum(b > r + 60 and b > g + 30 for r, g, b in zip(pixels[::3], pixels[1::3], pixels[2::3]))


@pytest.mark.parametrize('kind', ['underline', 'strikeout', 'square', 'ink', 'highlight', 'note'])
def test_native_style_roundtrip_and_comment_preservation(tmp_path, kind):
    source = tmp_path / 'synthetic.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=400)
        page.insert_text((40, 80), 'Synthetic annotation example')
        page.add_text_annot((10, 10), 'External note')
        doc.save(source)
    original = hashlib.sha256(source.read_bytes()).hexdigest()
    item = call(tmp_path, 'import', path=str(source))['items'][0]
    note = call(tmp_path, 'annotate', id=item['id'], page=1, type=kind,
                rects=[[40, 65, 170, 85]], paths=[[[40, 95], [100, 110]]], comment='original')['annotation']
    # 备注并发保存不应被样式操作覆盖。
    call(tmp_path, 'annotation_update', id=item['id'], annotation_id=note['id'], comment='new comment')
    supports_line = kind in {'underline', 'strikeout', 'square', 'ink'}
    request = dict(id=item['id'], annotation_id=note['id'], color='#447dc4', expected_version=note['style_version'])
    if supports_line:
        request['line_style'] = 'dashed'
    saved = call(tmp_path, 'annotation_style', **request)['annotation']
    assert saved['comment'] == 'new comment'
    assert saved['color']['stroke'] == pytest.approx([68/255, 125/255, 196/255])
    assert saved['line_style'] == ('dashed' if supports_line else 'solid')
    assert saved['id'] == note['id']
    assert call(tmp_path, 'annotation_style', **request)['duplicate']
    with pytest.raises(ValueError, match='STALE'):
        call(tmp_path, 'annotation_style', **{**request, 'color': '#df718b'})
    call(tmp_path, 'annotation_update', id=item['id'], annotation_id=note['id'], comment='after style')
    path = call(tmp_path, 'export_pdf', id=item['id'])['path']
    with fitz.open(path) as doc:
        page = doc[0]
        annotation = next(a for a in page.annots() if a.info['id'] == note['id'])
        assert annotation.info['content'] == 'after style'
        assert any(a.info['content'] == 'External note' for a in page.annots())
        if supports_line:
            dashed_pixels = blue_pixels(page)
            assert doc.xref_get_key(annotation.xref, 'BS/D')[1] in {'[6 3]', '[6.0 3.0]'}
            stream = doc.xref_stream(int(doc.xref_get_key(annotation.xref, 'AP/N')[1].split()[0]))
            assert b'[6.0 3.0] 0 d' in stream
    current = next(a for a in call(tmp_path, 'annotations', id=item['id'])['annotations'] if a['id'] == note['id'])
    if supports_line:
        for style in ['dotted', 'solid']:
            current = call(tmp_path, 'annotation_style', **{**request, 'expected_version': current['style_version'], 'line_style': style})['annotation']
            assert current['line_style'] == style
        with fitz.open(path) as doc:
            # 检查实际 PDF 栅格有间断，而不只检查字典声明。
            assert dashed_pixels > 0
            assert blue_pixels(doc[0]) > dashed_pixels * 1.1
    else:
        with pytest.raises(ValueError, match='仅支持'):
            call(tmp_path, 'annotation_style', **{**request, 'expected_version': current['style_version'], 'line_style': 'dashed'})
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original


def test_style_rejects_invalid_input_before_opening_pdf(tmp_path):
    for color, style, version in [('red', 'solid', 'a'*64), ('#112233','invalid','a'*64), ('#112233','solid', None)]:
        with pytest.raises(ValueError):
            call(tmp_path,'annotation_style',id='synthetic-missing',annotation_id='absent',color=color,line_style=style,expected_version=version)
