"""只用合成 PDF：原生样式、保存/重开、像素虚线、无文字匹配和旧标注保护。"""
import hashlib
import pymupdf as fitz
import pytest
from dsh_paper_library.ai_annotation_style import AI_RGB, native_style, apply_ai_reading_style
from dsh_paper_library.core import dispatch


def call(tmp, action, **kwargs):
    return dispatch({"library": str(tmp / 'library'), "action": action, **kwargs})


def synthetic(path):
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        page.insert_text((40, 60), 'Synthetic evidence for native reading marks.')
        old = page.add_underline_annot(fitz.Rect(40, 95, 300, 110))
        old.set_info(title='AI 自主阅读', content='ai-reading markers cannot grant a match')
        old.set_colors(stroke=AI_RGB); old.update()
        doc.save(path)


@pytest.mark.parametrize('kind,expected', [('highlight','underline'), ('underline','underline'), ('strikeout','strikeout'), ('square','square'), ('ink','ink'), ('note','square')])
def test_ai_writer_roundtrip_and_existing_preserved(tmp_path, kind, expected):
    source = tmp_path / 'source.pdf'; synthetic(source)
    original = source.read_bytes()
    item = call(tmp_path, 'import', path=str(source))['items'][0]
    params = dict(id=item['id'], page=1, type=kind, rects=[[40,45,300,65]],
                  paths=[[[40, 80], [300, 80]]], comment='reading explanation',
                  author='ordinary name', annotation_profile='ai-reading', annotation_id='a'*32)
    saved = call(tmp_path, 'annotate', **params)['annotation']
    assert saved['type'] == expected and saved['ai_reading_style'] is True
    assert saved['native_style']['dashes'] == [3,2]
    assert saved['color']['stroke'] == pytest.approx(AI_RGB)
    assert call(tmp_path, 'annotate', **params)['duplicate']
    reply = call(tmp_path, 'annotation_reply_create', id=item['id'], annotation_id=saved['id'], reply_id='b'*32, comment='human follow-up')['annotation']
    call(tmp_path, 'annotation_update', id=item['id'], annotation_id=saved['id'], comment='updated explanation')
    recovered = call(tmp_path, 'annotations', id=item['id'])['annotations']
    assert next(a for a in recovered if a['id'] == saved['id'])['ai_reading_style'] is True
    assert next(a for a in recovered if a['author'] == 'AI 自主阅读')['ai_reading_style'] is False
    selected = call(tmp_path, 'annotations', id=item['id'], ai_reading_only=True)['annotations']
    assert {a['id'] for a in selected} == {saved['id'], reply['id']}
    with fitz.open(call(tmp_path, 'export_pdf', id=item['id'])['path']) as doc:
        page=doc[0]; annot=next(a for a in page.annots() if a.info['id']==saved['id'])
        assert doc.xref_get_key(annot.xref,'BS/S')[1] == '/D'
        assert doc.xref_get_key(annot.xref,'BS/D')[1] == '[3 2]'
        stream=doc.xref_stream(int(doc.xref_get_key(annot.xref,'AP/N')[1].split()[0]))
        assert b'[3.0 2.0] 0 d' in stream and b'1.1 w' in stream
        pix=page.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False)
        assert any(b>r+80 and b>g+50 for r,g,b in zip(pix.samples[::3],pix.samples[1::3],pix.samples[2::3]))
    assert source.read_bytes() == original


@pytest.mark.parametrize('border,expected', [
    ('<< /S /D /D [3 2] /W 1 >>',True),
    ('<< /S /D /D [6 3] >>',True),
    ('<< /S /D >>',True), # Standard default dash [3], repeated for odd array.
    ('<< /S /D /D [1 3] >>',False),
    ('<< /S /D /D [3 0] >>',False),
    ('<< /S /D /D [0 3] >>',False),
    ('<< /S /D /D [-3 2] >>',False),
    ('<< /S /D /D [3 2] /W 0 >>',False),
    ('<< /S /D /D [3 2] /W (1) >>',False),
    ('<< /S /S /D [3 2] >>',False),
    ('<< /D [3 2] >>',False),
    ('<< /S /D /D [] >>',False),
])
def test_standard_bs_and_false_positives(border,expected):
    doc=fitz.open();page=doc.new_page();annot=page.add_underline_annot(fitz.Rect(30,30,130,50))
    annot.set_colors(stroke=AI_RGB);annot.update();doc.xref_set_key(annot.xref,'BS',border)
    assert native_style(annot)['ai_reading_style'] is expected
    doc.close()


@pytest.mark.parametrize('mode', ['legacy','indirect','cmyk','rounded'])
def test_external_standard_variants_survive_serialization(mode):
    doc=fitz.open();page=doc.new_page();annot=page.add_line_annot((30,30),(160,30));apply_ai_reading_style(doc,annot)
    if mode=='legacy':
        doc.xref_set_key(annot.xref,'BS','null');doc.xref_set_key(annot.xref,'Border','[0 0 1 [3 2]]')
    elif mode=='indirect':
        xref=doc.get_new_xref();doc.update_object(xref,'<< /S /D /D [3 2] /W 1 >>');doc.xref_set_key(annot.xref,'BS',f'{xref} 0 R')
        color=doc.get_new_xref();doc.update_object(color,'[0.184314 0.501961 0.929412]');doc.xref_set_key(annot.xref,'C',f'{color} 0 R')
    elif mode=='cmyk':
        doc.xref_set_key(annot.xref,'C','[0.815686 0.498039 0.070588 0]')
    else:
        doc.xref_set_key(annot.xref,'C','[0.19 0.50 0.93]')
    with fitz.open(stream=doc.tobytes(),filetype='pdf') as reopened:
        p=reopened[0];a=next(p.annots());assert native_style(a)['ai_reading_style'] is True
    doc.close()


def test_color_type_and_appearance_only_are_not_guessed():
    doc=fitz.open();page=doc.new_page();annot=page.add_underline_annot(fitz.Rect(30,30,130,50));apply_ai_reading_style(doc,annot)
    doc.xref_set_key(annot.xref,'C','[0.2 0.5 0.93]');assert not native_style(annot)['ai_reading_style']
    doc.xref_set_key(annot.xref,'C','[0.5]');assert not native_style(annot)['ai_reading_style']
    annot.set_colors(stroke=AI_RGB);doc.xref_set_key(annot.xref,'BS','null');doc.xref_set_key(annot.xref,'Border','null')
    assert not native_style(annot)['ai_reading_style'] # Custom AP alone is deliberately not inferred.
    for a in [page.add_highlight_annot(fitz.Rect(30,60,130,80)),page.add_text_annot((30,90),'AI reading')]:
        a.set_colors(stroke=AI_RGB);doc.xref_set_key(a.xref,'BS','<< /S /D /D [3 2] >>')
        assert not native_style(a)['ai_reading_style']
    doc.close()


def test_dashed_visible_gaps_after_reopen(tmp_path):
    doc=fitz.open();page=doc.new_page(width=320,height=120)
    page.insert_text((30,25),'Synthetic PDF: dashed blue vs solid blue')
    a=page.add_line_annot((30,50),(290,50));apply_ai_reading_style(doc,a)
    b=page.add_line_annot((30,80),(290,80));b.set_colors(stroke=AI_RGB);b.set_border(width=1.1);b.update()
    target=tmp_path/'dash.pdf';doc.save(target);doc.close()
    with fitz.open(target) as reopened:
        pix=reopened[0].get_pixmap(matrix=fitz.Matrix(3,3),alpha=False)
        def row(y):
            return [pix.pixel(x,y)[2]>pix.pixel(x,y)[0]+80 for x in range(100,860)]
        dashed,solid=row(150),row(240)
        assert 0.4 < sum(dashed)/len(dashed) < 0.8
        assert sum(solid)/len(solid)>0.98
        assert sum(a!=b for a,b in zip(dashed,dashed[1:]))>60


def test_bad_filter_rejected_before_pdf(tmp_path):
    with pytest.raises(ValueError,match='boolean'):
        call(tmp_path,'annotations',id='absent',ai_reading_only='true')


def test_reselect_and_portable_import_keep_style(tmp_path):
    source=tmp_path/'source.pdf';synthetic(source)
    item=call(tmp_path,'import',path=str(source))['items'][0]
    note=call(tmp_path,'annotate',id=item['id'],page=1,type='highlight',rects=[[40,45,180,65]],text='Synthetic',annotation_profile='ai-reading')['annotation']
    edited=call(tmp_path,'annotation_reselect',id=item['id'],annotation_id=note['id'],page=1,rects=[[40,45,300,65]],text='Synthetic evidence',expected_version=note['edit_version'])['annotation']
    assert edited['id']==note['id'] and edited['ai_reading_style'] is True
    exported=call(tmp_path,'export_pdf',id=item['id'])['path']
    fresh={'library':str(tmp_path/'fresh')}
    portable=dispatch({**fresh,'action':'import','path':exported})['items'][0]
    recovered=dispatch({**fresh,'action':'annotations','id':portable['id'],'ai_reading_only':True})['annotations']
    assert len(recovered)==1 and recovered[0]['id']==note['id']
    assert recovered[0]['native_style']['dashes']==[3,2]


def test_indirect_zero_width_is_not_a_visible_dash():
    doc=fitz.open();page=doc.new_page();annot=page.add_line_annot((30,30),(160,30));apply_ai_reading_style(doc,annot)
    xref=doc.get_new_xref();doc.update_object(xref,'0');doc.xref_set_key(annot.xref,'BS/W',f'{xref} 0 R')
    assert native_style(annot)['ai_reading_style'] is False
    doc.close()
