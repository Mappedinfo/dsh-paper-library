/** Current UI screenshots using only generic reading, thinking and writing content.
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/capture-learning-demo.mjs
 * Each run owns a fresh synthetic library and state home. No existing user host,
 * profile, document collection or model service is opened.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/learning-demo-'));
const library=join(run,'library'),source=join(run,'source'),python=join(project,'.venv/bin/python');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const normalize=text=>text.replace(/\s+/g,' ').trim();
const titles=['How to read a paragraph','How to ask a clear question','How to revise a draft'];
const citekeys=['LearningReading2026','LearningThinking2026','LearningWriting2026'];
const tags=[['reading','learning'],['thinking','learning'],['writing','learning']];
const body=[
  'This synthetic document is for testing reading and annotation. It makes no scientific claim.',
  "A useful reading note connects the author's claim to its supporting evidence. Select this sentence and save a highlight with a question.",
  'Read one paragraph, summarize it in your own words, and write one question. Revise a sentence to make its meaning clearer.',
  'Portable annotations are stored in the PDF document. Copying the PDF should preserve the note, author and page location.',
  'The library loads a small window of pages while scrolling. Search retrieves bounded records from an index on disk.',
];
const generated=spawnSync(python,['scripts/create-demo.py','--output',source],{cwd:project,encoding:'utf8',timeout:30000});
assert.equal(generated.status,0,generated.stderr);
const fixture=JSON.parse(await readFile(join(source,'zotero-export.json'),'utf8'));
assert.equal(fixture.items.length,3);
for(const [index,item]of fixture.items.entries()){
  assert.deepEqual(Object.keys(item).sort(),['id','citationKey','itemType','title','creators','date','publicationTitle','tags','attachments'].sort());
  assert.equal(item.id,`demo-${index+1}`);assert.equal(item.title,titles[index]);assert.equal(item.citationKey,citekeys[index]);
  assert.equal(item.itemType,'journalArticle');assert.equal(item.date,'2026');assert.equal(item.publicationTitle,'Synthetic Reading Examples');
  assert.deepEqual(item.creators,[{creatorType:'author',name:'Learning Demo',fieldMode:1}]);
  assert.deepEqual(item.tags,tags[index].map(tag=>({tag})));
  assert.deepEqual(item.attachments,[{path:join(source,`example-${index+1}.pdf`),contentType:'application/pdf'}]);
}
const extracted=spawnSync(python,['-c',`import json,sys,pymupdf
from pathlib import Path
out=[]
for path in sorted(Path(sys.argv[1]).glob('*.pdf')):
    with pymupdf.open(path) as doc:
        out.append({'name':path.name,'metadata':doc.metadata,'pages':[page.get_text() for page in doc]})
print(json.dumps(out))`,source],{encoding:'utf8',timeout:30000});
assert.equal(extracted.status,0,extracted.stderr);
const pdfs=JSON.parse(extracted.stdout);assert.equal(pdfs.length,3);
for(const [index,pdf]of pdfs.entries()){
  assert.equal(pdf.name,`example-${index+1}.pdf`);assert.equal(pdf.metadata.title,titles[index]);assert.equal(pdf.metadata.author,'Learning Demo');
  assert.equal(pdf.metadata.subject,'');assert.equal(pdf.metadata.keywords,'');assert.equal(pdf.pages.length,3);
  for(const [page,text]of pdf.pages.entries())assert.equal(normalize(text),normalize(['PAPER LIBRARY / SYNTHETIC READING EXAMPLE',titles[index],'Learning Demo | Learning methods example | 2026',...body,`Synthetic fixture / page ${page+1}`].join(' ')));
}
const sourceHashes=await Promise.all([1,2,3].map(n=>hash(join(source,`example-${n}.pdf`))));
await writeFile(join(run,'approved-source-readback.json'),JSON.stringify({metadata:fixture.items.map(({attachments,...item})=>item),pdfs},null,2)+'\n');
const imported=await core({action:'import',path:join(source,'zotero-export.json')},{library,python});
const papers=titles.map(title=>imported.items.find(item=>item.title===title));assert.ok(papers.every(Boolean));
const paper=papers[0],layout=await core({action:'page',id:paper.id,page:1,scale:.8},{library,python});
function rects(text){
  const tokens=text.split(/\s+/),words=layout.words,start=words.findIndex((_,i)=>tokens.every((token,j)=>words[i+j]?.[4]===token));
  assert.ok(start>=0,'Approved learning passage exists in the PDF');
  const lines=new Map();
  for(const word of words.slice(start,start+tokens.length)){
    const key=`${word[5]}:${word[6]}`,prior=lines.get(key);
    lines.set(key,prior?[Math.min(prior[0],word[0]),Math.min(prior[1],word[1]),Math.max(prior[2],word[2]),Math.max(prior[3],word[3])]:word.slice(0,4));
  }
  return [...lines.values()];
}
const notes=[
  {type:'highlight',text:'Read one paragraph, summarize it in your own words, and write one question.',comment:'先用自己的话复述这一段，再写下一个还没有想清楚的问题。',color:'#ffdb66'},
  {type:'underline',text:'Revise a sentence to make its meaning clearer.',comment:'修改时保留原意，把一句话写得更清楚。',color:'#2455a4'},
];
for(const note of notes)await core({action:'annotate',id:paper.id,page:1,...note,rects:rects(note.text),author:'Learning Demo'},{library,python});
const localState=createLocalStateStore({library,home:join(run,'home')}),handle=createFetchHandler({library,python,localState});
const server=createServer(async(req,res)=>{
  try{
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
  }catch{res.writeHead(500);res.end('Synthetic learning screenshot host failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const call=async input=>{const result=await(await fetch(`${origin}/api`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).json();assert.ok(result.ok,result.error);return result.result;};
const steps=[['read','阅读\n预览 · 提问 · 复述'],['think','思考\n列出理由 · 找反例\n保留疑问'],['write','写作\n列提纲 · 写短稿 · 校对'],['return','返回阅读\n带着新问题再读一遍']];
const nodes=steps.map(([id,text],index)=>({id,kind:'note',x:index*340,y:160,w:260,h:160,text}));
nodes.push({id:'heading',kind:'text',x:0,y:0,w:1280,h:46,text:'学习循环：读一段，想清楚，再写下来。'});
for(const [index,item]of papers.entries())nodes.push({id:`document-${index}`,kind:'paper',x:index*340,y:430,w:260,h:130,text:titles[index],paper:{id:item.id,title:titles[index],year:2026,citekey:citekeys[index]}});
const edges=steps.slice(0,3).map(([id],index)=>({id:`step-${index}`,from:id,to:steps[index+1][0],kind:'arrow'}));
edges.push({id:'read-again',from:'return',to:'read',kind:'elbow',label:'再读一遍',waypoints:[[1150,85],[130,85]]});
for(const [index,[id]]of steps.slice(0,3).entries())edges.push({id:`practice-${index}`,from:id,to:`document-${index}`,kind:'line',arrow:'none',dashed:true,label:'练习文档'});
const boardInput={title:'阅读 → 思考 → 写作 → 返回阅读',nodes,edges,links:{papers:papers.map(item=>item.id)}};
const screenshots=[],checks=['Generated source metadata and every page of all three PDFs exactly match the approved generic learning content.'],errors=[],external=[],actions=[];
let browser,page,failure;
try{
  const board=await call({action:'board_create',board:boardInput});
  await writeFile(join(run,'approved-board-input.json'),JSON.stringify(boardInput,null,2)+'\n');
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:720},deviceScaleFactor:1,colorScheme:'light'});page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());if(request.url().endsWith('/api'))try{actions.push(request.postDataJSON().action);}catch{}});
  const capture=async(name,description)=>{const path=join(project,'docs/images',`${name}.jpg`);await page.screenshot({path,type:'jpeg',quality:94});screenshots.push({file:relative(project,path),description,...page.viewportSize(),sha256:await hash(path)});};
  const ready=()=>page.waitForFunction(()=>{const sheet=document.querySelector('.pdr-sheet[data-pdf-page="1"]'),image=sheet?.querySelector('.pdr-page-image');return image?.complete&&image.naturalWidth>0&&sheet.querySelectorAll('.pdr-word').length>0&&!pdfReader.getSnapshot().inFlightPage;});
  await page.goto(origin);await page.waitForLoadState('networkidle');await page.waitForFunction(()=>initializedReader&&!restoringReader);
  await page.locator('#workspace-library').click();await page.locator('#catalog-table tbody tr').first().waitFor();
  assert.equal(await page.locator('#catalog-table tbody tr').count(),3);
  assert.deepEqual((await page.locator('#catalog-table .table-title').allTextContents()).sort(),[...titles].sort());
  await page.locator('#board-shelf summary').click();await page.locator('#board-shelf-list').getByText(boardInput.title,{exact:true}).waitFor();
  await capture('learning-library','Current library with exactly three generic reading, thinking and writing documents, authored by Learning Demo.');
  checks.push('The visible library contains only the three approved learning titles and a generic learning-loop board.');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#catalog-table .table-title').filter({hasText:titles[0]}).click();await ready();
  await page.locator('#reading-sidebar-annotations').click();await page.locator('.annotation-card').first().waitFor();
  const separator=await page.locator('#reading-rail-resizer').boundingBox();
  await page.mouse.move(separator.x+separator.width/2,separator.y+80);await page.mouse.down();await page.mouse.move(340,separator.y+80,{steps:8});await page.mouse.up();await ready();
  assert.equal(await page.locator('.annotation-card').count(),2);await page.locator('#toast').waitFor({state:'hidden'});
  const saved=await core({action:'annotations',id:paper.id},{library,python});
  assert.equal(saved.annotations.length,2);
  for(const note of notes){const actual=saved.annotations.find(item=>item.type===note.type);assert.equal(actual.text,note.text);assert.equal(actual.comment,note.comment);assert.equal(actual.author,'Learning Demo');}
  await capture('learning-annotations','Current PDF reader with a learning passage, native highlight and underline, and comments about restating a paragraph and clarifying a sentence.');
  checks.push('Native PDF annotations and displayed cards match the approved learning quotations, comments and Learning Demo author.');
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#board-open').click();await page.locator('#board-view').waitFor();
  await page.waitForFunction(id=>document.querySelector('#board-select')?.value===id,board.board.id);
  await page.locator('#board-focus').click();await page.locator('#board-fit').click();
  await page.waitForFunction(()=>document.getElementById('board-status')?.textContent==='已保存');await page.locator('#toast').waitFor({state:'hidden'});
  assert.equal(await page.locator('.board-node').count(),8);assert.equal(await page.locator('[data-edge-path]').count(),7);
  const reread=await call({action:'board_get',id:board.board.id});
  const lexical=node=>({id:node.id,kind:node.kind,text:node.text,...(node.paper?{paper:node.paper}:{})});
  assert.deepEqual(reread.board.nodes.map(lexical),nodes.map(lexical));assert.equal(reread.board.title,boardInput.title);
  assert.deepEqual(reread.board.edges.map(({origin,...edge})=>edge),edges);
  await writeFile(join(run,'approved-board-readback.json'),JSON.stringify(reread.board,null,2)+'\n');
  await capture('learning-board','A generic linear learning loop: reading, thinking, writing, and returning to reading; the first three stages link to their corresponding practice documents.');
  checks.push('Persisted board text, paper bindings and every edge exactly match the approved learning loop; no prior graph structure is reused.');
  assert.deepEqual(await Promise.all([1,2,3].map(n=>hash(join(source,`example-${n}.pdf`)))),sourceHashes);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  assert.ok(!actions.some(action=>['handwriting_recognize','ai_feedback','chat_send','language_generate','library_feedback','latex_ai_ask','latex_ai_propose'].includes(action)));
  checks.push('Generated original PDFs unchanged; zero external requests, model generation calls and browser errors.');
}catch(error){failure=error;if(page)await page.screenshot({path:join(run,'failure.png')}).catch(()=>{});}
finally{await browser?.close();await handle.disposeInkQueue?.();await new Promise(resolve=>server.close(resolve));}
const receipt={captured_at:new Date().toISOString(),complete:!failure,synthetic:true,content_scope:'Generic learning methods only: reading, thinking and writing.',source_generator:'scripts/create-demo.py',capture_script:'scripts/capture-learning-demo.mjs',runtime_directory:relative(project,run),screenshots,checks,approved_titles:titles,author:'Learning Demo',private_documents_read:0,external_requests:external.length,model_requests:0,browser_errors:errors,api_actions:[...new Set(actions)].sort(),limitations:['Three generated learning documents only; no personal topic, plan or project structure.','Annotations and board contents are explicitly seeded through normal APIs, without simulated AI output.','Screenshots are direct Chromium captures with existing UI controls, without retouching or DOM/style overrides.','This standalone demo does not establish physical Pencil behavior or live DSH model output.'],...(failure?{error:failure.message}:{})};
await writeFile(join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
if(failure){console.error(`Learning screenshot diagnostics: ${relative(project,run)}`);throw failure;}
await writeFile(join(project,'docs/community/learning-demo.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({run:relative(project,run),screenshots:screenshots.map(value=>value.file),checks:checks.length}));
