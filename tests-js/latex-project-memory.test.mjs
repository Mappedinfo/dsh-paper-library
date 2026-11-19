import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createLocalStateStore} from '../src/local-state.mjs'
import {createLatexProjectMemory} from '../src/latex-project-memory.mjs'
import {createFetchHandler} from '../src/http.mjs'
const session=(id='one',extra={})=>({action:'latex_memory_save',id,title:'Synthetic project '+id,root:'/synthetic/manuscript',binding_generation:0,path:'sections/intro.tex',revision:'original-revision',selection_start:12,selection_end:20,line:2,column:3,scroll_top:50,pdf_page:3,zoom:1.5,layout:'split',...extra})
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'latex-project-memory-'));t.after(()=>rm(root,{recursive:true,force:true}));const options={library:join(root,'library'),home:join(root,'home')},store=createLocalStateStore(options);return{options,store,memory:createLatexProjectMemory({store})}}

test('favorites merge concurrent changes, survive reload and never remove writing records',async t=>{
 const f=await fixture(t);await Promise.all(['one','two'].map(id=>f.memory({action:'latex_favorite_set',id,title:id,favorite:true})));
 await f.memory(session());const before=await f.memory({action:'latex_memory_get',id:'one'});assert.equal(before.favorites.length,2);
 const reopened=createLatexProjectMemory({store:createLocalStateStore(f.options)});await reopened({action:'latex_favorite_set',id:'one',favorite:false});
 const after=await reopened({action:'latex_memory_get',id:'one'});assert.deepEqual(after.favorites.map(item=>item.id),['two']);assert.deepEqual(after.session,before.session);assert.equal(after.last_project,'one');
})

test('resume records are per project, contain no source body and retain the last actual save time',async t=>{
 const f=await fixture(t);const first=await f.memory(session('one',{source_saved:true,content:'must not be stored'}));assert.ok(first.session.saved_at);
 const moved=await f.memory(session('one',{selection_start:33,selection_end:33}));assert.equal(moved.session.saved_at,first.session.saved_at);assert.equal(moved.session.content,undefined);
 await f.memory(session('two',{path:'main.tex',pdf_page:1}));assert.equal((await f.memory({action:'latex_memory_get'})).last_project,'two');
 const reopened=createLatexProjectMemory({store:createLocalStateStore(f.options)});assert.equal((await reopened({action:'latex_memory_get',id:'one'})).session.selection_start,33);
 const rebound=await reopened(session('one',{root:'/synthetic/new-folder',binding_generation:1}));assert.equal(rebound.session.saved_at,null);
})

test('resume metadata rejects traversal, invalid positions and oversized or arbitrary payload fields',async t=>{
 const f=await fixture(t);
 for(const extra of [{id:'../secret'},{path:'../secret.tex'},{path:'/secret.tex'},{path:'nested/../secret.tex'},{selection_start:-1},{pdf_page:0},{zoom:99},{root:'x'.repeat(4097)},{layout:'script'},{pane_order:'arbitrary'},{editor_mode:'html'}])await assert.rejects(f.memory(session('one',extra)),{code:'LATEX_MEMORY_INVALID'});
 assert.deepEqual((await f.memory({action:'latex_memory_get'})).recent,[]);
})

test('editor mode and source/PDF placement survive reopening independently of source contents',async t=>{
 const f=await fixture(t);await f.memory(session('one',{pane_order:'pdf-first',editor_mode:'visual'}));
 const reopened=createLatexProjectMemory({store:createLocalStateStore(f.options)}),state=await reopened({action:'latex_memory_get',id:'one'});
 assert.equal(state.session.pane_order,'pdf-first');assert.equal(state.session.editor_mode,'visual');assert.equal(state.session.path,'sections/intro.tex');
 const legacy=await f.memory(session('two'));assert.equal(legacy.session.pane_order,'source-first');assert.equal(legacy.session.editor_mode,'source');
})

test('recent project index is bounded without evicting saved project positions or favorites',async t=>{
 const f=await fixture(t);await f.memory({action:'latex_favorite_set',id:'keep',title:'Keep',favorite:true});
 for(let i=0;i<52;i++)await f.memory(session('p'+i));
 const state=await f.memory({action:'latex_memory_get',id:'p0'});assert.equal(state.recent.length,50);assert.equal(state.last_project,'p51');assert.equal(state.favorites[0].id,'keep');assert.equal(state.session.path,'sections/intro.tex');
})

test('HTTP memory actions preserve origin checks and share the existing private state store',async t=>{
 const f=await fixture(t);const handler=createFetchHandler({library:f.options.library,localState:f.store});
 const call=(input,origin='http://localhost')=>handler(new Request('http://localhost/api',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)}));
 const favorite={action:'latex_favorite_set',id:'one',title:'Synthetic',favorite:true};assert.equal((await call(favorite,'https://evil.invalid')).status,403);assert.equal((await call(favorite)).status,200);
 assert.equal((await call(session())).status,200);assert.equal((await call(session('one',{path:'../secret'}))).status,400);
 const state=await(await call({action:'latex_memory_get',id:'one'})).json();assert.equal(state.result.session.path,'sections/intro.tex');assert.equal(state.result.favorites[0].id,'one');
})

test('project metadata never appears as a paper reading-history identifier',async t=>{
 const f=await fixture(t);await f.memory(session());await f.memory({action:'latex_favorite_set',id:'one',favorite:true});assert.deepEqual(await f.store.recentReaderIds(),[]);
})
