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
