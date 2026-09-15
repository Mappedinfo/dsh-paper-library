/** Compact library/annotation sidebar acceptance on synthetic documents only. */
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
const run=await mkdtemp(join(project,'.local/sidebar-browser-'));
const library=join(run,'library'),home=join(run,'home'),source=join(run,'source'),python=join(project,'.venv/bin/python');
const generated=spawnSync(python,['scripts/create-reader-demo.py','--output',source],{cwd:project,encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);
const originals=['continuous-reader-synthetic.pdf','second-reader-synthetic.pdf'];
const hash=async name=>createHash('sha256').update(await readFile(join(source,name))).digest('hex');
const originalHashes=await Promise.all(originals.map(hash));
const [paper]=(await core({action:'import',path:join(source,'reader-export.json')},{library,python})).items;
const longTitle='Synthetic shared sidebar acceptance: preserving continuous reading while a compact library and standard PDF annotations occupy the same navigation column';
await core({action:'update',id:paper.id,metadata:{title:longTitle,author:[{given:'Alexandra Synthetic',family:'Example'},{given:'Bertrand',family:'Fixture'},{given:'Charlie',family:'Demonstration'}],tags:['synthetic long metadata tag','reader acceptance','compact cards']}},{library,python});
await core({action:'import',items:Array.from({length:24},(_,index)=>({id:`SharedSidebar${index}`,title:`Synthetic compact catalog ${index}: a deliberately long research title with enough words to exercise wrapping and truncation`,author:[{family:'Example',given:`Synthetic ${index}`}],issued:{'date-parts':[[2000+index]]},tags:['synthetic','sidebar']}))},{library,python});
const initialNotes=(await core({action:'annotations',id:paper.id},{library,python})).annotations;
const existing=initialNotes.find(note=>note.comment==='Synthetic existing page 12 note');assert.ok(existing);
const localState=createLocalStateStore({library,home});
const handler=createFetchHandler({library,python,localState,loopbackOnly:true});
const checks=[],screenshots=[],errors=[],external=[],cardMeasurements=[],stateMeasurements=[];
const record=name=>{checks.push(name);console.log(`PASS ${name}`);};
const server=createServer(async(req,res)=>{try{const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const reply=await handler(request);res.writeHead(reply.status,Object.fromEntries(reply.headers));if(reply.body)Readable.fromWeb(reply.body).pipe(res);else res.end();}catch(error){res.writeHead(500);res.end(error.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
  const shot=async(page,name)=>{const path=join(run,`${name}.png`);await page.screenshot({path});screenshots.push(relative(project,path));};
  const noOverflow=async(page,label)=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${label} document overflow`);
  const state=page=>page.evaluate(()=>({page:document.getElementById('page-number').value,scroll:document.getElementById('continuous-reader').scrollTop}));
  const ready=(page,number)=>page.locator(`.pdr-sheet[data-pdf-page="${number}"] .pdr-page-image`).waitFor();
  const jump=async(page,number)=>{await page.locator('#page-number').fill(String(number));await page.locator('#page-number').press('Enter');await page.locator('#page-number').blur();await ready(page,number);};
  const samePosition=async(page,previous,label)=>{const next=await state(page);stateMeasurements.push({label,before:previous,after:next});assert.equal(next.page,previous.page,`${label} changes page`);assert.ok(Math.abs(next.scroll-previous.scroll)<=2,`${label} changes reader scroll by ${next.scroll-previous.scroll}px`);};
  const shared=async page=>{assert.equal(await page.locator('.library-pane #annotations-tab').count(),1);assert.equal(await page.locator('#reading-side-panel #annotations-tab').count(),0);assert.equal(await page.locator('#reading-side-panel').isVisible(),false);assert.equal(await page.locator('.library-pane #annotations-tab').isVisible(),true);};
  const showLibrary=async page=>{await page.locator('#reading-sidebar-library').click();await page.locator('#paper-list').waitFor();};
  for(const mode of ['light','dark']){
    const context=await browser.newContext({viewport:{width:681,height:518},colorScheme:mode});const page=await context.newPage();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());});
    await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('Sidebar fixture forbids browser storage writes');};});
    await page.goto(origin);await page.waitForLoadState('networkidle');await page.waitForFunction(mode=>document.documentElement.dataset.theme===mode,mode);
    if(await page.locator('#catalog-table').isVisible())await page.locator('#workspace-library').click();
    if(!await page.locator('#paper-list').isVisible())await page.locator('#reading-sidebar-library').click();
    await page.locator('#search').fill(longTitle);await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('.pdr-page-image').first().waitFor();
    for(const [width,height] of [[681,518],[1400,950]]){
      await page.setViewportSize({width,height});await showLibrary(page);await page.locator('#search').fill('');await page.waitForFunction(()=>document.querySelectorAll('.paper-card').length>2);
      const cards=await page.locator('.paper-card').evaluateAll(nodes=>nodes.map(node=>({height:node.getBoundingClientRect().height,title:node.querySelector('h3').textContent,font:getComputedStyle(node.querySelector('h3')).fontSize})));
      cardMeasurements.push({mode,width,cards});for(const card of cards)assert.ok(card.height<=90,`${mode} ${width}px card is ${card.height}px high`);await noOverflow(page,`${mode} library ${width}`);await shot(page,`${mode}-compact-library-${width}`);
      await jump(page,6);const before=await state(page);await page.locator('#reading-sidebar-annotations').click();await page.locator(`#annotation-list [data-annotation-id="${existing.id}"]`).waitFor();await shared(page);await samePosition(page,before,`${mode} ${width} library to annotations`);await noOverflow(page,`${mode} annotations ${width}`);await shot(page,`${mode}-shared-annotations-${width}`);
      const noteText=await page.locator('#annotation-list').innerText();await showLibrary(page);await samePosition(page,before,`${mode} ${width} annotations to library`);await page.locator('#reading-sidebar-annotations').click();await shared(page);assert.equal(await page.locator('#annotation-list').innerText(),noteText);await samePosition(page,before,`${mode} ${width} reopened annotations`);
      await page.locator('#reading-sidebar-side').click();assert.equal(await page.locator('#reading-workspace').getAttribute('data-reading-side'),'right');await shared(page);await noOverflow(page,`${mode} right sidebar ${width}`);await shot(page,`${mode}-shared-right-${width}`);await page.locator('#reading-sidebar-side').click();
      record(`${mode}-${width}px-cards-at-most-90px-and-library-notes-share-one-sidebar-with-stable-reader-position`);
    }
    await page.setViewportSize({width:681,height:518});await page.locator('#reading-sidebar-annotations').click();const card=page.locator(`#annotation-list [data-annotation-id="${existing.id}"]`);await card.locator('[data-note-action="page"]').click();await ready(page,12);assert.equal(await page.locator('#page-number').inputValue(),'12');await card.locator('[data-note-action="edit"]').click();await page.locator('#annotation-dialog').waitFor();const edited=`Synthetic shared sidebar note edited in ${mode} mode.`;await page.locator('#annotation-comment').fill(edited);await page.locator('#annotation-form button[type="submit"]').first().click();await page.locator('#annotation-dialog').waitFor({state:'hidden'});await ready(page,12);await page.waitForFunction(text=>document.getElementById('annotation-list').textContent.includes(text),edited);assert.equal((await core({action:'annotations',id:paper.id},{library,python})).annotations.find(note=>note.id===existing.id)?.comment,edited);record(`${mode}-shared-note-page-link-and-edit-save-standard-pdf-annotation`);
    await page.locator('#metadata-open').click();await page.waitForFunction(()=>!document.getElementById('metadata-form').inert);await page.locator('#edit-title').fill(`Synthetic metadata draft in ${mode}`);await page.getByRole('button',{name:'收起阅读侧栏',exact:true}).click();await page.locator('#metadata-open').click();await page.waitForFunction(()=>!document.getElementById('metadata-form').inert);assert.equal(await page.locator('#edit-title').inputValue(),`Synthetic metadata draft in ${mode}`);await page.getByRole('button',{name:'收起阅读侧栏',exact:true}).click();
    await page.locator('[data-tab="conversation"]').click();await page.locator('#reading-chat-panel').waitFor();await page.locator('#paper-chat-input').fill(`Synthetic conversation draft in ${mode}`);await page.getByRole('button',{name:'关闭浮动对话',exact:true}).click();await page.locator('[data-tab="conversation"]').click();assert.equal(await page.locator('#paper-chat-input').inputValue(),`Synthetic conversation draft in ${mode}`);await page.getByRole('button',{name:'关闭浮动对话',exact:true}).click();record(`${mode}-metadata-and-floating-conversation-preserve-drafts-with-shared-sidebar`);
    await page.locator('#workspace-library').click();await page.locator('#catalog-table tbody tr').first().waitFor();for(const selector of ['#search','#catalog-sort','#catalog-order','#catalog-scope','#catalog-create','#import-open','#export-library','#refresh','#previous-list','#next-list'])assert.equal(await page.locator(selector).isVisible(),true,`${mode} table control ${selector} hidden`);await noOverflow(page,`${mode} table`);await shot(page,`${mode}-table-681`);await page.locator('#workspace-library').click();await ready(page,12);record(`${mode}-expanded-table-retains-search-sort-scope-create-import-export-and-pagination`);
    await page.setViewportSize({width:430,height:800});await page.locator('#reader-annotations').click();await page.locator('#annotations-tab').waitFor();await shared(page);await noOverflow(page,`${mode} narrow annotations`);await shot(page,`${mode}-shared-annotations-430`);await page.locator('#reading-sidebar-close').click();assert.equal(await page.locator('#continuous-reader').isVisible(),true);await page.locator('#reader-fullscreen').click();await page.waitForFunction(()=>document.body.classList.contains('reader-focused'));await page.locator('#reader-annotations').click();await shared(page);await noOverflow(page,`${mode} fullscreen annotations`);await shot(page,`${mode}-fullscreen-annotations-430`);await page.locator('#reading-sidebar-close').click();await page.locator('#reader-fullscreen').click();await page.waitForFunction(()=>!document.body.classList.contains('reader-focused'));assert.equal(await page.locator('#page-number').inputValue(),'12');assert.equal(await page.locator('#continuous-reader').isVisible(),true);await noOverflow(page,`${mode} fullscreen exit`);record(`${mode}-430px-and-fullscreen-share-sidebar-and-close-back-to-pdf`);
    await page.evaluate(()=>persistence.flush());await context.close();
  }
  assert.deepEqual(await Promise.all(originals.map(hash)),originalHashes);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);record('original-synthetic-pdfs-unchanged-zero-external-model-browser-errors-and-storage-writes');
  await writeFile(join(project,'docs/validation/sidebar-browser.json'),JSON.stringify({verified_at:new Date().toISOString(),checks,viewports:[[681,518],[1400,950],[430,800]],themes:['light','dark'],card_height_limit:90,card_measurements:cardMeasurements,reader_state_measurements:stateMeasurements,model_requests:0,external_requests:0,browser_errors:errors,local_storage_writes:0,synthetic_originals_unchanged:true,screenshots,scope:'Actual Chromium with isolated synthetic library and host file storage. Shared sidebar layout and reader recovery; no real library or provider and no formal user validation.'},null,2)+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
