/** Current project screenshots from an isolated synthetic library and real UI.
 * Reuses create-demo.py, the source generator used by prepare-promotion-demo.mjs.
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/capture-project-demo.mjs
 * No private library, DSH profile, external service or model is accessed.
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
const run=await mkdtemp(join(project,'.local/project-demo-'));
const library=join(run,'library'),source=join(run,'source'),python=join(project,'.venv/bin/python');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const generated=spawnSync(python,['scripts/create-demo.py','--output',source],{cwd:project,encoding:'utf8',timeout:30000});
assert.equal(generated.status,0,generated.stderr);
const hashes=await Promise.all([1,2,3].map(n=>hash(join(source,`example-${n}.pdf`))));
const imported=await core({action:'import',path:join(source,'zotero-export.json')},{library,python});
const papers=imported.items;
assert.equal(papers.length,3);
const metadataTitles=['Keeping evidence close to the claim','Choosing spatial units for comparison','Tracing assumptions in urban models','Reading uncertainty in reported results','From reading notes to a research question'];
const extras=await core({action:'import',items:metadataTitles.map((title,index)=>({id:`project-demo-extra-${index}`,title,author:[{literal:'Paper Library demo'}],issued:{'date-parts':[[2026]]},'container-title':'Synthetic Reading Examples',citationKey:`DemoReading${index+1}`,tags:['synthetic example','reading methods']}))},{library,python});
const readingProject=await core({action:'project_create',title:'阅读方法与证据 · 合成示例',description:'八条合成文献用于展示项目组织、阅读与批注，不对应真实研究。',tags:['synthetic','reading']},{library,python});
const comparisonProject=await core({action:'project_create',title:'空间表征与比较 · 合成示例',description:'三篇合成 PDF 的交叉阅读清单。',tags:['synthetic','comparison']},{library,python});
for(const item of [...papers,...extras.items])await core({action:'project_link',id:readingProject.project.id,paper_id:item.id},{library,python});
for(const item of papers)await core({action:'project_link',id:comparisonProject.project.id,paper_id:item.id},{library,python});
const paper=papers.find(item=>item.title==='Reading urban change');
const selected=await core({action:'page',id:paper.id,page:1,scale:.8},{library,python});
function rects(text){
  const tokens=text.split(/\s+/),words=selected.words;
  const start=words.findIndex((_,i)=>tokens.every((token,j)=>words[i+j]?.[4]===token));
  assert.ok(start>=0,`Passage exists: ${text}`);
  const lines=new Map();
  for(const word of words.slice(start,start+tokens.length)){
    const key=`${word[5]}:${word[6]}`,prior=lines.get(key);
    lines.set(key,prior?[Math.min(prior[0],word[0]),Math.min(prior[1],word[1]),Math.max(prior[2],word[2]),Math.max(prior[3],word[3])]:word.slice(0,4));
  }
  return [...lines.values()];
}
const notes=[
  {type:'highlight',text:"A useful reading note connects the author's claim to its supporting evidence.",comment:'阅读问题：这项主张依赖什么证据？把问题留在对应原文旁，继续阅读时再核对。',color:'#ffdb66'},
  {type:'underline',text:'What evidence would change the conclusion?',comment:'比较时同时记录假设与反例，不把一个更高的分数直接等同于更好的解释。',color:'#2455a4'},
];
for(const note of notes)await core({action:'annotate',id:paper.id,page:1,...note,rects:rects(note.text),author:'Paper Library demo'},{library,python});

const localState=createLocalStateStore({library,home:join(run,'home')});
const handle=createFetchHandler({library,python,localState});
const server=createServer(async(req,res)=>{
  try{
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
  }catch{res.writeHead(500);res.end('Synthetic screenshot host failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const call=async input=>{const result=await (await fetch(`${origin}/api`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).json();assert.ok(result.ok,result.error);return result.result;};
const root={id:'question',kind:'concept',x:0,y:228,w:260,h:142,text:'城市变化如何被解释？\n从主张、表征到比较',color:'#4176e6'};
const branches=[
  ['Reading urban change','研究对象','主张与证据\n观察到了什么变化？\n什么材料支持这一判断？','#22864a'],
  ['A guide to spatial representations','空间表征','尺度与假设\n如何描述空间关系？\n换一个尺度是否仍然成立？','#6b4fd8'],
  ['Designing a useful comparison','比较设计','条件与反例\n数据、指标与预算是否一致？\n什么证据会改变结论？','#88520f'],
];
const nodes=[root],edges=[];
for(const [index,[title,label,text,color]] of branches.entries()){
  const item=papers.find(item=>item.title===title),id=`paper-${index}`,noteId=`question-${index}`,y=index*218;
  nodes.push({id,kind:'paper',x:365,y,w:310,h:142,text:item.title,paper:{id:item.id,title:item.title,year:2026,citekey:item.citekey},color});
  nodes.push({id:noteId,kind:'note',x:780,y,w:320,h:142,text,color});
  edges.push({id:`source-${index}`,from:'question',to:id,kind:'elbow',relation:'related',label});
  edges.push({id:`read-${index}`,from:id,to:noteId,kind:'arrow',relation:'related',label:'阅读问题'});
}
nodes.push({id:'provenance',kind:'text',x:300,y:650,w:780,h:44,text:'合成示例 · 连线组织阅读问题，不代表真实引文或已验证的学术关系。'});
const board=await call({action:'board_create',board:{title:'从问题到证据 · 合成阅读示例',nodes,edges,links:{papers:papers.map(item=>item.id),projects:[readingProject.project.id,comparisonProject.project.id]}}});
const screenshots=[],checks=[],errors=[],external=[],actions=[];
let browser,page,failure;
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,colorScheme:'light'});
  page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());if(request.url().endsWith('/api'))try{actions.push(request.postDataJSON().action);}catch{}});
  const capture=async(name,description)=>{const path=join(project,'docs/images',`${name}.jpg`);await page.screenshot({path,type:'jpeg',quality:94});screenshots.push({file:relative(project,path),description,width:1440,height:1000,sha256:await hash(path)});};
  const ready=()=>page.waitForFunction(()=>{const sheet=document.querySelector('.pdr-sheet[data-pdf-page="1"]'),image=sheet?.querySelector('.pdr-page-image');return image?.complete&&image.naturalWidth>0&&sheet.querySelectorAll('.pdr-word').length>0&&!pdfReader.getSnapshot().inFlightPage;});
  await page.goto(origin);await page.waitForLoadState('networkidle');await page.waitForFunction(()=>initializedReader&&!restoringReader);
  await page.locator('#workspace-library').click();await page.locator('#catalog-table tbody tr').first().waitFor();
  await page.locator('#project-select').selectOption(readingProject.project.id);await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#catalog-table tbody tr').count(),8);
  await page.locator('#board-shelf summary').click();await page.locator('#board-shelf-list').getByText('从问题到证据 · 合成阅读示例',{exact:true}).waitFor();
  await capture('project-library','Current catalog table with eight synthetic records (three generated PDFs and five metadata-only entries), import/export controls and the linked literature board.');
  assert.equal(await page.locator('#project-select option').count(),3);
  checks.push('Current library table displays eight synthetic records, two real reading projects and the saved board.');
  await page.locator('#catalog-table .table-title').filter({hasText:'Reading urban change'}).click();await ready();
  await page.locator('#reading-sidebar-annotations').click();await page.locator('.annotation-card').first().waitFor();
  const separator=await page.locator('#reading-rail-resizer').boundingBox();
  await page.mouse.move(separator.x+separator.width/2,separator.y+80);await page.mouse.down();await page.mouse.move(340,separator.y+80,{steps:8});await page.mouse.up();await ready();
  assert.equal(await page.locator('.annotation-card').count(),2);
  await page.locator('#toast').waitFor({state:'hidden'});
  await capture('project-annotations','Current PDF reader with native highlight and underline, source quotations and reader comments in the shared annotation rail.');
  const saved=await core({action:'annotations',id:paper.id},{library,python});
  assert.deepEqual(saved.annotations.map(note=>note.type).sort(),['highlight','underline']);
  checks.push('Both visible annotation cards are recovered from standard PDF objects with the expected source text and comments.');
  await page.locator('#board-open').click();await page.locator('#board-view').waitFor();
  await page.waitForFunction(id=>document.querySelector('#board-select')?.value===id,board.board.id);
  await page.locator('#board-focus').click();
  await page.locator('#board-fit').click();await page.waitForTimeout(300);
  assert.equal(await page.locator('.board-node').count(),8);assert.equal(await page.locator('[data-edge-path]').count(),6);
  await page.locator('#toast').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.getElementById('board-status')?.textContent==='已保存');
  await capture('project-board','Current literature whiteboard links three synthetic paper nodes to explicit reading questions, with six user-authored relationships and a synthetic provenance note.');
  const reread=await call({action:'board_get',id:board.board.id});assert.equal(reread.board.nodes.length,8);assert.equal(reread.board.edges.length,6);
  checks.push('The visible whiteboard matches the real persisted host record: three bound paper nodes, five conceptual/text nodes and six links.');
  assert.deepEqual(await Promise.all([1,2,3].map(n=>hash(join(source,`example-${n}.pdf`)))),hashes);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  assert.ok(!actions.some(action=>['handwriting_recognize','ai_feedback','chat_send','language_generate','library_feedback','latex_ai_ask','latex_ai_propose'].includes(action)));
  checks.push('Generated original PDFs unchanged; no external request, model action, private source or browser error.');
}catch(error){failure=error;if(page)await page.screenshot({path:join(run,'failure.png')}).catch(()=>{});}
finally{await browser?.close();await handle.disposeInkQueue?.();await new Promise(resolve=>server.close(resolve));}
const receipt={captured_at:new Date().toISOString(),complete:!failure,synthetic:true,source_generator:'scripts/create-demo.py',capture_script:'scripts/capture-project-demo.mjs',runtime_directory:relative(project,run),mode:'Current standalone Chromium UI, light theme, 1440 × 1000 CSS pixels',screenshots,checks,private_documents_read:0,external_requests:external.length,model_requests:0,browser_errors:errors,api_actions:[...new Set(actions)].sort(),limitations:['Eight paper titles and metadata records and all three PDF passages are synthetic demonstration content; five additional records have no PDF.','Annotations and board contents are deliberately seeded through normal core/HTTP APIs, with no fabricated AI output.','Links are user-authored reading questions, not real citations or verified scientific relationships.','Screenshots are direct browser JPEG captures without retouching or DOM/style overrides.'],...(failure?{error:failure.message}:{})};
await writeFile(join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
if(failure){console.error(`Screenshot diagnostics: ${relative(project,run)}`);throw failure;}
await writeFile(join(project,'docs/community/project-demo.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({run:relative(project,run),screenshots:screenshots.map(value=>value.file),checks:checks.length}));
