import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const script=await readFile(new URL('../web/annotation-style.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
const note={id:'synthetic-note',type:'underline',style_version:'a'.repeat(64),line_style:'solid',color:{stroke:[1,0,0]}};
function fixture(t,type='underline',fail=false){
 const dom=new JSDOM('<main id="continuous-reader"><div class="pdr-sheet">Synthetic PDF page</div></main><button id="outside">Other control</button>',{runScripts:'outside-only',url:'http://synthetic.invalid/'}),w=dom.window,calls=[],saved=[];
 w.eval(script);t.after(()=>w.close());
 let current={...note,type};
 async function api(action,args){
   calls.push({action,...args});
   if(fail)throw Error('synthetic write failed');
   assert.equal(args.expected_version,current.style_version);
   const stroke=args.color.slice(1).match(/../g).map(hex=>parseInt(hex,16)/255);
   current={...current,color:{stroke},line_style:args.line_style??current.line_style,style_version:String(calls.length).padStart(64,'0')};
   return {annotation:current};
 }
 function mount(value=current){
   const menu=w.PaperAnnotationStyle.editor({note:value,paperId:'synthetic',api,onSaved:async value=>saved.push(value)});
   w.document.body.append(menu);
   return menu;
 }
 return {w,menu:mount(),mount,calls,saved,pdf:w.document.querySelector('.pdr-sheet')};
}
test('per-annotation styles save native color and dash with independent version; source/comment never sent',async t=>{
 const f=fixture(t);f.menu.open=true;f.menu.querySelector('[aria-label="蓝色"]').click();
 const line=f.menu.querySelector('select');line.value='dashed';f.menu.querySelector('.annotation-style-actions>button').click();await tick();
 assert.deepEqual(f.calls,[{action:'annotation_style',id:'synthetic',annotation_id:note.id,color:'#447dc4',line_style:'dashed',expected_version:note.style_version}]);
 assert.equal(f.saved.length,1);assert.equal(f.menu.open,false);
 assert.equal(f.menu.querySelector('[aria-label="蓝色"]').getAttribute('aria-pressed'),'true');
});
test('highlight only offers color and failed write retains editable style choice',async t=>{
 const f=fixture(t,'highlight',true);f.menu.open=true;assert.equal(f.menu.querySelector('select'),null);
 f.menu.querySelector('[aria-label="紫色"]').click();f.pdf.click();await tick();
 assert.match(f.menu.querySelector('[role=status]').textContent,/write failed/);assert.equal(f.menu.open,true);assert.equal(f.saved.length,0);assert.equal(f.menu.querySelector('input').value,'#9274bd');assert.equal('line_style' in f.calls[0],false);
 const [save,undo]=f.menu.querySelectorAll('.annotation-style-actions>button');
 assert.equal(save.disabled,false);undo.click();
 assert.equal(f.menu.querySelector('input').value,'#ff0000');assert.equal(f.calls.length,1);assert.equal(save.disabled,true);
});

test('clicking the PDF saves once and the rebuilt card can undo both style changes',async t=>{
 const f=fixture(t);f.menu.open=true;
 f.menu.querySelector('[aria-label="绿色"]').click();
 const line=f.menu.querySelector('select');line.value='dotted';line.dispatchEvent(new f.w.Event('change'));
 f.w.document.querySelector('#outside').click();assert.equal(f.calls.length,0);
 let pageClicks=0;f.pdf.addEventListener('click',()=>pageClicks++);
 f.pdf.click();f.pdf.click();await tick();
 assert.equal(pageClicks,2);assert.equal(f.calls.length,1);assert.equal(f.menu.open,false);
 const applied=f.saved[0];assert.equal(applied.line_style,'dotted');
 f.menu.remove();
 const newMenu=f.mount();newMenu.open=true;
 const undo=newMenu.querySelector('.annotation-style-actions>button:last-child');
 assert.equal(undo.disabled,false);
 undo.click();await tick();
 assert.deepEqual(f.calls[1],{action:'annotation_style',id:'synthetic',annotation_id:note.id,color:'#ff0000',line_style:'solid',expected_version:applied.style_version});
 assert.equal(newMenu.querySelector('input').value,'#ff0000');assert.equal(undo.disabled,true);
 newMenu.open=true;f.pdf.click();assert.equal(newMenu.open,false);assert.equal(f.calls.length,2);
});

test('an updated style version invalidates the previous-style button',async t=>{
 const f=fixture(t);f.menu.querySelector('[aria-label="蓝色"]').click();f.menu.querySelector('.annotation-style-actions>button').click();await tick();
 f.menu.remove();
 const menu=f.mount({...f.saved[0],style_version:'f'.repeat(64)});
 assert.equal(menu.querySelector('.annotation-style-actions>button:last-child').disabled,true);
});
