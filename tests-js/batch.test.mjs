import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatch } from '../src/bridge.mjs';

test('uploaded metadata continues after record100 and whole-library BibLaTeX exports all records',async()=>{
  const library=await mkdtemp(join(tmpdir(),'paper-batch-'));
  try {
    const items=Array.from({length:130},(_,i)=>({id:`Batch${i}`,title:`Synthetic batch paper ${i}`,type:'article-journal',author:[{family:'Example',given:'Test'}],issued:{'date-parts':[[2026]]}}));
    const request={action:'import',filename:'test.json',content_base64:Buffer.from(JSON.stringify(items)).toString('base64')};
    const first=await dispatch(request,{library});
    assert.equal(first.imported,100);assert.equal(first.done,false);assert.equal(first.next_offset,100);
    const second=await dispatch({...request,offset:first.next_offset},{library});
    assert.equal(second.imported,30);assert.equal(second.done,true);
    const all=await dispatch({action:'export_library',format:'biblatex'},{library});
    assert.equal(all.count,130);
    assert.equal((all.text.match(/@article\{/g)||[]).length,130);
    assert.match(all.text,/@article\{Batch129,/);
    const snapshot=await dispatch({action:'export_library',format:'csl-json'},{library});
    assert.equal(JSON.parse(snapshot.text).length,130);
  } finally { await rm(library,{recursive:true,force:true}); }
});
