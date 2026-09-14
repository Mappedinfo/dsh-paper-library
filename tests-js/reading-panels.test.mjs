import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../web/reading-panels.js',import.meta.url),'utf8');
function environment({width=741,storage=new Map()}={}) {
  const ids=new Map(),visibility=[],changes=[],toasts=[];
  class Element {
    constructor(tag='div') {this.tagName=tag.toUpperCase();this.children=[];this.hidden=false;this.open=false;this.dataset={};this.attributes={};this.events=new Map();this.clientWidth=width;const classes=new Set();this.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name),toggle:(name,on)=>{if(on===undefined)on=!classes.has(name);if(on)classes.add(name);else classes.delete(name);return on;}};}
    set id(value){this._id=value;ids.set(value,this);} get id(){return this._id;}
    set className(value){this._className=value;this.classList.add(...value.split(' '));}get className(){return this._className;}
    get nextSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]||null;}
    append(...nodes){for(const n of nodes){n.remove();n.parentNode=this;this.children.push(n);}}
    insertBefore(n,next){n.remove();const i=this.children.indexOf(next);this.children.splice(i<0?this.children.length:i,0,n);n.parentNode=this;}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
    addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}
    removeEventListener(type,fn){this.events.get(type)?.delete(fn);}
    dispatch(type,args={}){const e={preventDefault(){this.defaultPrevented=true;},...args};for(const fn of this.events.get(type)||[])fn(e);}
    setAttribute(key,value){this.attributes[key]=String(value);}getAttribute(key){return this.attributes[key]??null;}
    getClientRects(){for(let n=this;n;n=n.parentNode)if(n.hidden)return [];return [{}];}
    show(){this.open=true;this.modal=false;}showModal(){this.open=true;this.modal=true;}
    close(){const was=this.open;this.open=false;if(was)this.dispatch('close');}
  }
  const body=new Element('body'),old=new Element(),root=new Element();body.append(root,old);
  const annotationsRoot=new Element('section'),conversationRoot=new Element('section'),metadataRoot=new Element('dialog');
  annotationsRoot.id='annotations-tab';conversationRoot.id='conversation-tab';metadataRoot.id='metadata-dialog';annotationsRoot.hidden=true;conversationRoot.hidden=true;old.append(annotationsRoot,conversationRoot,metadataRoot);
  const original=[...old.children],window=new Element('window');window.localStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  const observers=[];window.ResizeObserver=class {constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
  const document={body,createElement:tag=>new Element(tag)};
  vm.runInNewContext(source,{window,document},{filename:'web/reading-panels.js'});
  const panels=window.PaperReadingPanels.create({root,annotationsRoot,conversationRoot,metadataRoot,persistence:{get:async key=>storage.get(key)||null,patch:async(key,value)=>storage.set(key,{...storage.get(key),...value})},onChatVisibility:value=>visibility.push(value),onPanelChange:value=>changes.push({...value}),toast:(...args)=>toasts.push(args)});
  return {panels,root,body,old,original,annotationsRoot,conversationRoot,metadataRoot,visibility,changes,toasts,ids,window,storage,observers};
}
const paper={id:'synthetic-a',title:'Synthetic paper'};

test('reading sidebar moves original content and preserves listener identity while switching sides',()=>{
  const f=environment();let clicks=0;f.annotationsRoot.addEventListener('click',()=>clicks++);
  f.panels.paperChanged(paper);f.panels.show('annotations');
  assert.equal(f.annotationsRoot.parentNode.parentNode,f.ids.get('reading-side-panel'));
  assert.equal(f.annotationsRoot.hidden,false);assert.equal(f.metadataRoot.hidden,true);assert.equal(f.root.dataset.readingSide,'left');
  f.annotationsRoot.dispatch('click');f.ids.get('reading-panel-side').dispatch('click');
  assert.equal(clicks,1);assert.equal(f.root.dataset.readingSide,'right');assert.equal(f.annotationsRoot.hidden,false);
  assert.equal(f.storage.get('preferences')['reading-panel-side'],'right');
  assert.equal(f.root.classList.contains('reading-panels-roomy'),false);
  f.root.clientWidth=1000;f.observers[0].fn();assert.equal(f.root.classList.contains('reading-panels-roomy'),true);
});

test('metadata is a nonmodal exclusive sidebar and dialog close synchronizes the toggle',()=>{
  const f=environment();f.panels.paperChanged(paper);f.panels.show('annotations');f.panels.show('metadata');
  assert.equal(f.panels.visible('annotations'),false);assert.equal(f.panels.visible('metadata'),true);
  assert.equal(f.metadataRoot.open,true);assert.equal(f.metadataRoot.modal,false);
  f.metadataRoot.close();assert.equal(f.panels.visible('metadata'),false);assert.equal(f.ids.get('reading-side-panel').hidden,true);
  assert.equal(f.changes.at(-1).sidebar,null);
});

test('metadata stays usable for a catalogue row or a new record while the reading workspace is hidden',()=>{
  const f=environment();f.root.hidden=true;
  assert.equal(f.panels.show('metadata'),true,'New entries have no paper yet');
  const side=f.ids.get('reading-side-panel'),host=side.parentNode;
  assert.notEqual(host,f.root);assert.equal(host.parentNode,f.body);assert.equal(host.hidden,false);assert.equal(f.metadataRoot.open,true);
  f.panels.setSide('right');assert.equal(host.dataset.readingSide,'right');
  f.root.hidden=false;f.observers[0].fn();assert.equal(side.parentNode,f.root);assert.equal(host.hidden,true);
  f.root.hidden=true;f.window.dispatch('resize');assert.equal(side.parentNode,host);
  f.panels.close('metadata');assert.equal(host.hidden,true);assert.equal(side.parentNode,f.root);
});

test('floating chat collapse and close preserve the existing draft, selected references and DOM',()=>{
  const f=environment();f.conversationRoot.draft='Unsent question';f.conversationRoot.references=['note-a'];
  f.panels.paperChanged(paper);f.panels.show('chat');f.panels.show('annotations');
  assert.deepEqual(f.visibility,[true]);assert.equal(f.panels.visible('chat'),true);
  f.ids.get('reading-chat-collapse').dispatch('click');assert.equal(f.panels.visible('chat'),false);
  assert.equal(f.ids.get('reading-chat-panel').hidden,false,'Collapsed header remains available');assert.deepEqual(f.visibility,[true,false]);
  f.panels.toggle('chat');assert.deepEqual(f.visibility,[true,false,true]);
  f.panels.close('chat');f.panels.show('chat');
  assert.equal(f.conversationRoot.draft,'Unsent question');assert.deepEqual(f.conversationRoot.references,['note-a']);
  assert.equal(f.conversationRoot.parentNode,f.ids.get('reading-chat-content'));assert.equal(f.panels.visible('annotations'),true);
});

test('paper changes update chat context label; no selection closes panels without deleting content',()=>{
  const f=environment();assert.equal(f.panels.show('chat'),false);assert.equal(f.toasts.length,1);
  f.panels.paperChanged(paper);f.panels.show('chat');f.panels.show('annotations');
  f.panels.paperChanged({...paper,id:'synthetic-b',title:'Second paper'});
  assert.equal(f.panels.visible('chat'),true);assert.match(f.ids.get('reading-chat-panel').children[0].children[0].textContent,/Second paper/);
  f.panels.paperChanged(null);assert.equal(f.panels.visible('chat'),false);assert.equal(f.panels.visible('annotations'),false);assert.deepEqual(f.visibility,[true,false]);
  f.panels.paperChanged({...paper,archived:true});assert.equal(f.panels.show('annotations'),false);
});

test('escape is scoped to its panel and disposal restores original nodes and removes listeners',()=>{
  const f=environment();f.panels.paperChanged(paper);f.panels.show('chat');f.panels.show('annotations');
  f.ids.get('reading-side-panel').dispatch('keydown',{key:'Escape'});assert.equal(f.panels.visible('annotations'),false);assert.equal(f.panels.visible('chat'),true);
  f.panels.dispose();assert.deepEqual(f.old.children,f.original);assert.equal(f.annotationsRoot.hidden,true);assert.equal(f.conversationRoot.hidden,true);
  assert.equal(f.root.children.length,0);assert.equal(f.body.children.length,2);assert.deepEqual(f.visibility,[true,false]);assert.equal(f.observers[0].disconnected,true);
  f.window.dispatch('resize');assert.equal(f.root.classList.contains('reading-panels-roomy'),false);assert.equal(f.panels.show('chat'),false);
});
