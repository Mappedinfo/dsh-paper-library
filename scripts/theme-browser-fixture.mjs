/** Actual Chromium theme acceptance using synthetic PDFs and an isolated DSH home.
 * The optional host fixture loads the real Harness token sheets and the plugin's
 * real theme bridge. No credentials, model service or existing browser data.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
const harness=process.env.PAPER_THEME_HARNESS||resolve(project,'../../deepseek-ai/deepseek-harness');
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/theme-browser-'));
const library=join(run,'library'),home=join(run,'home'),source=join(run,'source'),python=join(project,'.venv/bin/python');
const generated=spawnSync(python,['scripts/create-reader-demo.py','--output',source],{cwd:project,encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);
const originals=['continuous-reader-synthetic.pdf','second-reader-synthetic.pdf'];
const hash=async name=>createHash('sha256').update(await readFile(join(source,name))).digest('hex');
const originalHashes=await Promise.all(originals.map(hash));
const [paper]=(await core({action:'import',path:join(source,'reader-export.json')},{library,python})).items;
const localState=createLocalStateStore({library,home});
const handler=createFetchHandler({library,python,localState,loopbackOnly:true});
const themeSheets=await Promise.all(['base.css','design-platform.css'].map(name=>readFile(join(harness,'packages/client/ui-theme/src/styles',name),'utf8')));
const checks=[],screenshots=[],errors=[],external=[],measurements=[];
const record=name=>{checks.push(name);console.log(`PASS ${name}`);};
const hostHTML=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeSheets.join('\n')}html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style></head><body><iframe id="paper-frame" src="/"></iframe><script type="module">
import {bindThemeContext} from '/__theme-context.mjs';
let mode='dark',revision=1;const listeners=new Set();document.body.toggleAttribute('data-ds-dark-theme',true);
let fontSize=15;document.body.style.setProperty('--dsh-content-font-size','15px');
window.setFixtureTheme=(next,nextFont=fontSize)=>{mode=next;fontSize=nextFont;revision++;document.body.toggleAttribute('data-ds-dark-theme',mode==='dark');document.body.style.setProperty('--dsh-content-font-size',fontSize+'px');for(const listener of listeners)listener();};
window.disposeFixtureTheme=bindThemeContext({window,target:document.getElementById('paper-frame').contentWindow,getTheme:()=>({active:{id:'fixture-'+mode,colorScheme:mode,tokens:{}},fontSize,revision}),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}});
</script></body></html>`;
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/__theme-host'){res.writeHead(200,{'content-type':'text/html'});res.end(hostHTML);return;}
    if(req.url==='/__theme-context.mjs'){res.writeHead(200,{'content-type':'application/javascript'});res.end(await readFile(join(project,'src/client/theme-context.mjs')));return;}
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const reply=await handler(request);res.writeHead(reply.status,Object.fromEntries(reply.headers));if(reply.body)Readable.fromWeb(reply.body).pipe(res);else res.end();
  }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
  async function createPage(colorScheme,width=741){
    const context=await browser.newContext({viewport:{width,height:width===430?800:width===741?597:950},colorScheme});
    const page=await context.newPage();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());});
    await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('Theme fixture forbids browser storage writes');};});
    return page;
  }
  const shot=async(page,name)=>{const path=join(run,`${name}.png`);await page.screenshot({path});screenshots.push(relative(project,path));};
  const theme=async(page,mode)=>{await page.waitForFunction(mode=>document.documentElement.dataset.theme===mode,mode);assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),mode);};
  const noOverflow=async(page,label)=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${label} overflows the document`);
  const contrast=async(page,selectors,label)=>{
    const values=await page.evaluate(selectors=>{
      const colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=1;const colorContext=colorCanvas.getContext('2d',{willReadFrequently:true});
      const rgba=value=>{colorContext.clearRect(0,0,1,1);colorContext.fillStyle=value;colorContext.fillRect(0,0,1,1);const channels=[...colorContext.getImageData(0,0,1,1).data];return [...channels.slice(0,3),channels[3]/255];};
      const blend=(fg,bg)=>[...fg.slice(0,3).map((channel,index)=>channel*fg[3]+bg[index]*(1-fg[3])),1];
      const lum=rgb=>rgb.slice(0,3).map(channel=>{channel/=255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;}).reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0);
      return selectors.map(selector=>{const node=document.querySelector(selector);if(!node||!node.getClientRects().length)throw new Error('Missing visible contrast node '+selector);const parents=[];for(let parent=node;parent;parent=parent.parentElement)parents.push(parent);let background=[255,255,255,1];for(const parent of parents.reverse())background=blend(rgba(getComputedStyle(parent).backgroundColor),background);const foreground=blend(rgba(getComputedStyle(node).color),background);const a=lum(foreground),b=lum(background);return {selector,foreground:foreground.slice(0,3),background:background.slice(0,3),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),font:getComputedStyle(node).fontFamily};});
    },selectors);
    measurements.push({label,values});
    for(const value of values){assert.ok(value.ratio>=4.5,`${label} ${value.selector}: text contrast ${value.ratio.toFixed(2)}`);assert.doesNotMatch(value.font,/(^|[,\s])(?:Georgia|Times|serif)(?=$|[,\s])/i,`${label} ${value.selector} retains serif UI typography`);}
  };
  async function openPaper(page){
    if(await page.locator('#continuous-reader .pdr-page-image').count())return;
    if(await page.locator('#catalog-table').isVisible())await page.locator('#workspace-library').click();
    await page.locator('#search').fill(paper.title);await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('.pdr-page-image').first().waitFor();
  }
  const pdf=async page=>{
    const result=await page.locator('.pdr-page-image').first().evaluate(image=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;canvas.getContext('2d').drawImage(image,0,0,1,1,0,0,1,1);const pixel=[...canvas.getContext('2d').getImageData(0,0,1,1).data];const filters=[];for(let node=image;node;node=node.parentElement){const style=getComputedStyle(node);if(style.filter!=='none'||style.mixBlendMode!=='normal')filters.push({filter:style.filter,blend:style.mixBlendMode});}return {pixel,filters,sheet:getComputedStyle(image.closest('.pdr-sheet')).backgroundColor};});
    assert.deepEqual(result.pixel,[255,255,255,255]);assert.deepEqual(result.filters,[]);assert.equal(result.sheet,'rgb(255, 255, 255)');
  };
  for(const mode of ['light','dark']){
    const page=await createPage(mode);await page.goto(origin);await page.waitForLoadState('networkidle');await theme(page,mode);
    for(const width of [430,741,1400]){
      await page.setViewportSize({width,height:width===430?800:width===741?597:950});
      if(!await page.locator('#catalog-table').isVisible())await page.locator('#workspace-library').click();
      await page.locator('#catalog-table tbody tr').first().waitFor();await noOverflow(page,`${mode} catalog ${width}`);await contrast(page,['#workspace-library','#catalog-sort','#catalog-table tbody td'],`${mode} catalog ${width}`);await shot(page,`${mode}-catalog-${width}`);
      await page.locator('#workspace-library').click();await openPaper(page);await page.locator('[data-tab="reader"]').click();await page.locator('.pdr-page-image').first().waitFor();await noOverflow(page,`${mode} reader ${width}`);await pdf(page);
      await page.locator('[data-tab="annotations"]').click();await page.locator('#reading-side-panel').waitFor();await page.locator('#annotation-list .annotation-card').first().waitFor();await contrast(page,['#annotation-list .annotation-card','#reading-panel-side'],`${mode} annotations ${width}`);await noOverflow(page,`${mode} annotations ${width}`);await shot(page,`${mode}-annotations-${width}`);await page.getByRole('button',{name:'收起阅读侧栏',exact:true}).click();
      await page.locator('#ribbon-language').click();await page.locator('#language-source').waitFor();await page.locator('#language-source').fill('Synthetic theme draft remains while appearance changes.');await contrast(page,['#language-source','#language-tab-work'],`${mode} language ${width}`);await noOverflow(page,`${mode} language ${width}`);await shot(page,`${mode}-language-${width}`);await page.locator('#language-close').click();
      await page.locator('#metadata-open').click();await page.waitForFunction(()=>!document.getElementById('metadata-form').inert);await contrast(page,['#edit-title','#metadata-dialog-title'],`${mode} metadata ${width}`);await noOverflow(page,`${mode} metadata ${width}`);await shot(page,`${mode}-metadata-${width}`);await page.getByRole('button',{name:'收起阅读侧栏',exact:true}).click();
      await page.locator('[data-tab="graph"]').click();await page.locator('.kg-node').first().waitFor();await contrast(page,['.kg-toolbar h3','.kg-controls label'],`${mode} graph ${width}`);await noOverflow(page,`${mode} graph ${width}`);await shot(page,`${mode}-graph-${width}`);
      await page.locator('[data-kg="add-node"]').click();await page.locator('[data-kg="dialog"]').waitFor();await contrast(page,['[data-kg="form-title"]','[data-kg="form"] input[name="label"]'],`${mode} dialog ${width}`);await noOverflow(page,`${mode} dialog ${width}`);await shot(page,`${mode}-dialog-${width}`);await page.locator('[data-kg="cancel"]').click();
      record(`${mode}-${width}px-catalog-reader-sidebars-language-graph-and-dialog-fit-with-readable-system-typography`);
    }
    await page.locator('#workspace-library').click();await page.locator('#import-open').click();await page.locator('#import-source').fill('');await page.locator('#import-submit').click();await page.locator('#import-error').waitFor();await contrast(page,['#import-error','#import-dialog h2'],`${mode} error`);await shot(page,`${mode}-error`);await page.locator('#import-dialog .dialog-close').first().click();
    await page.locator('#workspace-library').focus();await page.keyboard.press('Tab');const focus=await page.evaluate(()=>{const node=document.activeElement,style=getComputedStyle(node);return {visible:node.matches(':focus-visible'),outline:style.outlineStyle,width:parseFloat(style.outlineWidth),color:style.outlineColor,shadow:style.boxShadow};});assert.ok(focus.visible&&(focus.outline!=='none'&&focus.width>=1||focus.shadow!=='none'),`${mode} keyboard focus is not visible`);record(`${mode}-error-feedback-and-keyboard-focus-remain-visible`);
    await page.locator('#workspace-library').click();await openPaper(page);await page.locator('[data-tab="reader"]').click();await page.locator('#page-number').fill('6');await page.locator('#page-number').press('Enter');await page.locator('#page-number').blur();await page.locator('.pdr-sheet[data-pdf-page="6"] .pdr-page-image').waitFor();await page.locator('#ribbon-language').click();await page.locator('#language-source').fill(`Preserved ${mode} reader draft.`);await page.locator('#language-source').evaluate(node=>node.dataset.themeFixtureIdentity='same-node');
    const opposite=mode==='dark'?'light':'dark';await page.emulateMedia({colorScheme:opposite});await theme(page,opposite);assert.equal(await page.locator('#language-source').inputValue(),`Preserved ${mode} reader draft.`);assert.equal(await page.locator('#language-source').getAttribute('data-theme-fixture-identity'),'same-node');assert.equal(await page.locator('#page-number').inputValue(),'6');await pdf(page);await page.evaluate(()=>persistence.flush());record(`standalone-${mode}-to-${opposite}-media-change-preserves-open-reader-and-unsaved-draft`);await page.context().close();
  }
  // Real bridge + actual Harness CSS: the browser's light preference must not
  // override the host's dark setting, and host events must not reload the reader.
  const host=await createPage('light');await host.goto(`${origin}/__theme-host`);await host.waitForFunction(()=>typeof window.setFixtureTheme==='function');const frame=host.frames().find(frame=>frame!==host.mainFrame());assert.ok(frame);await frame.waitForLoadState('networkidle');await theme(frame,'dark');
  const hostToken=await host.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());assert.equal(await frame.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()),hostToken);await openPaper(frame);await frame.locator('#ribbon-language').click();await frame.locator('#language-source').fill('Host appearance changes preserve this paper draft.');await frame.locator('#language-source').evaluate(node=>node.dataset.themeFixtureIdentity='host-same-node');
  await host.evaluate(()=>window.setFixtureTheme('light',17));await theme(frame,'light');assert.equal(await frame.locator('#language-source').inputValue(),'Host appearance changes preserve this paper draft.');assert.equal(await frame.locator('#language-source').getAttribute('data-theme-fixture-identity'),'host-same-node');assert.equal(await frame.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--dsh-content-font-size').trim()),'17px');await noOverflow(frame,'host theme change');await shot(host,'host-live-theme-light');record('real-bridge-delivers-harness-dark-light-tokens-and-font-size-without-reloading-iframe');
  await host.evaluate(()=>window.setFixtureTheme('dark'));await theme(frame,'dark');await pdf(frame);await shot(host,'host-live-theme-dark');await frame.evaluate(()=>persistence.flush());await host.context().close();
  assert.deepEqual(await Promise.all(originals.map(hash)),originalHashes);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);record('synthetic-originals-unchanged-zero-models-zero-external-requests-zero-browser-errors-and-no-browser-storage-writes');
  const receipt={verified_at:new Date().toISOString(),checks,viewports:[430,741,1400],themes:['light','dark'],contrast_minimum:4.5,measurements,model_requests:0,external_requests:external.length,browser_errors:errors,local_storage_writes:0,synthetic_originals_unchanged:true,screenshots,scope:'Actual Chromium UI, standalone system appearance, real plugin bridge and Harness CSS in an isolated host fixture. No live user library, provider quality or formal usability claim.'};
  await writeFile(join(project,'docs/validation/theme-browser.json'),JSON.stringify(receipt,null,2)+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
