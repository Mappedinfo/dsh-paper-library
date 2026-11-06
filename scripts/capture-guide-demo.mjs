/** 隔离示例：以公开使用手册演示批注、两套主题和主机保存。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';
const run=await mkdtemp(resolve('.local/guide-demo-')),library=join(run,'library'),python=resolve('.venv/bin/python');
const imported=await core({action:'import',path:resolve('docs/demo/guide.pdf')},{library,python});
const paper=imported.items?.[0]??imported.item;assert.ok(paper?.id,JSON.stringify(imported));
const pageInfo=await core({action:'page',id:paper.id,page:1,scale:1},{library,python});
const words=pageInfo.words.filter(w=>w[4].includes('Paper')||w[4].includes('Library'));assert.ok(words.length);
await core({action:'annotate',id:paper.id,page:1,type:'highlight',rects:[words[0].slice(0,4)],text:words[0][4],comment:'示例批注：阅读这份说明后，试着导出一个可编辑的演示文稿。',color:'#e4be62',author:'Paper Library Demo'},{library,python});
const localState=createLocalStateStore({library,home:join(run,'home')}),handle=createFetchHandler({library,python,localState});
const server=createServer(async(req,res)=>{try{const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();}catch(error){res.writeHead(500);res.end(error.message);}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
// 设置面板轮询可能占满独立服务的两个并发名额；只对明确拒绝的只读请求有界重试。
const call=async input=>{for(let attempt=0;attempt<6;attempt++){
 const response=await fetch(origin+'/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}),r=await response.json();
 if(response.status===429&&input.action==='settings_get'&&attempt<5){await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));continue;}
 assert.ok(r.ok,r.error);return r.result;
}};
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');let browser;const errors=[],checks=[];
try{
 const settings=await call({action:'settings_get'});await call({action:'settings_update',expected_revision:settings.revision,patch:{auto_analysis:false,auto_review:false}});
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1512,height:982},colorScheme:'light'});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
 await page.route('**/*',route=>/^https?:/.test(route.request().url())&&new URL(route.request().url()).origin!==origin?route.abort():route.continue());
 await page.goto(origin);await page.waitForFunction(()=>initializedReader&&!restoringReader);
 await page.locator('#workspace-library').click();await page.locator('#catalog-table .table-title').first().click();
 await page.waitForFunction(()=>document.querySelector('.pdr-page-image')?.naturalWidth>0);
 await page.locator('#reading-sidebar-annotations').click();await page.locator('.annotation-card').first().waitFor();
 await page.locator('#settings-open').click();await page.getByText('已与主机设置同步',{exact:true}).waitFor();
 for(const palette of ['jade','navy']){
  await page.locator(`#setting-palette-${palette}`).check();
  await page.waitForFunction(p=>document.documentElement.dataset.palette===p,palette);
  await page.waitForFunction(()=>!document.querySelector('.settings-palettes').disabled);
  await page.waitForLoadState('networkidle');
  assert.equal((await call({action:'settings_get'})).value.ui_palette,palette);
  await page.screenshot({path:resolve(`docs/demo/theme-${palette}.png`)});
  for(const mode of ['light','dark']){
   await page.emulateMedia({colorScheme:mode});await page.waitForFunction(m=>document.documentElement.dataset.theme===m,mode);
   const result=await page.locator('.workspace-root-button[aria-pressed="true"]').evaluate(el=>({color:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}));
   checks.push({palette,mode,...result});
  }
  await page.emulateMedia({colorScheme:'light'});
 }
 await page.locator('.library-settings [aria-label="关闭设置"]').click();await page.screenshot({path:resolve('docs/demo/reader-demo.png')});
 const annotations=await core({action:'annotations',id:paper.id},{library,python});assert.equal(annotations.annotations.length,1);
 const pdf=await fetch(`${origin}/pdf/${paper.id}`);assert.ok(pdf.ok);await writeFile(resolve('docs/demo/guide-annotated.pdf'),Buffer.from(await pdf.arrayBuffer()));
 assert.deepEqual(errors,[]);
 await writeFile(join(run,'checks.json'),JSON.stringify({paper:paper.id,checks,errors},null,2));
 console.log(JSON.stringify({run,pages:8,annotationCount:1,checks}));
}finally{await browser?.close();await handle.disposeInkQueue?.();await new Promise(r=>server.close(r));}
