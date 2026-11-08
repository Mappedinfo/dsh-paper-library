/** 原生矩形输入链路：合成页面与 DOM，不读取或修改用户 PDF。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require(process.env.JSDOM_MODULE||'jsdom'));}catch{}
const source=await readFile(new URL('../web/pdf-reader.js',import.meta.url),'utf8');
const css=await readFile(new URL('../web/pdf-reader.css',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));
async function fixture({rotation=0,scale=1}={}){
  const dom=new JSDOM(`<style>${css}</style><div id="reader"></div>`,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://synthetic.invalid/'});
  const {window}=dom,root=window.document.querySelector('#reader'),calls=[],rectangles=[],selections=[],statuses=[],captured=new Set();
  const page={page:1,width:rotation%180?600:400,height:rotation%180?400:600,rotation};
  Object.defineProperties(root,{clientWidth:{value:640},clientHeight:{value:500}});
  root.getBoundingClientRect=()=>({left:0,top:0,width:640,height:500,right:640,bottom:500});
  root.setPointerCapture=id=>captured.add(id);root.hasPointerCapture=id=>captured.has(id);root.releasePointerCapture=id=>captured.delete(id);
  window.ResizeObserver=class{observe(){}disconnect(){}};
  window.HTMLImageElement.prototype.decode=async()=>{};
  window.eval(source);
  const ui=window.PaperPDFReader.create({root,getPaper:()=>({id:'synthetic',pdf:'synthetic.pdf'}),api:async(action,args)=>{
    calls.push([action,plain(args)]);assert.equal(action,'page','Rectangle creation does not issue a write API call');
    return {...page,page_count:1,scale:1,image:'iVBORw0KGgo=',words:[],annotations:[],internal_links:[],layout:{page_count:1,pages:[page]}};
  },onRectangle:(value,options)=>rectangles.push([plain(value),plain(options)]),onSelection:value=>selections.push(value),onStatus:(...value)=>statuses.push(value)});
  await ui.open({id:'synthetic',pdf:'synthetic.pdf'});await tick();
  const sheet=root.querySelector('.pdr-sheet');
  sheet.getBoundingClientRect=()=>({left:20,top:30,width:page.width*scale,height:page.height*scale,right:20+page.width*scale,bottom:30+page.height*scale});
  function pointer(type,x,y,extra={}){
    const event=new window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:20+x*scale,clientY:30+y*scale,button:0});
    Object.defineProperties(event,{pointerType:{value:extra.pointerType||'mouse'},pointerId:{value:extra.pointerId||1},isPrimary:{value:extra.isPrimary??true}});
    (extra.target||sheet).dispatchEvent(event);return event;
  }
  function start(){ui.setTool('square',{color:'#336699',width:3});pointer('pointerdown',10,20);pointer('pointermove',80,100);assert.ok(root.querySelector('.pdr-square-draft'));}
  return {dom,window,root,sheet,page,ui,pointer,start,calls,rectangles,selections,statuses,captured,close(){ui.dispose();dom.window.close();}};
}

test('rectangle uses displayed PDF points at zoom and rotation, with transparent live preview', {skip:!JSDOM}, async()=>{
  for(const rotation of [0,90,180,270])for(const scale of [.5,2]){
    const f=await fixture({rotation,scale});f.ui.setTool('square',{color:'#336699',width:3});
    f.pointer('pointerdown',150,120,{pointerType:'pen'});f.pointer('pointermove',40,35,{pointerType:'pen'});
    const preview=f.root.querySelector('.pdr-square-draft');assert.ok(preview);
    assert.equal(f.window.getComputedStyle(preview).backgroundColor,'rgba(0, 0, 0, 0)');
    assert.equal(f.window.getComputedStyle(preview).pointerEvents,'none');
    assert.equal(preview.style.borderColor,'rgb(51, 102, 153)');
    f.pointer('pointerup',40,35,{pointerType:'pen'});f.pointer('pointerup',40,35,{pointerType:'pen'});
    assert.deepEqual(f.rectangles,[[{id:'synthetic',page:1,text:'',rects:[[40,35,150,120]]},{intent:'square',color:'#336699',width:3}]]);
    assert.equal(f.selections.length,0);assert.equal(f.captured.size,0);assert.equal(f.root.querySelector('.pdr-square-draft'),null);f.close();
  }
});

test('small drags, cross-page release and pointer cancellation never create an annotation', {skip:!JSDOM}, async()=>{
  const f=await fixture();f.ui.setTool('square');
  f.pointer('pointerdown',10,20);f.pointer('pointerup',11,21);assert.equal(f.rectangles.length,0);
  f.start();f.pointer('pointerup',f.page.width+100,100);assert.equal(f.rectangles.length,0);assert.match(f.statuses.at(-1)[0],/同一 PDF 页/);
  for(const reason of ['pointercancel','lostpointercapture','pointerleave']){
    f.start();if(reason!=='pointercancel')f.captured.clear();f.pointer(reason,80,100,{target:f.root});
    f.pointer('pointerup',80,100);assert.equal(f.rectangles.length,0);assert.equal(f.root.querySelector('.pdr-square-draft'),null);
  }
  f.close();
});

test('tool changes, escape, zoom, layout and clearing cancel the pending rectangle', {skip:!JSDOM}, async()=>{
  const f=await fixture();
  const transitions=[()=>f.ui.setTool('select'),()=>f.root.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})),()=>f.ui.setZoom(2),()=>f.ui.setLayout('spread'),()=>f.ui.clear()];
  for(const change of transitions){f.start();change();f.pointer('pointerup',80,100);assert.equal(f.rectangles.length,0);assert.equal(f.root.querySelector('.pdr-square-draft'),null);}
  f.close();
});

test('touch stays navigation and strict pen policy rejects mouse rectangles', {skip:!JSDOM}, async()=>{
  const f=await fixture();f.ui.setTool('square');
  f.pointer('pointerdown',80,100,{pointerType:'touch'});f.pointer('pointermove',80,80,{pointerType:'touch'});f.pointer('pointerup',80,80,{pointerType:'touch'});
  assert.equal(f.rectangles.length,0);assert.equal(f.root.querySelector('.pdr-square-draft'),null);assert.ok(f.root.scrollTop>0);
  f.ui.setPenOnly(true);f.pointer('pointerdown',10,20);f.pointer('pointermove',80,100);f.pointer('pointerup',80,100);
  assert.equal(f.rectangles.length,0);assert.match(f.statuses.at(-1)[0],/仅用笔/);
  f.pointer('pointerdown',10,20,{pointerType:'pen'});
  const scroll=f.root.scrollTop;f.pointer('pointerdown',80,100,{pointerType:'touch',pointerId:2});f.pointer('pointermove',80,80,{pointerType:'touch',pointerId:2});f.pointer('pointerup',80,80,{pointerType:'touch',pointerId:2});
  assert.equal(f.root.scrollTop,scroll,'A second touch cannot move the page beneath a pen rectangle');assert.ok(f.root.querySelector('.pdr-square-draft'));
  f.pointer('pointerup',80,100,{pointerType:'pen'});assert.equal(f.rectangles.length,1);f.close();
});

test('deferred page refresh waits for rectangle completion and then restores the page', {skip:!JSDOM}, async()=>{
  const f=await fixture();f.start();const count=f.calls.length;const pending=f.ui.refresh(1);
  await new Promise(resolve=>setTimeout(resolve,280));assert.equal(f.calls.length,count);assert.ok(f.root.querySelector('.pdr-square-draft'));
  f.pointer('pointerup',80,100);await pending;assert.equal(f.calls.length,count+1);assert.equal(f.rectangles.length,1);assert.equal(f.sheet.dataset.loaded,'true');f.close();
});
