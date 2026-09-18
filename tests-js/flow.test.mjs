import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, projectRoot } from '../src/bridge.mjs';

test('reading, native annotation, AI feedback and portable PDF reimport',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'paper-flow-'));
  try {
    const fixtures=join(dir,'source');
    const result=spawnSync(join(projectRoot,'.venv/bin/python'),['scripts/create-demo.py','--output',fixtures],{cwd:projectRoot,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const options={library:join(dir,'library')};
    const imported=await dispatch({action:'import',path:join(fixtures,'zotero-export.json')},options);
    const id=imported.items[0].id;
    const page=await dispatch({action:'page',id,page:1},options);
    assert.ok(page.image.length>1000);
    const word=page.words.find(w=>w[4]==='evidence.');
    assert.ok(word);
    const saved=await dispatch({action:'annotate',id,page:1,type:'highlight',rects:[word.slice(0,4)],text:word[4],comment:'What is the supporting evidence?'},options);
    let calls=0;
    const modelOptions={...options,provider:'fallback-provider',model:'fallback-model',ai:async({prompt,provider,model,reasoningEffort})=>{
      calls++;assert.equal(provider,'current-provider');assert.equal(model,'current-model');assert.equal(reasoningEffort,'high');assert.match(prompt,/SOURCE_DATA/);assert.match(prompt,/What is the supporting evidence/);return 'TEST MODEL RESPONSE: inspect the stated comparison. Source: selected annotation on page 1.';
    }};
    const feedback=await dispatch({action:'ai_feedback',id,annotation_ids:[saved.annotation.id],provider:'current-provider',model:'current-model',reasoning_effort:'high',session_id:'test-session'},modelOptions);
    assert.equal(calls,1);
    assert.equal(feedback.kind,'ai-feedback');
    const pdf=await dispatch({action:'export_pdf',id},options);
    const copied=join(dir,'copied.pdf');await copyFile(pdf.path,copied);
    const recovered=await dispatch({action:'import',path:copied},{library:join(dir,'fresh')});
    assert.equal(recovered.items[0].citekey,imported.items[0].citekey);
    const annotations=await dispatch({action:'annotations',id:recovered.items[0].id},{library:join(dir,'fresh')});
    assert.ok(annotations.annotations.some(a=>a.comment==='What is the supporting evidence?'));
    assert.ok(annotations.annotations.some(a=>a.kind==='ai-feedback'));
    const staleOptions={...modelOptions,ai:async()=>{
      await dispatch({action:'annotation_update',id,annotation_id:saved.annotation.id,comment:'Revised question'},options);
      return 'This was based on old context';
    }};
    await assert.rejects(dispatch({action:'ai_feedback',id,annotation_ids:[saved.annotation.id]},staleOptions),/批注发生变化/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('multi-annotation feedback is written back per annotation, never copied',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'paper-feedback-'));
  try {
    const fixtures=join(dir,'source');
    const created=spawnSync(join(projectRoot,'.venv/bin/python'),['scripts/create-demo.py','--output',fixtures],{cwd:projectRoot,encoding:'utf8'});
    assert.equal(created.status,0,created.stderr);
    const options={library:join(dir,'library')};
    const imported=await dispatch({action:'import',path:join(fixtures,'zotero-export.json')},options);
    const id=imported.items[0].id;
    const page=await dispatch({action:'page',id,page:1},options);
    const words=page.words.filter(word=>typeof word[4]==='string'&&word[4].trim().length>4).slice(0,2);
    const first=await dispatch({action:'annotate',id,page:1,type:'highlight',rects:[words[0].slice(0,4)],text:words[0][4],comment:'第一条问题'},options);
    const second=await dispatch({action:'annotate',id,page:1,type:'highlight',rects:[words[1].slice(0,4)],text:words[1][4],comment:'第二条问题'},options);
    const ids=[first.annotation.id,second.annotation.id];
    const replies={replies:[{annotation_id:ids[0],comment:'只回答第一条。'},{annotation_id:ids[1],comment:'只回答第二条。'}]};
    let calls=0;
    const modelOptions={...options,ai:async({prompt})=>{calls++;assert.match(prompt,/one entry per provided annotation id/);assert.ok(prompt.includes(ids[0])&&prompt.includes(ids[1]),'Both annotation ids are in the prompt');return JSON.stringify(replies);}};
    const saved=await dispatch({action:'ai_feedback',id,annotation_ids:ids,provider:'current-provider',model:'current-model'},modelOptions);
    assert.equal(calls,1);
    assert.equal(saved.split,true);
    assert.deepEqual(saved.replies.map(reply=>reply.annotation_id),ids);
    assert.deepEqual(saved.replies.map(reply=>reply.text),['只回答第一条。','只回答第二条。']);
    const annotations=(await dispatch({action:'annotations',id},options)).annotations;
    for(const reply of saved.replies){
      const notes=annotations.filter(note=>note.kind==='ai-feedback'&&note.reply_to===reply.annotation_id);
      assert.equal(notes.length,1,`Exactly one reply under ${reply.annotation_id}`);
      assert.ok(notes[0].comment.includes(reply.text));
    }
    for(const [index,note] of saved.replies.entries()){
      const other=annotations.find(candidate=>candidate.kind==='ai-feedback'&&candidate.reply_to===ids[1-index]);
      assert.ok(!note.text.includes(other.comment.split('\n\n').at(-1)),'One answer never contains the other');
    }
    // A model that ignores the JSON contract must not have its answer copied.
    const combinedOptions={...options,ai:async()=>'One combined answer for both annotations.'};
    const combined=await dispatch({action:'ai_feedback',id,annotation_ids:ids,provider:'current-provider',model:'current-model'},combinedOptions);
    assert.equal(combined.combined,true);
    assert.equal(combined.annotation_ids.length,2);
    assert.match(combined.warnings.join(' '),/没有复制到每条批注/);
    const after=(await dispatch({action:'annotations',id},options)).annotations.filter(note=>note.kind==='ai-feedback');
    assert.equal(after.length,3,'The combined answer is one note, not one per annotation');
    assert.equal(after.filter(note=>note.annotation_ids.length>1).length,1);
    // A reply that cites an unknown annotation is refused before any write.
    const forgedOptions={...options,ai:async()=>JSON.stringify({replies:[{annotation_id:'forged-note',comment:'x'}]})};
    await assert.rejects(dispatch({action:'ai_feedback',id,annotation_ids:ids,provider:'current-provider',model:'current-model'},forgedOptions),/未提供的批注/);
    const refused=(await dispatch({action:'annotations',id},options)).annotations.filter(note=>note.kind==='ai-feedback');
    assert.equal(refused.length,3,'A refused generation writes nothing');
  } finally {await rm(dir,{recursive:true,force:true});}
});
