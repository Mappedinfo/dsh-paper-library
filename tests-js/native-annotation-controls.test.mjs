import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require(process.env.JSDOM_MODULE||'jsdom'));}catch{}
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const shell=await readFile(new URL('../web/reading-shell.js',import.meta.url),'utf8');
test('rectangle and free-stroke controls use native tools and share explicit color/width', {skip:!JSDOM}, async()=>{
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://synthetic.invalid/'}),{window}=dom,doc=window.document,calls=[];
  for(const id of ['metadata-enrich','catalog-archive']){const b=doc.createElement('button');b.id=id;doc.body.append(b);}
  window.eval(shell);
  const reader={setTool:(...args)=>calls.push(args),getInkDraft:()=>null,getInkContext:()=>null,isInking:()=>false};
  const ui=window.PaperReadingShell.create({state:{active:{id:'synthetic',pdf:true},page:1,tab:'reader'},workbench:()=>({isTable:()=>false}),panels:()=>({visible:()=>false}),reader:()=>reader,navigate(){},toast(){},beforeToolChange:async()=>true});
  const click=async id=>{doc.getElementById(id).click();await new Promise(resolve=>setImmediate(resolve));};
  await click('reader-tool-square');assert.equal(ui.tool().type,'square');assert.equal(doc.getElementById('reader-tool-square').textContent,'矩形框');
  assert.equal(doc.getElementById('reader-mode-group').hidden,true);assert.equal(doc.getElementById('reader-ink-width').parentElement.hidden,false);
  const color=doc.getElementById('reader-color'),width=doc.getElementById('reader-ink-width');
  color.value='#336699';color.dispatchEvent(new window.Event('input'));width.value='4';width.dispatchEvent(new window.Event('change'));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['square',{color:'#336699',width:4}]);
  await click('reader-tool-ink');assert.equal(doc.getElementById('reader-tool-ink').textContent,'自由笔画');assert.equal(doc.getElementById('reader-ink-save').textContent,'完成笔画');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['ink',{color:'#336699',width:4}]);
  await click('reader-tool-select');assert.equal(doc.getElementById('reader-mode-group').hidden,false);assert.equal(width.parentElement.hidden,true);
  ui.dispose();dom.window.close();
});

test('reading display toggles restore independent preferences and do not switch annotation tools', {skip:!JSDOM}, async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://synthetic.invalid/'}),w=dom.window,d=w.document,appearance=[],writes=[];
 for(const id of ['metadata-enrich','catalog-archive']){const b=d.createElement('button');b.id=id;d.body.append(b);}w.eval(shell);
 let restore;const persistence={get:()=>new Promise(r=>restore=r),patch:async(key,value)=>writes.push({key,...value})};
 const ui=w.PaperReadingShell.create({state:{active:{id:'a',pdf:true},page:1,tab:'reader'},workbench:()=>({isTable:()=>false}),panels:()=>({visible:()=>false}),reader:()=>({setReadingAppearance:value=>appearance.push({...value}),setTool(){},getInkDraft:()=>null,getInkContext:()=>null,isInking:()=>false}),persistence,navigate(){},toast(){}});
 restore({darkPdf:true,bionic:false});await new Promise(r=>setImmediate(r));
 const dark=d.getElementById('reader-dark-pdf'),bionic=d.getElementById('reader-bionic');assert.equal(dark.checked,true);assert.equal(bionic.checked,false);
 bionic.checked=true;bionic.dispatchEvent(new w.Event('change'));dark.checked=false;dark.dispatchEvent(new w.Event('change'));await new Promise(r=>setImmediate(r));
 assert.deepEqual(appearance.at(-1),{darkPdf:false,bionic:true});assert.deepEqual(writes.map(v=>({darkPdf:v.darkPdf,bionic:v.bionic})),[{darkPdf:true,bionic:true},{darkPdf:false,bionic:true}]);assert.equal(ui.tool().type,'select');
 assert.equal(d.getElementById('reader-appearance').closest('nav').className,'reader-ribbon');ui.dispose();w.close();
});
