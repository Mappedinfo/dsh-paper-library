import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStateStore } from '../src/local-state.mjs'
import { createEncyclopedia } from '../src/encyclopedia.mjs'
test('encyclopedia persists aliases, cross-paper sources and human authorship with revision conflicts',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wiki-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createLocalStateStore({library:directory,home:join(directory,'home')});
 const dispatch=async input=>({id:input.id,title:`Synthetic ${input.id}`});
 const wiki=createEncyclopedia({store,dispatch,library:directory});
 const draft={action:'encyclopedia_put',term:'Urban green spaces',kind:'concept',aliases:['UGS'],definition:'## 定义\n城市内的绿色空间，参见 [[公园]]。',expected_revision:0,source:{paper_id:'synthetic-a',page:1,quote:'Urban green spaces (UGS)'}};
 const first=await wiki(draft);assert.equal(first.author,'user');assert.equal(first.sources[0].title,'Synthetic synthetic-a');
 assert.equal((await wiki({action:'encyclopedia_list',query:'UGS'})).items[0].id,first.id);
 assert.equal((await wiki({action:'encyclopedia_list',query:'Urban green spaces (UGS)'})).total,1);
 await assert.rejects(wiki({...draft,definition:'stale'}),/词条已更新/);
 const second=await wiki({...draft,expected_revision:first.revision,source:{paper_id:'synthetic-b',page:2,quote:'A second occurrence'}});
 assert.equal(second.sources.length,2);
 const third=await wiki({...draft,expected_revision:second.revision});assert.equal(third.sources.length,2);
 const reopened=createEncyclopedia({store:createLocalStateStore({library:directory,home:join(directory,'home')}),dispatch,library:directory});
 assert.equal((await reopened({action:'encyclopedia_list'})).items[0].definition,draft.definition);
 await assert.rejects(wiki({...draft,expected_revision:third.revision,source:{paper_id:'../private',page:1,quote:'x'}}),/来源无效/);
 await assert.rejects(wiki({...draft,expected_revision:third.revision,kind:'invented'}),/类型无效/);
});
