import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../web/reading-panels.js',import.meta.url),'utf8');
function environment({width=741,storage=new Map(),sharedLibrary=false,onAnnotationsRequest}={}) {
  const ids=new Map(),visibility=[],changes=[],toasts=[];
  class Element {
    constructor(tag='div') {this.tagName=tag.toUpperCase();this.children=[];this.hidden=false;this.open=false;this.dataset={};this.attributes={};this.events=new Map();this.clientWidth=width;const classes=new Set();this.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name),toggle:(name,on)=>{if(on===undefined)on=!classes.has(name);if(on)classes.add(name);else classes.delete(name);return on;}};this.style={values:new Map(),setProperty:(k,v)=>{this.style.values.set(k,v);},removeProperty:(k)=>{this.style.values.delete(k);}};this.bounds={left:0,right:width,width:Number(width)||0};}
    setPointerCapture(){} releasePointerCapture(){}
    getBoundingClientRect(){return this.bounds;}
    set id(value){this._id=value;ids.set(value,this);} get id(){return this._id;}
    set className(value){this._className=value;this.classList.add(...value.split(' '));}get className(){return this._className;}
    get nextSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]||null;}
    append(...nodes){for(const n of nodes){n.remove();n.parentNode=this;this.children.push(n);}}
    insertBefore(n,next){n.remove();const i=this.children.indexOf(next);this.children.splice(i<0?this.children.length:i,0,n);n.parentNode=this;}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
    addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}
    removeEventListener(type,fn){this.events.get(type)?.delete(fn);}
    dispatch(type,args={}){const e={target:this,preventDefault(){this.defaultPrevented=true;},...args};for(const fn of this.events.get(type)||[])fn(e);return e;}
    setAttribute(key,value){this.attributes[key]=String(value);}getAttribute(key){return this.attributes[key]??null;}
    removeAttribute(key){delete this.attributes[key];}
    focus(){document.activeElement=this;}
    click(){if(!this.disabled)this.dispatch('click');}
    getClientRects(){for(let n=this;n;n=n.parentNode)if(n.hidden)return [];return [{}];}
    show(){this.open=true;this.modal=false;}showModal(){this.open=true;this.modal=true;}
    close(){const was=this.open;this.open=false;if(was)this.dispatch('close');}
  }
  const body=new Element('body'),old=new Element(),root=new Element(),workspace=sharedLibrary?new Element():body;
  const libraryRoot=sharedLibrary?new Element('section'):undefined;
  let libraryChildren,search,paperList;
  if(sharedLibrary){
    const heading=new Element('header'),pager=new Element('footer');search=new Element('input');paperList=new Element();
    search.id='search';paperList.id='paper-list';libraryRoot.append(heading,search,paperList,pager);libraryChildren=[...libraryRoot.children];
    workspace.append(libraryRoot,root);body.append(workspace,old);
  }else body.append(root,old);
  const annotationsRoot=new Element('section'),conversationRoot=new Element('section'),metadataRoot=new Element('dialog');
  annotationsRoot.id='annotations-tab';conversationRoot.id='conversation-tab';metadataRoot.id='metadata-dialog';annotationsRoot.hidden=true;conversationRoot.hidden=true;old.append(annotationsRoot,conversationRoot,metadataRoot);
  const original=[...old.children],window=new Element('window');window.localStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  const observers=[];window.ResizeObserver=class {constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
  const document={body,createElement:tag=>new Element(tag)};
  vm.runInNewContext(source,{window,document},{filename:'web/reading-panels.js'});
  const panels=window.PaperReadingPanels.create({root,annotationsRoot,conversationRoot,metadataRoot,libraryRoot,onAnnotationsRequest,persistence:{get:async key=>storage.get(key)||null,patch:async(key,value)=>storage.set(key,{...storage.get(key),...value})},onChatVisibility:value=>visibility.push(value),onPanelChange:value=>changes.push({...value}),toast:(...args)=>toasts.push(args)});
  return {panels,root,body,old,original,annotationsRoot,conversationRoot,metadataRoot,visibility,changes,toasts,ids,window,document,storage,observers,workspace,libraryRoot,libraryChildren,search,paperList};
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

test('shared rail moves the one annotation pane beside the original library content without opening an overlay',()=>{
  const f=environment({sharedLibrary:true});f.panels.paperChanged(paper);
  const shelf=f.ids.get('reading-sidebar-library-content'),aside=f.ids.get('reading-side-panel');
  assert.deepEqual(shelf.children,f.libraryChildren);
  assert.equal(f.annotationsRoot.parentNode,f.libraryRoot);
  assert.equal(aside.children[1].children.includes(f.annotationsRoot),false);
  f.panels.show('annotations');
  assert.equal(f.annotationsRoot.hidden,false);assert.equal(shelf.hidden,true);assert.equal(aside.hidden,true);
  assert.equal(f.root.classList.contains('has-reading-sidebar'),false);
  assert.equal(f.libraryRoot.dataset.sidebarPanel,'annotations');
  assert.equal(f.libraryRoot.children.filter(node=>node===f.annotationsRoot).length,1);
  assert.equal(f.metadataRoot.parentNode,aside.children[1],'The metadata editor retains its own nonmodal surface');
});

test('library and annotation tabs preserve search, list scroll and annotation state in their original nodes',()=>{
  const f=environment({sharedLibrary:true});f.panels.paperChanged(paper);
  f.search.value='source backed';f.paperList.scrollTop=287;f.annotationsRoot.scrollTop=92;f.annotationsRoot.draft='Pending note';
  let selected=0;f.paperList.addEventListener('click',()=>selected++);
  f.ids.get('reading-sidebar-annotations').click();
  assert.equal(f.annotationsRoot.hidden,false);assert.equal(f.search.parentNode.hidden,true);
  f.ids.get('reading-sidebar-library').click();
  assert.equal(f.annotationsRoot.hidden,true);assert.equal(f.search.parentNode.hidden,false);
  assert.equal(f.search.value,'source backed');assert.equal(f.paperList.scrollTop,287);
  f.paperList.click();assert.equal(selected,1);
  f.ids.get('reading-sidebar-annotations').click();
  assert.equal(f.annotationsRoot.draft,'Pending note');assert.equal(f.annotationsRoot.scrollTop,92);
  assert.equal(f.panels.visible('annotations'),true);assert.equal(f.workspace.classList.contains('shared-sidebar-open'),true);
});

test('leaving reading restores the catalog body and returning restores the selected shared tab',()=>{
  const f=environment({sharedLibrary:true});f.panels.paperChanged(paper);f.panels.show('annotations');
  const shelf=f.ids.get('reading-sidebar-library-content'),header=f.ids.get('reading-sidebar-library').parentNode.parentNode;
  const changes=f.changes.length;
  f.panels.setReadingActive(false);
  assert.equal(header.hidden,true);assert.equal(shelf.hidden,false);assert.equal(f.annotationsRoot.hidden,true);
  assert.equal(f.workspace.classList.contains('shared-sidebar-open'),false);assert.equal(f.libraryRoot.dataset.sidebarPanel,'library');
  assert.equal(f.changes.length,changes,'Visibility coordination does not recursively publish a panel change');
  f.panels.setReadingActive(true);
  assert.equal(header.hidden,false);assert.equal(shelf.hidden,true);assert.equal(f.annotationsRoot.hidden,false);
  assert.equal(f.libraryRoot.dataset.sidebarPanel,'annotations');assert.equal(f.workspace.classList.contains('shared-sidebar-open'),true);
  f.ids.get('reading-sidebar-library').click();f.panels.setReadingActive(false);f.panels.setReadingActive(true);
  assert.equal(shelf.hidden,false);assert.equal(f.annotationsRoot.hidden,true);assert.equal(f.libraryRoot.dataset.sidebarPanel,'library');
});

test('moving the shared rail uses the same right-side preference and restores its side after catalog mode',()=>{
  const f=environment({sharedLibrary:true});f.panels.paperChanged(paper);f.panels.show('annotations');
  const rail=f.libraryRoot,annotations=f.annotationsRoot;
  f.ids.get('reading-sidebar-side').click();
  assert.equal(f.workspace.dataset.sidebarSide,'right');assert.equal(f.root.dataset.readingSide,'right');
  assert.equal(f.ids.get('reading-sidebar-side').getAttribute('aria-label'),'移至左侧');
  assert.equal(f.storage.get('preferences')['reading-panel-side'],'right');
  f.panels.setReadingActive(false);assert.equal(f.workspace.dataset.sidebarSide,'left');
  f.panels.setReadingActive(true);assert.equal(f.workspace.dataset.sidebarSide,'right');
  assert.equal(f.libraryRoot,rail);assert.equal(f.annotationsRoot,annotations);assert.equal(annotations.parentNode,rail);
});

test('narrow shared rail close clears its mobile-open state and Escape preserves the independent chat',()=>{
  const f=environment({sharedLibrary:true,width:430});f.panels.paperChanged(paper);f.panels.show('chat');f.panels.show('annotations');
  assert.equal(f.workspace.classList.contains('shared-sidebar-open'),true);
  f.ids.get('reading-sidebar-close').click();
  assert.equal(f.workspace.classList.contains('shared-sidebar-open'),false);assert.equal(f.annotationsRoot.hidden,true);
  assert.equal(f.panels.visible('chat'),true);
  f.ids.get('reading-sidebar-library').click();assert.equal(f.workspace.classList.contains('shared-sidebar-open'),true);
  f.ids.get('reading-sidebar-close').click();assert.equal(f.workspace.classList.contains('shared-sidebar-open'),false);
  f.panels.show('annotations');const event=f.libraryRoot.dispatch('keydown',{key:'Escape'});
  assert.equal(event.defaultPrevented,true);assert.equal(f.workspace.classList.contains('shared-sidebar-open'),false);
  assert.equal(f.panels.visible('annotations'),false);assert.equal(f.panels.visible('chat'),true);
});

test('shared tabs expose connected tab roles and keyboard navigation respects unavailable annotations',()=>{
  const f=environment({sharedLibrary:true}),library=f.ids.get('reading-sidebar-library'),annotations=f.ids.get('reading-sidebar-annotations'),tablist=library.parentNode;
  assert.equal(tablist.getAttribute('role'),'tablist');assert.equal(library.getAttribute('role'),'tab');assert.equal(annotations.getAttribute('role'),'tab');
  assert.equal(f.ids.get(library.getAttribute('aria-controls')).getAttribute('aria-labelledby'),library.id);
  assert.equal(f.annotationsRoot.getAttribute('aria-labelledby'),annotations.id);assert.equal(f.annotationsRoot.getAttribute('role'),'tabpanel');
  assert.equal(library.getAttribute('aria-selected'),'true');assert.equal(library.tabIndex,0);assert.equal(annotations.tabIndex,-1);assert.equal(annotations.disabled,true);
  tablist.dispatch('keydown',{key:'End',target:library});assert.equal(f.panels.visible('annotations'),false);assert.equal(f.toasts.length,0);
  f.panels.paperChanged(paper);const right=tablist.dispatch('keydown',{key:'ArrowRight',target:library});
  assert.equal(right.defaultPrevented,true);assert.equal(f.document.activeElement,annotations);assert.equal(annotations.getAttribute('aria-selected'),'true');assert.equal(annotations.tabIndex,0);assert.equal(library.tabIndex,-1);
  tablist.dispatch('keydown',{key:'Home',target:annotations});assert.equal(f.document.activeElement,library);assert.equal(library.getAttribute('aria-selected'),'true');
  tablist.dispatch('keydown',{key:'ArrowLeft',target:library});assert.equal(f.document.activeElement,annotations);assert.equal(f.panels.visible('annotations'),true);
  f.panels.paperChanged({...paper,archived:true});assert.equal(annotations.disabled,true);assert.equal(library.getAttribute('aria-selected'),'true');
});

test('annotation tab delegates initialization to its owner before opening shared content',()=>{
  let requests=0;const f=environment({sharedLibrary:true,onAnnotationsRequest:()=>requests++});f.panels.paperChanged(paper);
  f.ids.get('reading-sidebar-annotations').click();
  assert.equal(requests,1);assert.equal(f.annotationsRoot.hidden,true,'The caller decides when the current paper annotations are ready');
  f.panels.show('annotations');assert.equal(f.annotationsRoot.hidden,false);
});

test('shared rail disposal restores original library children and annotation roots, then removes new handlers',()=>{
  const f=environment({sharedLibrary:true});f.panels.paperChanged(paper);f.panels.show('annotations');f.panels.setSide('right');
  const tabs=f.ids.get('reading-sidebar-library').parentNode,header=tabs.parentNode,content=f.ids.get('reading-sidebar-library-content');
  f.search.value='Retained search';f.paperList.scrollTop=175;
  f.panels.dispose();f.panels.dispose();
  assert.deepEqual(f.libraryRoot.children,f.libraryChildren);assert.deepEqual(f.old.children,f.original);
  assert.equal(f.search.value,'Retained search');assert.equal(f.paperList.scrollTop,175);assert.equal(f.annotationsRoot.hidden,true);
  assert.equal(f.annotationsRoot.getAttribute('role'),null);assert.equal(f.annotationsRoot.getAttribute('aria-labelledby'),null);
  assert.equal(f.libraryRoot.classList.contains('shared-reading-sidebar'),false);assert.equal(f.libraryRoot.dataset.sidebarPanel,undefined);
  assert.equal(f.workspace.classList.contains('shared-sidebar-open'),false);assert.equal(f.workspace.dataset.sidebarSide,undefined);
  assert.equal(header.parentNode,null);assert.equal(content.parentNode,null);assert.equal(f.root.children.length,0);
  assert.equal(f.observers[0].disconnected,true);assert.equal(f.window.events.get('resize').size,0);assert.equal(f.libraryRoot.events.get('keydown').size,0);assert.equal(tabs.events.get('keydown').size,0);
  f.ids.get('reading-sidebar-annotations').click();assert.equal(f.annotationsRoot.hidden,true);assert.equal(f.workspace.classList.contains('shared-sidebar-open'),false);
});

test('rail resizer drags to a free width, persists it, and restores it in a fresh host',async()=>{
  const f=environment({sharedLibrary:true,width:1000});f.panels.paperChanged(paper);f.panels.show('annotations');
  const handle=f.ids.get('reading-rail-resizer');
  assert.ok(handle,'A resizer exists for the shared rail');
  assert.equal(handle.hidden,false);assert.equal(handle.getAttribute('role'),'separator');
  assert.equal(handle.getAttribute('aria-orientation'),'vertical');
  handle.dispatch('pointerdown',{button:0,pointerId:1,clientX:214});assert.equal(handle.classList.contains('is-active'),true);
  handle.dispatch('pointermove',{pointerId:1,clientX:320});
  assert.equal(f.workspace.style.values.get('--rail-width'),'320px');
  handle.dispatch('pointermove',{pointerId:1,clientX:5000});
  assert.equal(f.workspace.style.values.get('--rail-width'),'720px','Widths stay within the 160–720 px bound');
  handle.dispatch('pointermove',{pointerId:1,clientX:320});
  handle.dispatch('pointerup',{pointerId:1});
  assert.equal(handle.classList.contains('is-active'),false);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.storage.get('reader:layout').rail_width,320);
  handle.dispatch('keydown',{key:'ArrowRight'});
  assert.equal(f.workspace.style.values.get('--rail-width'),'328px','Keyboard nudges the divider');
  const restored=environment({sharedLibrary:true,width:1000,storage:f.storage});
  await restored.panels.ready;
  assert.equal(restored.workspace.style.values.get('--rail-width'),'328px','A fresh host restores the saved rail width');
  restored.panels.dispose();
  assert.equal(restored.workspace.style.values.has('--rail-width'),false,'Disposal clears the inline width');
});

test('rail resizer follows the rail side and hides when the rail is closed',()=>{
  const f=environment({sharedLibrary:true,width:1200});f.panels.paperChanged(paper);
  const handle=f.ids.get('reading-rail-resizer');
  assert.equal(handle.hidden,true,'No divider while the shared rail is closed');
  f.panels.show('annotations');assert.equal(handle.hidden,false);
  f.panels.setSide('right');
  handle.dispatch('pointerdown',{button:0,pointerId:2,clientX:1200});
  handle.dispatch('pointermove',{pointerId:2,clientX:900});
  assert.equal(f.workspace.style.values.get('--rail-width'),'300px','Right-side width is measured from the window edge');
  handle.dispatch('pointerup',{pointerId:2});
  f.panels.setReadingActive(false);
  assert.equal(f.workspace.dataset.sidebarSide,'left');
  f.panels.setReadingActive(true);
  assert.equal(f.workspace.style.values.get('--rail-width'),'300px','The chosen width survives mode switches');
});
