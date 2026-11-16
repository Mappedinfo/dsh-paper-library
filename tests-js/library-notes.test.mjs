import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';

const require = createRequire(import.meta.url), { JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom');
const source = await readFile(new URL('../web/workspace-navigation.js', import.meta.url),'utf8');
const tick = () => new Promise(resolve=>setImmediate(resolve));

test('the normal library route serves the notes screen and forwards the notes API',async t=>{
  const library=await mkdtemp(join(tmpdir(),'paper-notes-ui-'));
  t.after(()=>rm(library,{recursive:true,force:true}));
  const handler=createFetchHandler({library,localStateHome:join(library,'state')});
  const html=await handler(new Request('http://localhost/'));
  assert.match(await html.text(),/src="\.\/workspace-navigation\.js"/);
  for(const file of ['workspace-navigation.js','workbench.css'])assert.equal((await handler(new Request('http://localhost/'+file))).status,200);
  for(const prepare of [false,true]){
    const response=await handler(new Request('http://localhost/api',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'annotation_favorites_list',view:'notes',prepare})}));
    const data=await response.json();
    assert.equal(response.status,200,JSON.stringify(data));
    assert.equal(data.result.coverage?.documents??data.result.documents,0);
  }
});

test('notes preserve the two views, scope/search controls and read-only star badges',async t=>{
  const dom = new JSDOM('<section id="notes"></section>',{runScripts:'outside-only'}), win = dom.window;
  win.eval(source);
  t.after(()=>win.close());
  const root=win.document.querySelector('#notes'), get=selector=>root.querySelector(selector), calls=[], opened=[];
  const note={paper_id:'p',annotation_id:'a',title:'Synthetic paper',page:2,text:'Quote <i>plain</i>',comment:'My note',tags:['Mobility'],favorite:true};
  const ui=win.PaperLibraryNotes.create({root,getPaper:()=>({id:'p',pdf:true}),openNote:async value=>opened.push(value),toast:message=>assert.fail(message),
    api:async(action,args)=>{
      calls.push([action,JSON.parse(JSON.stringify(args))]);
      if(action==='project_list')return {projects:[{id:'project-1',title:'Synthetic project'}],total:1};
      assert.equal(action,'annotation_favorites_list');
      assert.equal(args.view,'notes');
      return {items:[note],tags:[{tag:'Mobility',total:1}],offset:0,total:1,has_more:false,coverage:{indexed:1,documents:1,pending:0,incomplete:0}};
    }
  });
  t.after(()=>ui.close());
  const change=(selector,value)=>{
    const control=get(selector);control.value=value;control.dispatchEvent(new win.Event('change'));return control;
  };
  const press=text=>[...root.querySelectorAll('button')].find(item=>item.textContent===text).click();
  ui.open();await tick();
  assert.ok(get('.notes-library-card'));
  assert.equal(get('blockquote i'),null);
  assert.equal(get('[aria-label="已收藏"]').tagName,'SPAN');
  assert.ok(!root.textContent.includes('取消收藏'));
  press('表格');
  assert.equal(get('table tbody tr').children.length,4);
  get('.notes-library-source').click();await tick();
  assert.deepEqual(opened,[note]);
  change('[aria-label="检索范围"]','paper');await tick();
  assert.equal(calls.at(-1)[1].paper_id,'p');
  change('[aria-label="收录条件"]','tagged');await tick();
  assert.equal(calls.at(-1)[1].category,'tagged');
  press('#Mobility');await tick();
  assert.equal(calls.at(-1)[1].tag,'Mobility');
  change('[aria-label="检索范围"]','project');await tick();
  change('[aria-label="选择阅读项目"]','project-1');await tick();
  assert.equal(calls.at(-1)[1].project_id,'project-1');
});
