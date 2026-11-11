import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.style={};this.attributes={};this.value='';this.textContent='';this.classList={toggle(){}};this.dataset={};}
  append(...nodes){this.children.push(...nodes);}
  prepend(...nodes){this.children.unshift(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(k,v){this.attributes[k]=v;}
  removeAttribute(k){delete this.attributes[k];}
  get childElementCount(){return this.children.length;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  get options(){return this.children.flatMap(child=>child.tagName==='optgroup'?child.children:[child]);}
  get selectedOptions(){return this.options.filter(option=>option.value===this.value);}
  click(){return this.listeners.click?.();}
}
const flush=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
async function load(file){const window={},document={createElement:tag=>new Element(tag)};const timers=[];vm.runInNewContext(await readFile(new URL(`../web/${file}`,import.meta.url),'utf8'),{window,document,setTimeout:fn=>timers.push(fn)});return{window,timers};}
const json=value=>JSON.parse(JSON.stringify(value));

test('outline bookmarks navigate without starting extraction; paused inference stops between pages',async()=>{
  const {window,timers}=await load('paper-outline.js');let panel,visible=true;const calls=[],jumps=[];let paper={id:'synthetic',pdf:true};
  const api=async(action,args)=>{calls.push(args);return args.page?{items:[{title:'1 Introduction',level:1,page:1}],page_count:3}:{items:paper.id==='synthetic'?[{title:'Methods',level:2,page:2}]:[],page_count:3};};
  const ui=window.PaperOutline.create({api,getPaper:()=>paper,panels:{registerPanel:p=>panel=p,visible:()=>visible},navigate:v=>jumps.push(v)});
  panel.onShow();await flush();assert.equal(calls.length,1);assert.equal(panel.element.children[2].hidden,true);
  panel.element.children[3].children[0].children[0].children[0].children[0].click();assert.equal(jumps[0].page,2);
  paper={id:'no-bookmarks',pdf:true};ui.sync();await flush();assert.equal(calls.length,2,'no automatic full PDF extraction');
  const scan=panel.element.children[2];scan.click();await flush();assert.equal(calls.length,3);scan.click();
  timers.shift()();await flush();assert.equal(calls.length,3,'pause retains progress without reading another page');
  visible=false;ui.sync();ui.dispose();
});

test('model settings show effective defaults and save explicit choices with revision and existing prompts',async()=>{
  const {window}=await load('settings-models.js');const container=new Element('div'),calls=[];
  const record={revision:1,value:{model:null,target_language:'en',translate_prompt:'keep',polish_prompt:'keep polish'},models:[{provider:'host',provider_name:'Test Host',id:'general'},{provider:'host',provider_name:'Test Host',id:'fast'}],default_model:{provider:'host',model:'general'},translation_default_model:{provider:'host',model:'fast'}};
  const paper={writable:true,revision:0,value:{model:null},models:record.models,effective_model:record.default_model};
  const api=async(action,args)=>{
    calls.push({action,args});
    if(action==='language_settings_get')return record;
    if(action==='paper_model_get')return paper;
    if(action==='paper_model_efforts')return {efforts:[{id:'high',name:'高'}]};
    if(action==='paper_model_update')return {...paper,revision:1,effective_model:args.model};
    if(action==='language_settings_update')return{value:args.value,revision:2};
    throw Error(action);
  };
  const ui=window.PaperSettingsModels.create({api,container});await ui.refresh();
  const nodes=container.children[0].children;
  assert.match(nodes[3].textContent,/general · host/);
  assert.deepEqual(nodes[6].children.map(n=>n.textContent),['翻译：fast · host','润色：general · host']);
  const picker=nodes[0].children[1];
  assert.equal(picker.children[1].label,'Test Host');
  assert.equal(picker.children[1].children[1].textContent,'fast');
  picker.value=JSON.stringify({provider:'host',model:'fast'});picker.listeners.change();await flush();
  nodes[1].children[1].value='high';await nodes[4].click();
  assert.equal(calls.at(-1).action,'paper_model_update');
  assert.deepEqual(json(calls.at(-1).args),{expected_revision:0,model:{provider:'host',model:'fast',reasoningEffort:'high'}});
  nodes[5].children[1].value=JSON.stringify({provider:'host',model:'general'});await nodes[7].click();
  assert.deepEqual(json(calls.at(-1).args),{expected_revision:1,value:{...record.value,model:{provider:'host',model:'general'}}});
  assert.deepEqual(nodes[6].children.map(n=>n.textContent),['翻译：general · host','润色：general · host']);
  assert.ok(calls.every(call=>!call.action.startsWith('chat_')));
});

test('outline groups chapters, keeps current page visible when collapsed and offers bounded thumbnail groups',async()=>{
 const {window}=await load('paper-outline.js');let panel;const jumps=[];
 const api=async action=>action==='paper_outline'?{items:[{title:'One',level:1,page:1},{title:'Two',level:2,page:3},{title:'Another bookmark to page one',level:3,page:1}],page_count:60}:{image:'synthetic'};
 const ui=window.PaperOutline.create({api,getPaper:()=>({id:'synthetic',pdf:true}),getPage:()=>3,panels:{registerPanel:p=>panel=p,visible:()=>true},navigate:v=>jumps.push(v)});
 panel.onShow();await flush();
 const root=panel.element,tree=root.children[3].children[0];
 const [row,branch]=tree.children[0].children;
 const [toggle,parent]=row.children;
 const child=branch.children[0].children[0].children.at(-1);
 assert.equal(child.children[0].textContent,'Two');
 assert.equal(child.attributes['aria-current'],'location');
 toggle.click();assert.equal(branch.hidden,true);assert.equal(toggle.attributes['aria-expanded'],'false');
 assert.equal(parent.attributes['aria-current'],'location');
 toggle.click();assert.equal(child.attributes['aria-current'],'location');
 ui.setPage(1);assert.equal(parent.attributes['aria-current'],'location');
 root.children[0].children[1].click();assert.equal(root.children[5].children.length,50);root.children[4].children[2].click();assert.equal(root.children[5].children.length,10);root.children[5].children[0].click();assert.equal(jumps[0].page,51);ui.dispose();
});
