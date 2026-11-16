import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {JSDOM} = require(process.env.JSDOM_MODULE || 'jsdom');
const source = await readFile(new URL('../web/annotation-threads.js',import.meta.url),'utf8');
const tick = () => new Promise(resolve=>setImmediate(resolve));

test('the catalog and folded reader card share the virtual note and use versioned writes', async t=>{
  const {window} = new JSDOM('<main></main>',{runScripts:'outside-only'});
  t.after(()=>window.close());
  window.HTMLDialogElement.prototype.showModal = function(){this.open=true;};
  window.HTMLDialogElement.prototype.close = function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  let observer;
  window.IntersectionObserver = class {
    constructor(callback){observer=callback;}
    observe(){}
    unobserve(){}
    disconnect(){}
  };
  window.eval(source);
  const memo = {id:'synthetic',title:'Synthetic manual review',pdf:true,modified:'stamp'};
  const note = {id:'a',kind:'paper-remark',comment:'先读方法部分。'};
  assert.equal(window.PaperAnnotationThreads.threads([note,{id:'other',page:1}]).notes.length,1);
  const writes=[], saved=[], located=[];
  let persisted={annotation_id:'a',comment:note.comment,version:'v1'};
  const controller=window.PaperRemark.create({
    async api(action,args){
      assert.equal(args.view,'paper-remark');
      if(action==='annotations')return {items:args.ids.map(id=>({id,remark:persisted}))};
      assert.equal(action,'annotation_update');
      writes.push(args);
      if(args.expected_version!==persisted.version)throw Object.assign(Error('更新冲突'),{code:'PAPER_REMARK_CONFLICT'});
      persisted={...persisted,comment:args.comment,version:'v3'};
      return {remark:persisted};
    },toast(){},onSaved:id=>saved.push(id),locate:(item,remark)=>located.push([item.id,remark.id]),
  });
  const document=window.document, root=document.querySelector('main');
  const cell=controller.cell(memo), card=controller.sidebar(memo,note);
  root.append(cell,card);
  controller.connectTable(root);
  observer([{target:cell,isIntersecting:true}]);
  await tick();
  assert.equal(cell.textContent,note.comment);
  assert.equal(card.open,false);
  const find=(root,label)=>[...root.querySelectorAll('button')].find(button=>button.textContent===label);
  find(card,'定位第一页').click();
  assert.deepEqual(located,[[memo.id,note.id]]);
  cell.click();
  await tick();
  const dialog=document.querySelector('dialog'), textarea=dialog.querySelector('textarea');
  assert.equal(textarea.value,note.comment);
  textarea.value='我的评价';
  persisted={...persisted,comment:'其他窗口的修改',version:'v2'};
  const submit=()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  submit();
  await tick();
  assert.match(dialog.querySelector('[role=status]').textContent,/冲突/);
  find(dialog,'读取当前版本').click();
  await tick();
  assert.equal(textarea.value,'我的评价');
  assert.match(dialog.querySelector('blockquote').textContent,/其他窗口的修改/);
  submit();
  await tick();
  assert.equal(dialog.open,false);
  assert.equal(cell.textContent,'我的评价');
  assert.deepEqual(writes.map(row=>[row.id,row.expected_version,row.companion_skip]),[
    [memo.id,'v1',true],[memo.id,'v2',true],
  ]);
  assert.deepEqual(saved,[memo.id]);
});
