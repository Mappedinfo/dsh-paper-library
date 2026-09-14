import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {readerSnapshot} from '../src/client/conversation-context.mjs';

// Exercise the shipped application coordinators. Rendering and model/PDF
// transports are doubles; browser fixtures separately verify the actual layout.
const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
function snippet(name,endMarker){const start=source.indexOf(`async function ${name}(`),end=source.indexOf(endMarker,start);assert.ok(start>=0&&end>start);return source.slice(start,end);}
const tabSource=snippet('switchTab','function requestPage(');
const restoreSource=snippet('restoreReaderState','let pendingReferenceOpen');
const referenceSource=snippet('openReferencedPaper','async function initialize(');
const selectionSource=source.slice(source.indexOf('function showReaderSelection('),source.indexOf('async function loadAnnotations('));
function environment({table=false,readerId='paper-a',paper={id:'paper-a',pdf:true},panelValues={},snapshot=null}={}){
  const nodes=new Map(),calls=[],visibility=[],panels={annotations:false,metadata:false,chat:false,...panelValues};
  const element=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,open:false,value:'',dataset:{readingSide:'left'},classList:{toggle(){}},setAttribute(){},removeAttribute(){}});return nodes.get(id);};
  const context={state:{active:paper,tab:'reader',page:1,pageData:null,models:[],annotations:[]},readerPaperId:readerId,readerRestore:snapshot,restoringReader:false,
    $:element,document:{querySelectorAll:()=>[]},
    workbenchUI:{isTable:()=>table,setTable:value=>{table=value;calls.push(['table',value]);},header(){},edit:item=>{panels.metadata=true;calls.push(['edit',item.id]);}},
    readingPanels:{show:name=>{panels[name]=true;calls.push(['show',name]);},close:name=>{panels[name]=false;calls.push(['close',name]);},visible:name=>panels[name],setSide:side=>calls.push(['side',side])},
    paperChatUI:{visible:value=>visibility.push(value),available:()=>true,draft:()=>'',context:()=>({annotationRefs:[]}),restoreDraft:value=>calls.push(['draft',value]),restoreContext:value=>calls.push(['context',value])},
    readingShell:{setContext:value=>calls.push(['mode',value])},
    openPaper:async id=>{calls.push(['openPaper',id]);table=false;context.readerPaperId=id;context.state.active={...paper,id};},
    requestPage:async page=>{calls.push(['page',page]);context.state.page=page;context.state.pageData={width:600,height:800};},
    loadAnnotations:async id=>calls.push(['annotations',id]),renderAnnotations(){},loadFeedback:id=>calls.push(['feedback',id]),loadModels(){},
    loadGraph:async()=>calls.push(['graph']),publishReaderState:()=>calls.push(['publish']),currentHarnessRoute:()=>null,toast:(...args)=>calls.push(['toast',...args]),
    openAnnotation:()=>{throw new Error('This fixture has no annotation dialog draft');},
    clearSelection:()=>{context.state.selection=null;element('selection-tools').hidden=true;},initializedReader:true,pendingReferenceOpen:null,
  };
  vm.createContext(context);vm.runInContext(tabSource+'\n'+selectionSource+'\n'+restoreSource+'\n'+referenceSource,context,{filename:'web/app.js:reading-coordinators'});
  return {context,calls,visibility,panels,element,isTable:()=>table};
}

test('entering a reading panel from a newly selected catalogue row first initializes the whole paper',async()=>{
  const f=environment({table:true,readerId:'paper-a',paper:{id:'paper-b',pdf:true}});
  await f.context.switchTab('conversation');
  assert.deepEqual(f.calls[0],['openPaper','paper-b']);assert.equal(f.context.readerPaperId,'paper-b');assert.equal(f.isTable(),false);
  assert.ok(f.calls.findIndex(value=>value[0]==='show')>0);assert.equal(f.panels.chat,true);assert.deepEqual(f.visibility,[true]);
  assert.equal(f.context.state.tab,'conversation');assert.equal(f.element('reading-workspace').hidden,false);
});

test('returning from the catalogue to the already opened paper preserves its reader without reopening it',async()=>{
  const f=environment({table:true,panelValues:{chat:true}});f.context.state.pageData={width:600,height:800};
  await f.context.switchTab('reader');
  assert.equal(f.isTable(),false);assert.equal(f.calls.filter(value=>value[0]==='openPaper').length,0);assert.equal(f.calls.filter(value=>value[0]==='page').length,0);
  assert.deepEqual(f.visibility,[true]);
});

test('graph navigation hides floating chat and avoids a PDF page request even if its panel remains open',async()=>{
  const f=environment({panelValues:{chat:true}});await f.context.switchTab('graph');
  assert.equal(f.element('reading-workspace').hidden,true);assert.equal(f.element('graph-tab').hidden,false);assert.deepEqual(f.visibility,[false]);
  assert.equal(f.calls.filter(value=>value[0]==='page').length,0);assert.equal(f.calls.filter(value=>value[0]==='graph').length,1);
});

test('a superseded catalogue open cannot activate the requested panel for a different paper',async()=>{
  const f=environment({table:true,readerId:'paper-a',paper:{id:'paper-b',pdf:true}});
  f.context.openPaper=async()=>{f.context.state.active={id:'paper-c',pdf:true};};
  await f.context.switchTab('conversation');
  assert.equal(f.context.state.tab,'reader');assert.equal(f.panels.chat,false);assert.deepEqual(f.visibility,[]);
});

for(const oldTab of ['conversation','annotations'])test(`restoring closed panels overrides the old ${oldTab} tab instead of reopening them`,async()=>{
  const snapshot={paperId:'paper-a',page:1,tab:oldTab,chatDraft:'Unsent question',chatContext:{annotationRefs:[]},panels:{side:'right',annotations:false,metadata:false,chat:false}};
  const f=environment({paper:{id:'paper-a',pdf:false},snapshot});await f.context.restoreReaderState();
  assert.equal(f.context.state.tab,'reader');assert.deepEqual(f.panels,{annotations:false,metadata:false,chat:false});
  assert.equal(f.calls.filter(value=>value[0]==='show').length,0);assert.ok(f.visibility.every(value=>value===false));
  assert.ok(f.calls.some(value=>value[0]==='draft'&&value[1]==='Unsent question'));assert.equal(f.context.restoringReader,false);
});

test('table visibility callbacks never resume polling behind the graph or under a different paper identity',()=>{
  const match=source.match(/tableChanged: (table => \{[^\n]+\}),\n/);assert.ok(match,'The production callback must be tested');
  const visibility=[],context={state:{tab:'graph',active:{id:'paper-a'}},readerPaperId:'paper-a',readingPanels:{visible:()=>true},paperChatUI:{visible:value=>visibility.push(value)},readingShell:{sync(){}},queueMicrotask:fn=>fn()};
  vm.createContext(context);const callback=vm.runInContext(`(${match[1]})`,context);
  callback(false);context.state.tab='reader';context.readerPaperId='other-paper';callback(false);
  context.readerPaperId='paper-a';callback(true);callback(false);
  assert.deepEqual(visibility,[false,false,false,true]);
});

test('an unsaved reader selection survives the host snapshot and restores its source page and action bar',async()=>{
  const selection={page:3,text:'Synthetic unsaved passage',rects:[[10,20,100,35]]};
  const snapshot=readerSnapshot({paperId:'paper-a',page:1,tab:'reader',readerSelection:selection,chatDraft:''});
  const f=environment({snapshot});await f.context.restoreReaderState();
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.state.selection)),{...selection,id:'paper-a'});
  assert.equal(f.element('selection-tools').hidden,false);assert.match(f.element('selection-count').textContent,/第 3 页/);
  assert.equal(f.element('selection-preview').textContent,selection.text);
});

test('selection changes publish only the current paper coordinates and clearing publishes their removal',()=>{
  const f=environment(),messages=[];
  f.context.window={parent:{postMessage:value=>messages.push(value)},location:{origin:'http://localhost:43121'}};f.context.Blob=Blob;
  const start=source.indexOf('function publishReaderState()'),end=source.indexOf('async function restoreReaderState()',start);
  vm.runInContext(source.slice(start,end),f.context);
  const selection={id:'paper-a',page:2,text:'Synthetic selected text',rects:[[1,2,8,9]]};
  f.context.showReaderSelection(selection);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].snapshot.readerSelection)),{page:2,text:selection.text,rects:selection.rects});
  f.context.showReaderSelection({...selection,id:'another-paper'});assert.equal(messages.length,1,'A stale PDF callback cannot relabel its selection');
  f.context.showReaderSelection(null);assert.equal(messages.length,2);assert.equal(messages[1].snapshot.readerSelection,undefined);
});

test('reader selection snapshots reject excess or invalid coordinates and detach retained arrays',()=>{
  const base={paperId:'paper-a',page:1,tab:'reader',chatDraft:''},selection={page:1,text:'x',rects:[[1,2,3,4]]};
  const frozen=readerSnapshot({...base,readerSelection:selection});selection.rects[0][0]=99;assert.equal(frozen.readerSelection.rects[0][0],1);
  assert.throws(()=>readerSnapshot({...base,readerSelection:{...selection,text:'x'.repeat(20001)}}));
  assert.throws(()=>readerSnapshot({...base,readerSelection:{...selection,rects:Array.from({length:201},()=>[1,2,3,4])}}));
  assert.throws(()=>readerSnapshot({...base,readerSelection:{...selection,rects:[[1,2,NaN,4]]}}));
});

test('external reference navigation preserves an open annotation draft until the user finishes or closes it',async()=>{
  const f=environment();f.element('annotation-dialog').open=true;f.element('annotation-comment').value='Unsaved thought';
  f.context.state.annotationDraft={id:'paper-a',page:2,mode:'highlight'};
  await f.context.openReferencedPaper({paperId:'paper-b',page:3});
  assert.equal(f.context.state.active.id,'paper-a');assert.equal(f.element('annotation-comment').value,'Unsaved thought');assert.equal(f.element('annotation-dialog').open,true);
  assert.equal(f.calls.filter(value=>value[0]==='openPaper').length,0);assert.ok(f.calls.some(value=>value[0]==='toast'));
  f.element('annotation-dialog').open=false;await f.context.openReferencedPaper({paperId:'paper-b',page:3});
  assert.equal(f.context.state.active.id,'paper-b');assert.equal(f.context.state.page,3);
});

test('references received before reader initialization stay pending without opening a paper',async()=>{
  const f=environment(),reference={paperId:'paper-b',page:3};f.context.initializedReader=false;
  await f.context.openReferencedPaper(reference);assert.equal(f.context.pendingReferenceOpen,reference);assert.equal(f.calls.length,0);
});
