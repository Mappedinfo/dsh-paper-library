/** Reproducible two-browser language/durable-state acceptance; synthetic PDFs and local model double only. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {core,dispatch} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';
import {createLanguageLearning} from '../src/harness/language-learning.mjs';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/language-browser-')),library=join(run,'library'),home=join(run,'dsh-home'),source=join(run,'source'),python=join(project,'.venv/bin/python');
const made=spawnSync(python,['scripts/create-reader-demo.py','--output',source],{cwd:project,encoding:'utf8'});assert.equal(made.status,0,made.stderr);
const originals=['continuous-reader-synthetic.pdf','second-reader-synthetic.pdf'];
const hash=async name=>createHash('sha256').update(await readFile(join(source,name))).digest('hex');
const originalHashes=await Promise.all(originals.map(hash));
const [paper,second]=(await core({action:'import',path:join(source,'reader-export.json')},{library,python})).items;
const store=createLocalStateStore({library,home});const errors=[],external=[],calls=[],checks=[],screenshots=[];
let modelCalls=0,browser,server,modelFailure=false,held=null;
const record=name=>{checks.push(name);console.log(`PASS ${name}`);};
const ai=async request=>{
  modelCalls++;calls.push({provider:request.provider,model:request.model});
  if(held){const wait=held;held=null;await wait;}
  if(modelFailure){modelFailure=false;throw new Error('Synthetic interrupted language response');}
  const quoted=JSON.parse(request.prompt.split('SOURCE_JSON:\n')[1]).text;
  const term=quoted.includes('epistemic')?'epistemic':quoted.includes('Evidence')?'Evidence':quoted.split(/\s+/).find(Boolean);
  return JSON.stringify({result:request.prompt.includes('Improve')?'An improved synthetic expression.':'这是用于验证的中文译文。',explanation:'Synthetic language explanation; no research claim.',vocabulary:[{term,meaning:'合成测试释义',source_sentence:quoted},{term:'inventedUnseenTerm',meaning:'must be rejected',source_sentence:quoted}]});
};
const languageLearning=createLanguageLearning({store,ai,paperChat:async()=>({sessionId:'synthetic-session',model:{provider:'synthetic-provider',model:'paper-current-model'}}),dispatch,library,python});
const handler=createFetchHandler({library,python,localState:store,languageLearning,loopbackOnly:true});
async function start(){
  server=createServer(async(req,res)=>{try{const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const reply=await handler(request);res.writeHead(reply.status,Object.fromEntries(reply.headers));if(reply.body)Readable.fromWeb(reply.body).pipe(res);else res.end();}catch(error){res.writeHead(500);res.end(error.message);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;
}
const origin=await start();
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
  async function pageFor(width=741){const context=await browser.newContext({viewport:{width,height:width===430?800:597},acceptDownloads:true});await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());});await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('Browser storage writes are forbidden in this fixture');};});await page.goto(origin);await page.waitForLoadState('networkidle');return page;}
  const first=await pageFor();
  const screenshot=async(page,name)=>{const path=join(run,`${name}.png`);await page.screenshot({path});screenshots.push(relative(project,path));};
  const call=(page,action,args={})=>page.evaluate(async({action,args})=>{const response=await fetch('./api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...args})});return response.json();},{action,args});
  await first.locator('#search').fill(paper.title);await first.locator(`.paper-card[data-id="${paper.id}"]`).click();await first.locator('.pdr-page-image').first().waitFor();
  const passage='Evidence sentence for standard PDF annotation.';
  const startWord=await first.locator('.pdr-sheet[data-pdf-page="1"] .pdr-word').filter({hasText:/^Evidence\s*$/}).boundingBox();
  const endWord=await first.locator('.pdr-sheet[data-pdf-page="1"] .pdr-word').filter({hasText:/^annotation\.\s*$/}).first().boundingBox();
  await first.mouse.move(startWord.x+1,startWord.y+startWord.height/2);await first.mouse.down();await first.mouse.move(endWord.x+endWord.width-1,endWord.y+endWord.height/2,{steps:16});await first.mouse.up();
  await first.locator('#language-selection-translate').waitFor({state:'visible'});await first.locator('#language-selection-translate').click();await first.locator('#language-result .language-answer').first().waitFor();
  assert.match(await first.locator('#language-result').innerText(),/中文译文/);assert.equal(modelCalls,1);assert.deepEqual(calls[0],{provider:'synthetic-provider',model:'paper-current-model'});record('selected-pdf-text-translates-directly-through-authoritative-paper-model');await screenshot(first,'translation-selected-741');
  await first.locator('#language-tab-words').click();await first.locator('.vocabulary-card').waitFor();assert.equal(await first.locator('.vocabulary-card').count(),1);assert.match(await first.locator('.vocabulary-card').innerText(),/Evidence/);assert.doesNotMatch(await first.locator('#vocabulary-list').innerText(),/inventedUnseenTerm/);record('only-source-grounded-difficult-words-accumulate-with-page-provenance');
  await first.locator('.vocabulary-card').getByRole('button',{name:'标记已掌握',exact:true}).click();await first.locator('.vocabulary-card').getByRole('button',{name:'重新学习',exact:true}).waitFor();await first.locator('.vocabulary-card summary').click();await first.locator('.vocabulary-card textarea').fill('经核对的个人释义');await first.locator('.vocabulary-card').getByRole('button',{name:'保存释义',exact:true}).click();await first.waitForFunction(()=>document.querySelector('.vocabulary-card>p')?.textContent==='经核对的个人释义');record('vocabulary-review-state-and-edited-meaning-persist-on-host');
  await first.locator('#language-close').click();await first.locator('#page-number').fill('6');await first.locator('#page-number').press('Enter');await first.locator('#page-number').blur();await first.waitForFunction(()=>document.querySelector('#page-number').value==='6');
  await first.locator('#metadata-open').click();await first.waitForFunction(()=>!document.getElementById('metadata-form').inert);await first.locator('#edit-title').fill('Unsaved metadata across browsers');await first.getByRole('button',{name:'收起阅读侧栏',exact:true}).click();
  await first.locator('[data-tab="conversation"]').click();await first.locator('#paper-chat-input').fill('A question retained across browsers.');
  await first.locator('#ribbon-language').click();await first.locator('#language-source').fill('An epistemic distinction deserves precise language.');
  await first.waitForTimeout(350);await first.evaluate(()=>persistence.flush());record('metadata-question-language-drafts-and-reading-page-flush-with-browser-storage-disabled');
  const secondBrowser=await pageFor();await secondBrowser.locator('.pdr-page-image').first().waitFor();assert.equal(await secondBrowser.locator('#page-number').inputValue(),'6');
  await secondBrowser.locator('#metadata-open').click();await secondBrowser.waitForFunction(()=>!document.getElementById('metadata-form').inert);assert.equal(await secondBrowser.locator('#edit-title').inputValue(),'Unsaved metadata across browsers');await secondBrowser.getByRole('button',{name:'收起阅读侧栏',exact:true}).click();
  await secondBrowser.locator('[data-tab="conversation"]').click();assert.equal(await secondBrowser.locator('#paper-chat-input').inputValue(),'A question retained across browsers.');
  await secondBrowser.locator('#ribbon-language').click();assert.equal(await secondBrowser.locator('#language-source').inputValue(),'An epistemic distinction deserves precise language.');
  await secondBrowser.locator('#language-polish').click();await secondBrowser.locator('#language-result .language-answer').first().waitFor();assert.equal(modelCalls,2);record('independent-browser-recovers-host-drafts-page-and-polishes-without-client-storage');
  await secondBrowser.locator('#language-tab-words').click();await secondBrowser.locator('.vocabulary-card').first().waitFor();assert.equal(await secondBrowser.locator('.vocabulary-card').count(),2);assert.match(await secondBrowser.locator('#vocabulary-list').innerText(),/经核对的个人释义/);await screenshot(secondBrowser,'vocabulary-cross-browser-741');
  const download=secondBrowser.waitForEvent('download');await secondBrowser.locator('#vocabulary-export-json').click();const downloaded=await download;await downloaded.saveAs(join(run,'vocabulary-export.json'));const exported=await readFile(join(run,'vocabulary-export.json'),'utf8');assert.match(exported,/epistemic/);record('vocabulary-is-shared-between-browsers-and-exportable');
  await secondBrowser.locator('#language-tab-history').click();await secondBrowser.locator('.language-history-row').first().waitFor();assert.equal(await secondBrowser.locator('.language-history-row').count(),2);assert.equal(modelCalls,2);record('history-and-vocabulary-review-do-not-call-model');
  // Same-record conflicts must preserve both the already saved remote version
  // and the local unsaved text instead of silently replacing either one.
  await secondBrowser.locator('#language-tab-work').click();await secondBrowser.locator('#language-source').fill('The second browser has a newer draft.');await secondBrowser.evaluate(()=>persistence.flush());
  await first.locator('#language-source').fill('The first browser has conflicting unsaved text.');await first.locator('#local-save-status').waitFor({state:'visible'});assert.match(await first.locator('#local-save-status').innerText(),/另一浏览器/);const draft=await store.get(`language-draft:${paper.id}`);assert.equal(draft.value.text,'The second browser has a newer draft.');assert.equal(await first.locator('#language-source').inputValue(),'The first browser has conflicting unsaved text.');record('cross-browser-CAS-conflict-keeps-local-draft-and-does-not-overwrite-host');
  const backup=first.waitForEvent('download');await first.locator('#local-save-status').getByRole('button',{name:'导出未保存草稿'}).click();const pending=await backup;await pending.saveAs(join(run,'unsaved-draft.json'));assert.match(await readFile(join(run,'unsaved-draft.json'),'utf8'),/conflicting unsaved text/);record('unsaved-conflict-content-has-explicit-local-export-recovery');
  for(const width of [430,1400,741]){await secondBrowser.setViewportSize({width,height:width===430?800:950});await secondBrowser.locator('#language-tab-words').click();await secondBrowser.waitForTimeout(100);assert.equal(await secondBrowser.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.equal(await secondBrowser.locator('#language-panel').evaluate(node=>node.scrollWidth>node.clientWidth+1),false);await screenshot(secondBrowser,`language-${width}`);}record('language-and-vocabulary-views-fit-430-741-1400px');
  await secondBrowser.locator('#language-close').click();await secondBrowser.evaluate(()=>persistence.flush());await secondBrowser.reload();await secondBrowser.locator('.pdr-page-image').first().waitFor();await secondBrowser.locator('#ribbon-language').click();await secondBrowser.locator('#language-tab-history').click();await secondBrowser.locator('.language-history-row').first().waitFor();assert.equal(await secondBrowser.locator('.language-history-row').count(),2);record('reload-recovers-durable-results-without-browser-cache');
  assert.deepEqual(await Promise.all(originals.map(hash)),originalHashes);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);record('original-pdfs-unchanged-zero-external-requests-zero-browser-errors');
  await writeFile(join(project,'docs/validation/language-browser.json'),JSON.stringify({verified_at:new Date().toISOString(),checks,model_requests:modelCalls,external_requests:external.length,browser_errors:errors,independent_browser_contexts:2,local_storage_writes:0,synthetic_originals_unchanged:true,screenshots,scope:'Actual Chromium UI and file storage with deterministic local model double; not real provider quality or formal user validation'},null,2)+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
