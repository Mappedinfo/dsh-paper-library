import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { core, dispatch } from '../src/bridge.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { createLanguageLearning } from '../src/harness/language-learning.mjs'
import { createAnnotationTranslation } from '../src/harness/annotation-translation.mjs'

// 合成外部 PDF：内嵌文献便笺和普通下划线；不读取用户资料库。
test('external notes and underlines translate without catalog page counts, including an old failed attempt', async t => {
  const root=await mkdtemp(join(tmpdir(),'translation-external-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const python=resolve('.venv/bin/python'), source=join(root,'source','synthetic.pdf'), library=join(root,'library')
  execFileSync(python,['-c',`import sys,pathlib,pymupdf
p=pathlib.Path(sys.argv[1]);p.parent.mkdir()
with pymupdf.open() as d:
 page=d.new_page();page.insert_text((60,70),'The estimate remains uncertain.')
 page.add_underline_annot(page.search_for('The estimate remains uncertain.')).update()
 page.add_text_annot((60,100),'This PDF embeds 1 Zotero item note(s). Open zotero-notes.html.\\n\\nMore observations are needed.').update()
 d.embfile_add('zotero-notes.html',b'<p>More observations are needed.</p>');d.save(p)
`,source])
  const original=await readFile(source), options={library,python}
  await core({action:'external_scan',sources:[{id:'synthetic',root:join(root,'source')}]},options)
  const item=(await core({action:'list'},options)).items[0];assert.equal(item.pdf,true);assert.equal(item.page_count,undefined)
  const notes=(await core({action:'annotations',id:item.id},options)).annotations;assert.deepEqual(notes.map(n=>n.type).sort(),['note','underline'])
  const store=createLocalStateStore({library,home:join(root,'home')});let calls=0, emulateOldPageFailure=true
  const languageOptions={...options,store,getDefaultModel:()=>({provider:'synthetic',model:'fixture'}),dispatch:async(req,opts)=>{
    if(emulateOldPageFailure&&req.action==='page_layout')throw Error('选文页码超出当前论文 PDF。')
    return dispatch(req,opts)
  },ai:async()=>{calls++;return JSON.stringify({result:'估计仍有不确定性，需要更多观测。',explanation:'',vocabulary:[]})}}
  let translate=createAnnotationTranslation({...options,store,dispatch,languageLearning:createLanguageLearning(languageOptions)})
  const input=note=>({id:item.id,annotation_id:note.id,version:note.version})
  await assert.rejects(translate(input(notes[0])),/页码/);assert.equal(calls,0)
  emulateOldPageFailure=false
  // 模拟刷新/热重载：客户端没有 retry 标志，也能恢复旧的明确失败请求。
  translate=createAnnotationTranslation({...options,store,dispatch,languageLearning:createLanguageLearning(languageOptions)})
  for(const note of notes){assert.ok((await translate(input(note))).saved);assert.equal((await translate(input(note))).duplicate,true)}
  assert.equal(calls,2)
  const result=await core({action:'annotations',id:item.id},options)
  const replies=result.annotations.filter(n=>n.source_kind==='annotation-translation')
  assert.equal(replies.length,2);assert.deepEqual(replies.map(n=>n.reply_to).sort(),notes.map(n=>n.id).sort())
  assert.ok(replies.every(n=>n.comment.startsWith('翻译：')))
  assert.deepEqual(await readFile(source),original,'external original stays byte-identical')
  assert.equal((await core({action:'get',id:item.id},options)).page_count,undefined,'no catalog rewrite required')
})
