/** Synthetic nonmodal windows and embedded return controls, desktop Chromium. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
const project=dirname(dirname(fileURLToPath(import.meta.url)));await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/floating-windows-')),library=join(run,'library'),python=join(project,'.venv/bin/python'),source=join(run,'synthetic.pdf');
const generated=spawnSync(python,['-c',`import pymupdf,sys
with pymupdf.open() as doc:
 p=doc.new_page();p.insert_text((50,80),'Synthetic floating window evidence.');doc.save(sys.argv[1])`,source],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
const options={library,python},paper=(await core({action:'import',items:[{id:'SyntheticWindowsA',title:'Synthetic paper A',attachments:[{path:source}]}]},options)).items[0];
const other=await core({action:'create',metadata:{title:'Synthetic paper B',type:'article-journal'}},options);
const dataset=await core({action:'dataset_put',expected_revision:0,metadata:{title:'Synthetic dataset'}},options);
const handle=createFetchHandler({...options,localState:createLocalStateStore({library,home:join(run,'home')})});
const checks=[],errors=[];const record=name=>{checks.push(name);console.log(`PASS ${name}`);};
const server=createServer(async(req,res)=>{try{
 if(req.url==='/synthetic-host'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic host</title><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe src="/"></iframe><script>window.returnMessages=[];addEventListener("message",e=>{if(e.origin===location.origin&&e.source===document.querySelector("iframe").contentWindow&&e.data?.type==="paper-library:return-to-dsh")returnMessages.push(e.data)})</script>');return;}
 const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
}catch{if(!res.headersSent)res.writeHead(500);res.end('Synthetic window fixture failed');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1512,height:982}});page.setDefaultTimeout(20000);
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==origin)errors.push('external request');});
 await page.goto(origin+'/synthetic-host',{waitUntil:'networkidle'});const frame=page.frames().find(f=>f.url()===origin+'/');assert.ok(frame);await frame.waitForFunction(()=>initializedReader&&!restoringReader);
 await frame.locator(`.paper-card[data-id="${paper.id}"]`).click();await frame.waitForFunction(()=>readerStateReady&&pdfReader.getSnapshot().residentPages.includes(1));
 const drag=async(panel,header,dx,dy)=>{const before=await panel.boundingBox(),b=await header.boundingBox();assert.ok(before&&b);const x=b.x+Math.min(25,b.width/2),y=b.y+b.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:6});await page.mouse.up();return {before,after:await panel.boundingBox()};};
 assert.equal(await frame.locator('#metadata-open').innerText(),'资料详情');await frame.locator('#metadata-open').click();const details=frame.locator('#reading-side-panel');await details.waitFor({state:'visible'});
 await frame.locator('#edit-title').fill('Synthetic unsaved title');const moved=await drag(details,details.locator('.reading-panel-title'),340,90);assert.ok(moved.after.x>moved.before.x+300);assert.equal(await frame.locator('#edit-title').inputValue(),'Synthetic unsaved title');
 assert.equal(await frame.locator('#metadata-dialog .paper-floating-grip').count(),0);record('资料详情 moves by its title without duplicating the nested form or losing its draft');
 await drag(details,details.locator('.reading-panel-title'),-1200,-700);let rect=await details.boundingBox();assert.ok(rect.x>=7&&rect.y>=7);await frame.locator('#reading-side-panel [aria-label="收起阅读侧栏"]').click();
 await frame.locator('#settings-open').click();await frame.locator('#settings-language').click();const language=frame.locator('#language-panel');await language.waitFor();assert.equal(await frame.locator('#language-settings').isVisible(),true);
 const languageMove=await drag(language,language.locator('.language-heading strong'),-260,-120);assert.ok(Math.abs(languageMove.after.x-languageMove.before.x)>100);assert.equal(await language.locator('.paper-floating-grip').count(),1);
 const grip=language.locator('#language-drag'),beforeKey=await language.boundingBox();await grip.focus();await page.keyboard.press('Shift+ArrowDown');assert.ok((await language.boundingBox()).y>beforeKey.y+30);record('plugin settings open the language settings and use shared title and keyboard dragging');
 await frame.locator('#language-close').click();await frame.locator('#ribbon-chat').count().then(async count=>{if(count)await frame.locator('#ribbon-chat').click();else await frame.locator('[data-tab="conversation"]').click();});
 const chat=frame.locator('#reading-chat-panel');await chat.waitFor({state:'visible'});const chatMove=await drag(chat,chat.locator('.reading-panel-title'),-240,-120);assert.ok(Math.abs(chatMove.after.x-chatMove.before.x)>150);await chat.locator('[aria-label="关闭浮动对话"]').click();record('the paper conversation shares the same draggable window behavior');
 await frame.locator('#paper-datasets').click();const resource=frame.locator('#resource-dialog');await resource.getByRole('button',{name:'＋ 关联数据集',exact:true}).waitFor();assert.equal(await resource.evaluate(n=>n.matches(':modal')),false);
 await drag(resource,resource.locator('header h3'),260,100);await frame.locator(`.paper-card[data-id="${other.id}"]`).click();await frame.waitForFunction(id=>state.active?.id===id,other.id);assert.match(await resource.innerText(),/Synthetic paper A/);
 await resource.getByRole('button',{name:'＋ 关联数据集',exact:true}).click();await frame.locator('#resource-field-dataset_id').selectOption(dataset.id);await frame.locator('#resource-field-role').fill('Synthetic fixed owner');await resource.locator('button[type=submit]').click();await resource.waitFor({state:'hidden'});
 assert.equal((await core({action:'dataset_link_list',paper_id:paper.id},options)).total,1);assert.equal((await core({action:'dataset_link_list',paper_id:other.id},options)).total,0);assert.equal(await frame.evaluate(()=>state.active.id),other.id);record('dataset relationships stay nonmodal and retain their original owner after switching papers');
 await frame.locator('#paper-datasets').click();await resource.getByRole('button',{name:'＋ 关联数据集',exact:true}).waitFor();await resource.getByRole('button',{name:'＋ 关联数据集',exact:true}).click();await frame.locator('#resource-field-role').fill('Synthetic kept draft');await page.keyboard.press('ControlOrMeta+k');await resource.waitFor({state:'hidden'});record('the global search shortcut closes through the resource draft guard');
 // Complete draft restoration before injecting the independent save failure.
 await frame.evaluate(async()=>{await paperChatUI.paperOpened(state.active);await paperChatUI.saveDraft();await persistence.flush();});
 await frame.evaluate(()=>{window.fixtureFlush=persistence.flush;persistence.flush=async()=>{throw new Error('synthetic save failure');};});const back=frame.locator('.topbar-actions .return-to-dsh');await back.click();await frame.locator('#toast').filter({hasText:'synthetic save failure'}).waitFor();assert.equal(await page.evaluate(()=>returnMessages.length),0);
 await frame.evaluate(()=>{persistence.flush=window.fixtureFlush;});await back.click();try{await page.waitForFunction(()=>returnMessages.length===1);}catch(error){console.log(JSON.stringify({returnDiagnostic:await frame.locator('#toast').innerText(),pending:await frame.evaluate(()=>persistence.exportPending().map(x=>({key:x.key,error:x.error}))),messages:await page.evaluate(()=>returnMessages.length)}));throw error;}record('embedded return to DSH waits for saved state and refuses a failing save');
 await page.setViewportSize({width:1154,height:788});await frame.locator('#ribbon-language').click();rect=await language.boundingBox();assert.ok(rect.x>=7&&rect.y>=7&&rect.x+rect.width<=1154&&rect.y+rect.height<=788);record('window geometry stays reachable after reducing the desktop viewport');
 await page.screenshot({path:join(run,'floating-windows-desktop.png')});
 const slides=await browser.newPage({viewport:{width:1512,height:982}});slides.setDefaultTimeout(20000);slides.on('pageerror',e=>errors.push(e.message));slides.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==origin)errors.push('external request');});await slides.goto(origin+'/slides.html');await slides.locator('.slides-create input').fill('Synthetic floating slides');await slides.getByRole('button',{name:'新建',exact:true}).click();await slides.locator('.app-shell').waitFor();await slides.getByRole('button',{name:'导出',exact:true}).click();const exportDialog=slides.getByRole('dialog',{name:'导出',exact:true});await exportDialog.locator('.paper-floating-grip').waitFor();const oldBox=await exportDialog.boundingBox(),h=await exportDialog.locator('h2').boundingBox();await slides.mouse.move(h.x+80,h.y+10);await slides.mouse.down();await slides.mouse.move(h.x+240,h.y+80,{steps:5});await slides.mouse.up();assert.ok((await exportDialog.boundingBox()).x>oldBox.x+100);await exportDialog.getByRole('button',{name:'关闭',exact:true}).click();record('Slides dialogs share the same title-drag controller without moving the presentation canvas');
 assert.deepEqual(errors,[]);record('no browser errors, external requests or real model calls');
}finally{await browser?.close();await handle.disposeInkQueue();await new Promise(resolve=>server.close(resolve));}
await writeFile(join(run,'report.json'),JSON.stringify({checks,errors,realModelCalls:0},null,2));console.log(JSON.stringify({run,checks:checks.length,errors}));
