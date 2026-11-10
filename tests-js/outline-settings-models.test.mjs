import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.style={};this.attributes={};this.value='';this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  get options(){return this.children;}
  click(){return this.listeners.click?.();}
}
const flush=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
async function load(file){const window={},document={createElement:tag=>new Element(tag)};const timers=[];vm.runInNewContext(await readFile(new URL(`../web/${file}`,import.meta.url),'utf8'),{window,document,setTimeout:fn=>timers.push(fn)});return{window,timers};}
const json=value=>JSON.parse(JSON.stringify(value));

test('outline bookmarks navigate without starting extraction; paused inference stops between pages',async()=>{
  const {window,timers}=await load('paper-outline.js');let panel,visible=true;const calls=[],jumps=[];let paper={id:'synthetic',pdf:true};
  const api=async(action,args)=>{calls.push(args);return args.page?{items:[{title:'1 Introduction',level:1,page:1}],page_count:3}:{items:paper.id==='synthetic'?[{title:'Methods',level:2,page:2}]:[],page_count:3};};
  const ui=window.PaperOutline.create({api,getPaper:()=>paper,panels:{registerPanel:p=>panel=p,visible:()=>visible},navigate:v=>jumps.push(v)});
  panel.onShow();await flush();assert.equal(calls.length,1);assert.equal(panel.element.children[1].hidden,true);
  panel.element.children[2].children[0].click();assert.equal(jumps[0].page,2);
  paper={id:'no-bookmarks',pdf:true};ui.sync();await flush();assert.equal(calls.length,2,'no automatic full PDF extraction');
  const scan=panel.element.children[1];scan.click();await flush();assert.equal(calls.length,3);scan.click();
  timers.shift()();await flush();assert.equal(calls.length,3,'pause retains progress without reading another page');
  visible=false;ui.sync();ui.dispose();
});

test('model settings show effective defaults and save explicit choices with revision and existing prompts',async()=>{
  const {window}=await load('settings-models.js');const container=new Element('div'),calls=[];
  const record={revision:'rev1',value:{model:null,target_language:'en',translate_prompt:'keep',polish_prompt:'keep polish'},models:[{provider:'host',id:'general'},{provider:'host',id:'fast'}],default_model:{provider:'host',model:'general'},translation_default_model:{provider:'host',model:'fast'}};
  const api=async(action,args)=>{calls.push({action,args});if(action==='language_settings_get')return record;if(action==='chat_ensure')return{model:{provider:'host',model:'general'}};if(action==='chat_model_update')return{model:args.model};if(action==='language_settings_update')return{value:args.value,revision:'rev2'};throw Error(action);};
  const ui=window.PaperSettingsModels.create({api,getPaper:()=>({id:'paper-a'}),container});await ui.refresh();
  const nodes=container.children[0].children;
  assert.match(nodes[1].textContent,/host \/ general/);assert.match(nodes[4].textContent,/翻译：host \/ fast；润色：host \/ general/);
  nodes[0].children[1].value=JSON.stringify({provider:'host',model:'fast'});await nodes[2].click();assert.equal(calls.at(-1).action,'chat_model_update');assert.equal(calls.at(-1).args.id,'paper-a');
  nodes[3].children[1].value=JSON.stringify({provider:'host',model:'general'});await nodes[5].click();
  assert.deepEqual(json(calls.at(-1).args),{expected_revision:'rev1',value:{...record.value,model:{provider:'host',model:'general'}}});assert.match(nodes[4].textContent,/翻译：host \/ general；润色：host \/ general/);
});
