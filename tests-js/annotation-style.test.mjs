import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const script=await readFile(new URL('../web/annotation-style.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
const note={id:'synthetic-note',type:'underline',style_version:'a'.repeat(64),line_style:'solid',color:{stroke:[1,0,0]}};
function fixture(t,type='underline',fail=false){
 const dom=new JSDOM('',{runScripts:'outside-only',url:'http://synthetic.invalid/'}),w=dom.window,calls=[],saved=[];w.eval(script);t.after(()=>w.close());
 const menu=w.PaperAnnotationStyle.editor({note:{...note,type},paperId:'synthetic',api:async(action,args)=>{calls.push({action,...args});if(fail)throw Error('synthetic write failed');return{annotation:{...note,style_version:'b'.repeat(64)}};},onSaved:async value=>saved.push(value)});w.document.body.append(menu);return {w,menu,calls,saved};
}
test('per-annotation styles save native color and dash with independent version; source/comment never sent',async t=>{
 const f=fixture(t);f.menu.open=true;f.menu.querySelector('[aria-label="蓝色"]').click();
 const line=f.menu.querySelector('select');line.value='dashed';f.menu.querySelector('.annotation-style-panel>button').click();await tick();
 assert.deepEqual(f.calls,[{action:'annotation_style',id:'synthetic',annotation_id:note.id,color:'#447dc4',line_style:'dashed',expected_version:note.style_version}]);
 assert.equal(f.saved.length,1);assert.equal(f.menu.open,false);
 assert.equal(f.menu.querySelector('[aria-label="蓝色"]').getAttribute('aria-pressed'),'true');
});
test('highlight only offers color and failed write retains editable style choice',async t=>{
 const f=fixture(t,'highlight',true);assert.equal(f.menu.querySelector('select'),null);
 f.menu.querySelector('[aria-label="紫色"]').click();f.menu.querySelector('.annotation-style-panel>button').click();await tick();
 assert.match(f.menu.querySelector('[role=status]').textContent,/write failed/);assert.equal(f.menu.open,true);assert.equal(f.saved.length,0);assert.equal(f.menu.querySelector('input').value,'#9274bd');assert.equal('line_style' in f.calls[0],false);
});
