/** Reproduce public screenshots using generated content and real browser input.
 * No existing library, private host, model service or external URL is accessed.
 * Run with PLAYWRIGHT_MODULE when Playwright is not installed in this checkout.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/handwriting-demo-'));
const library=join(run,'library'),python=join(project,'.venv/bin/python'),source=join(run,'reading-example.pdf');
const imageDirectory=join(project,'docs/images');
await mkdir(imageDirectory,{recursive:true});
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const generated=spawnSync(python,['-c',`import pymupdf,sys
doc=pymupdf.open();p=doc.new_page(width=595,height=760)
ink=(.10,.14,.19);muted=(.39,.45,.49);teal=(.14,.38,.35)
def text(x,y,value,size=12,font='helv',color=ink):
    p.insert_text((x,y),value,fontsize=size,fontname=font,color=color)
text(48,33,'PAPER LIBRARY  /  SYNTHETIC READING EXAMPLE',8.5,color=teal)
text(48,72,'What makes a fair comparison?',23,font='hebo')
text(48,94,'Reading methods  /  Demonstration page  /  2026',9.5,color=muted)
p.draw_line((48,111),(547,111),color=(.83,.86,.87),width=.6)
text(48,142,'01  /  THE CLAIM',9,font='hebo',color=teal)
text(48,169,'A better score alone does not establish a better method.',12.5)
text(48,190,'Check the comparison before accepting the conclusion.',12.5)
text(48,337,'02  /  QUESTIONS TO KEEP WITH THE PASSAGE',9,font='hebo',color=teal)
for y,label,question in [(374,'Data','Same split and labels?'),(413,'Budget','Same compute and tuning?'),(452,'Evidence','Same metric and uncertainty?')]:
    p.draw_rect((48,y-20,547,y+10),color=None,fill=(.965,.973,.971))
    text(62,y,label,11,font='hebo');text(170,y,question,11,color=muted)
text(48,493,'A reading question stays connected to the exact passage and page.',10.5,color=muted)
p.draw_line((48,523),(547,523),color=(.83,.86,.87),width=.6)
text(48,543,'Synthetic example only. No empirical finding or AI-generated result.',8.5,color=muted)
text(48,723,'Paper Library / reading demonstration',8,color=muted);text(538,723,'1',8,color=muted)
doc.set_metadata({'title':'What makes a fair comparison?','author':'Paper Library demonstration'})
doc.save(sys.argv[1]);doc.close()`,source],{encoding:'utf8',timeout:30000});
assert.equal(generated.status,0,generated.stderr);
const originalHash=await hash(source);
const paper=(await core({action:'import',items:[{id:'HandwritingReadingDemo',title:'What makes a fair comparison?',author:[{literal:'Paper Library demonstration'}],date:'2026',tags:['synthetic example','reading methods'],attachments:[{path:source}]}]},{library,python})).items[0];
const localState=createLocalStateStore({library,home:join(run,'home')});
const handle=createFetchHandler({library,python,localState});
const server=createServer(async(req,res)=>{
  try{
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
  }catch{res.writeHead(500);res.end('Synthetic screenshot service failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const screenshots=[],errors=[],external=[],actions=[],checks=[];
let browser,page,parent,failure;
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1080},deviceScaleFactor:1,colorScheme:'light'});
  page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
    if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());
    if(request.url().endsWith('/api'))try{actions.push(request.postDataJSON().action);}catch{}
  });
  const cdp=await context.newCDPSession(page);
  const ready=()=>page.waitForFunction(()=>{const sheet=document.querySelector('.pdr-sheet[data-pdf-page="1"]'),image=sheet?.querySelector('.pdr-page-image');return image?.complete&&image.naturalWidth>0&&sheet.querySelectorAll('.pdr-word').length>0&&!autoMarkupBusy&&!pdfReader.getSnapshot().inFlightPage;});
  const card=()=>page.locator(`.annotation-card[data-annotation-id="${parent.id}"]`);
  const pen=(type,point)=>cdp.send('Input.dispatchMouseEvent',{type,...point,pointerType:'pen',button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1,force:type==='mouseReleased'?0:.6});
  const draw=async points=>{
    const b=await page.locator('.pdr-sheet[data-pdf-page="1"]').boundingBox();
    const screen=points.map(([x,y])=>({x:b.x+x/595*b.width,y:b.y+y/760*b.height}));
    await pen('mousePressed',screen[0]);for(const point of screen.slice(1))await pen('mouseMoved',point);await pen('mouseReleased',screen.at(-1));
  };
  const capture=async(name,description)=>{
    const path=join(imageDirectory,`${name}.jpg`);await page.screenshot({path,type:'jpeg',quality:94});
    screenshots.push({file:relative(project,path),description,width:1440,height:1080,sha256:await hash(path)});
  };
  await page.goto(origin);await page.waitForLoadState('networkidle');await page.waitForFunction(()=>initializedReader&&!restoringReader);
  await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await ready();await page.locator('#reading-sidebar-annotations').click();
  // Resize through the existing user-facing separator, with no CSS overrides.
  const separator=page.locator('#reading-rail-resizer'),box=await separator.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+80);await page.mouse.down();await page.mouse.move(310,box.y+80,{steps:8});await page.mouse.up();await ready();
  await page.locator('#reader-mode-auto').click();await page.locator('#reader-tool-highlight').click();
  const range=await page.evaluate(()=>{
    const words=[...document.querySelectorAll('.pdr-sheet[data-pdf-page="1"] .pdr-word')],start=words.findIndex(word=>word.textContent==='Check'),end=words.findIndex((word,index)=>index>start&&word.textContent==='conclusion.');
    if(start<0||end<start)throw new Error('Synthetic passage was not found');
    const a=words[start].getBoundingClientRect(),b=words[end].getBoundingClientRect();return {a:{x:a.left+1,y:a.top+a.height/2},b:{x:b.right-1,y:b.top+b.height/2}};
  });
  const response=page.waitForResponse(response=>{try{const request=response.request().postDataJSON();return request.action==='annotate'&&request.type==='highlight'&&response.status()===200;}catch{return false;}});
  await pen('mousePressed',range.a);for(let n=1;n<=16;n++)await pen('mouseMoved',{x:range.a.x+(range.b.x-range.a.x)*n/16,y:range.a.y});await pen('mouseReleased',range.b);
  parent=(await (await response).json()).result.annotation;await card().waitFor();await ready();
  assert.equal(parent.text,'Check the comparison before accepting the conclusion.');checks.push('The highlighted quotation was selected through trusted pen input.');
  await card().locator('[data-note-action="handwriting"]').click();await page.waitForFunction(()=>linkedHandwritingUI?.session()&&readingShell.tool().type==='ink');await ready();
  await page.locator('#reader-ink-width').selectOption('2');
  const color=page.locator('#reader-color');await color.evaluate(input=>{input.value='#2b59a6';input.dispatchEvent(new Event('input',{bubbles:true}));});
  const word=await page.evaluate(()=>{const sheet=document.querySelector('.pdr-sheet[data-pdf-page="1"]'),s=sheet.getBoundingClientRect(),node=[...sheet.querySelectorAll('.pdr-word')].find(word=>word.textContent==='comparison'),b=node.getBoundingClientRect();return {left:(b.left-s.left)/s.width*595,top:(b.top-s.top)/s.height*760,width:b.width/s.width*595,height:b.height/s.height*760};});
  const circle=Array.from({length:45},(_,i)=>{const a=i/44*Math.PI*2;return [word.left+word.width/2+Math.cos(a)*(word.width/2+7),word.top+word.height/2+Math.sin(a)*(word.height/2+4)];});
  const glyphs={
    s:{width:9,paths:[[[8,3],[6,1],[3,1],[1,3],[2,5],[6,6],[8,8],[6,10],[2,10],[0,9]]]},
    a:{width:10,paths:[[[8,4],[6,2],[3,2],[1,4],[0,7],[2,10],[5,10],[8,7],[8,2],[8,10],[10,10]]]},
    m:{width:14,paths:[[[0,10],[0,3],[2,2],[4,4],[4,10],[4,4],[7,2],[9,3],[9,10],[9,4],[11,2],[13,3],[13,10]]]},
    e:{width:10,paths:[[[1,6],[8,5],[8,3],[5,1],[2,3],[0,6],[1,9],[4,11],[8,10]]]},
    d:{width:10,paths:[[[8,4],[6,2],[3,2],[1,4],[0,7],[2,10],[5,10],[8,7],[9,-5],[8,10],[10,10]]]},
    t:{width:8,paths:[[[4,-3],[3,8],[4,10],[7,10]],[[0,3],[8,3]]]},
    '?':{width:10,paths:[[[0,0],[2,-2],[6,-2],[8,0],[8,3],[4,5],[4,7]],[[4,11],[4.2,11.1]]]},
  };
  const strokes=[circle,[[word.left+word.width/2,word.top+word.height+7],[166,222],[181,239],[205,249],[224,253]],[[213,244],[224,253],[212,259]]];
  let x=237;for(const letter of 'same data?'){if(letter===' '){x+=15;continue;}const glyph=glyphs[letter];for(const path of glyph.paths)strokes.push(path.map(([gx,gy])=>[x+gx*1.65+(gy-5)*.08,247+gy*1.65]));x+=(glyph.width+2)*1.65;}
  strokes.push([[237,273],[274,274],[320,273],[367,275],[421,273]]);
  for(const stroke of strokes)await draw(stroke);
  await page.waitForFunction(count=>pdfReader.getInkDraft()?.paths.length===count,strokes.length);
  await page.locator('#toast').waitFor({state:'hidden'});
  // Keep the selected note in an ordinary active writing session for the hero.
  // Autosave may already finish while waiting for the preceding highlight toast.
  await page.waitForFunction(()=>document.querySelectorAll('.pdr-ink-draft polyline,.pdr-ink-overlay polyline').length>0||inkQueue.records().some(job=>job.status==='saved'));
  assert.equal(await page.locator('#reader-ink-draft').evaluate(node=>node.getBoundingClientRect().height),52);
  await capture('handwriting-inline','Inline pen handwriting and a text highlight on the original synthetic PDF, with the unified 52-pixel writing toolbar.');
  await page.locator('#reader-ink-save').click();await page.waitForFunction(()=>!linkedHandwritingUI.session()&&!inkQueue.hasPending(state.active.id));await ready();
  await card().locator('.ink-preview-svg').waitFor();await page.locator('#toast').waitFor({state:'hidden'});
  const saved=(await core({action:'annotations',id:paper.id},{library,python})).annotations.find(note=>note.id===parent.id);
  assert.equal(saved.linked_ink.annotations.reduce((n,annotation)=>n+annotation.paths.length,0),strokes.length);
  assert.equal(saved.linked_ink.transcript,'');assert.equal(await card().locator('.ink-preview-svg').getAttribute('data-stroke-count'),String(strokes.length));
  assert.equal(await page.locator('#reader-ink-draft').isVisible(),false);checks.push('All demonstration strokes are saved as native linked PDF Ink and appear in the actual card SVG preview.');
  await capture('handwriting-preview','Saved native PDF ink remains visible beside the quotation and its unmodified SVG preview; no AI transcription is shown.');
  await card().locator('.linked-ink-preview').click();
  await page.waitForFunction(()=>{const node=document.querySelector('.pdr-annotation-flash[data-focus-kind="ink"]');return node&&Number(getComputedStyle(node).opacity)>=.9;});
  assert.equal(await page.locator('#reader-return-position').isVisible(),true);
  await capture('handwriting-locate','Clicking the real preview locates the saved ink and briefly outlines its region, with Return to previous position available.');
  await page.locator('.pdr-annotation-flash').waitFor({state:'hidden'});checks.push('The location outline is a temporary UI focus indicator, not a PDF annotation.');
  assert.equal(await hash(source),originalHash);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  assert.ok(!actions.some(action=>['handwriting_recognize','ai_feedback','chat_send','language_generate','library_feedback'].includes(action)));
  checks.push('Generated source PDF unchanged; no private library, external request, model call, browser error, or screenshot retouching.');
}catch(error){failure=error;if(page)await page.screenshot({path:join(run,'failure.png')}).catch(()=>{});}
finally{await browser?.close();await handle.disposeInkQueue?.();await new Promise(resolve=>server.close(resolve));}
const receipt={captured_at:new Date().toISOString(),complete:!failure,synthetic:true,source_generator:'scripts/capture-handwriting-demo.mjs',runtime_directory:relative(project,run),mode:'Standalone Chromium preview, light theme, 1440 × 1080 CSS pixels',screenshots,checks,private_documents_read:0,external_requests:external.length,model_requests:0,browser_errors:errors,limitations:['Pen strokes are deterministic demonstration paths delivered through Chromium CDP, not physical Apple Pencil or Sidecar input.','The reading passage is original synthetic fixture text, not a published research result.','No OCR output or model success is simulated.','Screenshots are direct browser JPEG captures without retouching or DOM/style overrides.'],...(failure?{error:failure.message}:{})};
await writeFile(join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
if(failure){console.error(`Screenshot diagnostics: ${relative(project,run)}`);throw failure;}
await writeFile(join(project,'docs/community/handwriting-demo.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({run:relative(project,run),screenshots:screenshots.map(value=>value.file),checks:checks.length}));
