/** Desktop layout regression with an isolated synthetic PDF and catalog. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createPaperModel } from '../src/harness/paper-model.mjs';
import { createFieldRadarStore } from '../src/harness/field-radar.mjs';
import { core } from '../src/bridge.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(project, '.local', 'ui-desktop-audit');
await mkdir(output, { recursive: true });
const run = await mkdtemp(join(output, 'desktop-'));
const library = join(run, 'library');
const python = join(project, '.venv', 'bin', 'python');
const pdf = join(run, 'synthetic.pdf');
const generated=spawnSync(python,['-c',`
import pymupdf, sys
with pymupdf.open() as doc:
 for i in range(3):
  page=doc.new_page()
  page.insert_text((55,70), 'Research note on urban network observation', fontsize=19)
  if i == 1:
   page.insert_text((55,98), 'Data availability', fontsize=12)
   page.insert_text((55,115), 'We used Synthetic Network Data v2 (10.5555/fixture-data).', fontsize=11)
  for row in range(8):
   page.insert_text((55,145+row*25), 'Synthetic text for testing the position of reading and annotation controls.', fontsize=11)
 doc.set_toc([[1,'Introduction',1],[1,'Methodology',-1],[2,'Architecture',1],
              [2,'Experiment',2],[3,'Data sources with a deliberately long title to test how names wrap in a narrow sidebar',2],
              [2,'Analysis',3],[1,'Discussion',3]])
 doc.save(sys.argv[1])
`,pdf],{encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);
const title='Synthetic study of information conditions for network changes and the associated observation design';
const author=[{family:'Test',given:'Rina'},{family:'Fixture',given:'Sam'}];
const base={author,issued:{'date-parts':[[2025]]},'container-title':'Synthetic Journal of Urban Systems and Applied Data',tags:['synthetic','long-example-tag'],type:'article-journal'};
const items=Array.from({length:16},(_,i)=>({...base,title:i===0?title:'Synthetic study '+(i+1)+' on mobility, network representation and data quality',id:'test'+i,DOI:'10.1234/fixture-'+i,...(i===0?{attachments:[{path:pdf}]}:{})}));
const options={library,python}, primary=(await core({action:'import',items},options)).items[0];
for(const i of [0,1,2,3])await core({action:'annotate',id:primary.id,page:1,type:'underline',text:'Synthetic text for testing the position of reading and annotation controls.',rects:[[55,132+i*25,423,145+i*25]],comment:i===1?'This sample has a saved note for checking the editor and action placement.':'',author:'Synthetic Reader'},options);
for(let i=0;i<22;i++)await core({action:'dataset_put',metadata:{title:`Synthetic catalog dataset ${i+1}`},expected_revision:0},options);
const topic={schema_version:1,topic:{id:'synthetic',title:'城市网络观察与建模',question:'如何从观察资料判断网络修改方案的效果？'},papers:items.slice(0,4).map((p,i)=>({id:'p'+i,title:p.title,year:2025,task:['prediction'],method:'Synthetic method',source_ids:['s1']})),sources:[{id:'s1',title:'Synthetic source',url:'https://example.org/synthetic'}],scholars:[],claims:[]};
async function startServer(theme) {
  const localState = createLocalStateStore({ library, home: join(run, 'home-' + theme) });
  const radar = createFieldRadarStore({ store: localState, request: payload => core(payload, options), library });
  await radar.handle({ action: 'field_radar_import', document: topic, expected_revision: 0 });
  const hostRoute={provider:'fixture',model:'default'};
  const paperModel=createPaperModel({store:localState,library,getDefault:()=>hostRoute,
    models:async()=>({models:[{provider:'fixture',provider_name:'Synthetic provider',id:'default'},{provider:'fixture',provider_name:'Synthetic provider',id:'alternative'}]}),
    llm:{resolveModelInfo:async()=>({reasoning:{efforts:[{id:'high',name:'高'}]}}),resolveCallConfig:async()=>({})}});
  await paperModel.ready;
  const handler = createFetchHandler({ ...options, localState, fieldRadar: radar, paperModel,
    paperDatasetModel:signal=>paperModel.resolve(signal),
    paperDatasetAI:async()=>JSON.stringify({candidates:[{title:'Synthetic Network Data',version:'2',page:2,
      relation:'uses',role:'evaluation',quote:'We used Synthetic Network Data v2 (10.5555/fixture-data).',identifier:'10.5555/fixture-data'}]}),
    paperDatasetVerify:async identifier=>({status:'verified',access:'accessible',doi:identifier,url:'https://doi.org/'+identifier,version:'2'}) });
  const server = createServer(async (req, res) => {
    try {
      const input = { method: req.method, headers: req.headers };
      if (!['GET', 'HEAD'].includes(req.method)) Object.assign(input, { body: Readable.toWeb(req), duplex: 'half' });
      const reply = await handler(new Request('http://' + req.headers.host + req.url, input));
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      if (reply.body) Readable.fromWeb(reply.body).pipe(res);
      else res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    async close() {
      await handler.disposeInkQueue();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
const browser=await chromium.launch({headless:true});
const measures={};
const fixtures=[];
try{
 for(const theme of ['light','dark']){
  const fixture=await startServer(theme);
  fixtures.push(fixture);
  const {origin}=fixture;
  const page=await browser.newPage({viewport:{width:1512,height:982},colorScheme:theme});
  page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  async function record(name,selectors){
   measures[theme+'-'+name]=await page.evaluate(selectors=>{
    const measure=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),font:parseFloat(s.fontSize),extraX:node.scrollWidth-node.clientWidth,extraY:node.scrollHeight-node.clientHeight};};
    const result={page:measure(document.documentElement)};
    for(const [key,selector] of Object.entries(selectors)){const node=document.querySelector(selector);result[key]=node?measure(node):null;}
    return result;
   },selectors);
   await page.screenshot({path:join(run,theme+'-'+name+'.png')});
  }
  await page.goto(origin);await page.waitForFunction(()=>initializedReader&&!restoringReader);
  await record('reading-library',{rail:'.shared-reading-sidebar',controls:'.library-filterbar',search:'.library-pane .search-field',paper:'.paper-list .paper-card'});
  const filters=page.locator('.library-rail-filters');
  assert.equal(await filters.evaluate(el=>el.open),false);
  await filters.locator(':scope > summary').press('Enter');
  assert.equal(await page.locator('#catalog-sort').isVisible(),true);
  await filters.locator(':scope > summary').press('Enter');
  await page.locator('#catalog-expand').click();
  assert.equal(await page.locator('#catalog-sort').isVisible(),true);
  await page.locator('#catalog-table tbody .table-title').first().waitFor();
  await record('catalog',{top:'.topbar',nav:'.workspace-navigation',filter:'.library-filterbar',grid:'#catalog-table',head:'#catalog-table th',row:'#catalog-table tbody tr',search:'#search',title:'.table-title',action:'#catalog-manage-tags',citation:'.catalog-column-citekey',doi:'.catalog-column-doi',kind:'.catalog-column-kind'});
  await page.locator('tr[data-paper-id="'+primary.id+'"] .table-title').click();
  await page.locator('#catalog-read').click();
  await page.locator('#continuous-reader .pdr-page-image').first().waitFor();
  await page.locator('.reader-ribbon [data-tab=annotations]').click();
  await page.locator('#annotation-list > .annotation-card').first().waitFor();
  await record('annotations',{top:'.topbar',ribbon:'.reader-ribbon',tools:'.paper-tools',annotationTools:'#toolbar-annotation',railTabs:'.reading-sidebar-tabs',pen:'#reader-pen-settings summary',pageNote:'#page-note',reader:'#continuous-reader',rail:'.shared-reading-sidebar',card:'#annotation-list > .annotation-card',quote:'.annotation-quote',note:'.annotation-inline-heading',primary:'.annotation-primary-actions .button',meta:'.annotation-meta',action:'.annotation-actions .button',second:'#annotation-list > .annotation-card:nth-child(2)'});
  await page.locator('#reading-sidebar-outline').click();
  const experiment=page.getByRole('button',{name:'Experiment 2',exact:true});
  await experiment.waitFor();
  const outline=page.locator('#paper-outline');
  assert.deepEqual(await experiment.evaluate(node=>[...node.closest('ul').children].map(li=>li.querySelector('.outline-entry span').textContent)),['Architecture','Experiment','Analysis']);
  assert.ok(await outline.getByText('Methodology',{exact:true}).evaluate(node=>node.closest('.outline-entry').tagName==='SPAN'));
  const expToggle=outline.getByRole('button',{name:'折叠 Experiment'});
  await expToggle.click();
  assert.equal(await outline.getByRole('button',{name:'展开 Experiment'}).getAttribute('aria-expanded'),'false');
  await outline.getByRole('button',{name:'展开 Experiment'}).click();
  await experiment.click();
  await page.waitForFunction(()=>document.querySelector('.outline-entry[aria-current]')?.textContent.includes('Experiment'));
  const widths=await page.locator('.reading-sidebar-tabs > button:visible').evaluateAll(tabs=>tabs.map(tab=>tab.getBoundingClientRect().width));
  assert.equal(widths.length,8);assert.ok(Math.max(...widths)-Math.min(...widths)<1);
  const outlineFit=await outline.evaluate(node=>node.scrollWidth===node.clientWidth);
  assert.ok(outlineFit,'Long outline titles must wrap inside the rail');
  assert.ok(await page.getByRole('tablist',{name:'阅读侧栏内容'}).evaluate(node=>node.scrollWidth===node.clientWidth));
  await record('outline',{rail:'.shared-reading-sidebar',tabs:'.reading-sidebar-tabs',tree:'.outline-tree',experiment:'.outline-branch .outline-entry',nested:'.outline-branch .outline-branch'});
  await outline.getByRole('button',{name:'页面缩略图'}).click();
  await outline.getByRole('button',{name:/第 2 页/}).first().waitFor();
  await outline.getByRole('button',{name:'大纲',exact:true}).click();
  await page.locator('#reading-sidebar-outline').press('End');
  await page.getByRole('heading',{name:'AI 检索候选'}).waitFor();
  await page.getByRole('button',{name:'检索本文数据'}).click();
  const candidate=page.locator('#paper-data .paper-data-section').last().getByRole('article').filter({hasText:'Synthetic Network Data'});
  await candidate.getByText(/可访问/).waitFor();
  if(theme==='light')await candidate.getByRole('button',{name:'核对并入库'}).click();
  await candidate.getByRole('button',{name:'已入库'}).waitFor();
  await page.getByRole('button',{name:'＋ 关联数据集'}).click();
  const catalog=page.locator('#workspace-catalog-body');
  await catalog.getByText(`绑定到 ${title}`,{exact:true}).waitFor();
  await catalog.getByRole('button',{name:'下一页'}).click();
  await catalog.getByRole('button',{name:'上一页'}).waitFor();
  const datasetTitle='Synthetic catalog dataset '+(theme==='light'?2:3);
  await page.getByRole('searchbox',{name:'检索工作区目录'}).fill(datasetTitle);
  await page.getByRole('searchbox',{name:'检索工作区目录'}).press('Enter');
  const entry=catalog.locator('.workspace-object-row').filter({has:page.getByRole('button',{name:datasetTitle,exact:true})});
  await entry.getByRole('button',{name:'绑定',exact:true}).click();
  await catalog.getByLabel('关系',{exact:true}).selectOption('cites');
  await catalog.getByRole('button',{name:'保存绑定'}).click();
  await catalog.getByText('已保存绑定',{exact:true}).waitFor();
  await catalog.getByRole('button',{name:'返回论文'}).click();
  await page.locator('#paper-data').getByRole('button',{name:datasetTitle,exact:true}).waitFor();
  await page.locator('#paper-data').getByRole('button',{name:'已入库'}).waitFor();
  await record('datasets',{rail:'.shared-reading-sidebar',panel:'#paper-data',candidate:'#paper-data .paper-data-section:last-child .resource-row'});
  await page.locator('#reading-sidebar-annotations').click();
  const side = page.locator('#reading-sidebar-side');
  const originalSide = await page.locator('.workspace').getAttribute('data-sidebar-side');
  const otherSide = originalSide === 'left' ? 'right' : 'left';
  const switchSide = async expected => {
    await side.click();
    await page.waitForFunction(value => document.querySelector('.workspace').dataset.sidebarSide === value, expected);
    await page.evaluate(() => persistence.flush());
  };
  await switchSide(otherSide);
  await switchSide(originalSide);
  await page.setViewportSize({ width: 681, height: 800 });
  await switchSide(otherSide);
  await side.click({ trial: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await switchSide(originalSide);
  await page.locator('#reader-pen-settings summary').click();
  await page.locator('#reader-pen-options').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#reader-pen-settings').evaluate(el=>el.open),false);
  await page.locator('#reader-find').click();
  await record('search',{top:'.topbar',search:'#pdf-search-row',reader:'#continuous-reader',input:'#pdf-search-row input',searchAction:'#pdf-search-row button'});
  await page.locator('#reader-tool-ink').click();
  const geometry = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    return {
      searchBottom: box('#pdf-search-row').bottom,
      toolsTop: box('#toolbar-annotation').top,
      toolsBottom: box('#toolbar-annotation').bottom,
      inkTop: box('#reader-ink-draft').top,
      inkBottom: box('#reader-ink-draft').bottom,
      readerTop: box('#continuous-reader').top,
      topbarBottom: box('.topbar').bottom,
    };
  });
  assert.ok(geometry.searchBottom <= geometry.toolsTop);
  assert.ok(geometry.toolsBottom <= geometry.inkTop);
  assert.ok(geometry.inkTop < geometry.inkBottom && geometry.inkBottom <= geometry.readerTop, JSON.stringify(geometry));
  await page.locator('#reader-tool-select').click();
  await page.locator('#reader-find').click();
  await page.locator('#metadata-open').click();
  await page.locator('#edit-title').waitFor();
  await record('metadata',{rail:'.shared-reading-sidebar',form:'#metadata-dialog',title:'#edit-title',author:'#edit-authors',submit:'#metadata-form [type=submit]'});
  await page.locator('#settings-open').click();
  await page.locator('.library-settings[open]').waitFor();
  await record('settings',{switch:'.library-settings [role=switch]',dialog:'.library-settings',header:'.library-settings header',option:'.settings-option',desc:'.settings-description',legend:'.library-settings legend',storage:'.settings-storage'});
  const toggle = page.locator('#setting-reading_distribution_enabled');
  const waitForSettings = () => page.waitForFunction(() => document.querySelector('#setting-reading_distribution_enabled:enabled'));
  await waitForSettings();
  const initiallyChecked = await toggle.isChecked();
  await toggle.press('Space');
  await waitForSettings();
  assert.equal(await toggle.isChecked(), !initiallyChecked);
  await toggle.press('Space');
  await waitForSettings();
  assert.equal(await toggle.isChecked(), initiallyChecked);
  const storage=page.locator('.settings-storage');
  await storage.locator(':scope > summary').click();
  const modelSelect=storage.getByLabel('全局对话、伴学与后台整理模型',{exact:true});
  await modelSelect.selectOption(JSON.stringify({provider:'fixture',model:'alternative'}));
  await storage.getByLabel('推理强度',{exact:true}).selectOption('high');
  await storage.getByRole('button',{name:'保存全局模型'}).click();
  await storage.getByText(/当前生效：alternative · fixture · high/).waitFor();
  await page.locator('#settings-language').click();
  await page.locator('#language-prompt-preview > summary').click();
  await page.locator('#language-settings-translate').fill('Preserve synthetic names.');
  await page.locator('#language-prompt-output').getByText(/Preserve synthetic names/).first().waitFor();
  await page.locator('#language-preview-polish').selectOption('academic');
  await page.locator('#language-prompt-output').getByText(/Requested direction \(academic\)/).waitFor();
  await record('language-prompts',{panel:'#language-panel',preview:'#language-prompt-preview'});
  await page.keyboard.press('Escape');
  await page.locator('#field-radar-open').click();
  await page.locator('.radar-paper').first().waitFor();
  assert.equal(await page.locator('#reading-side-panel').isVisible(),false);
  await record('radar',{top:'.topbar',panel:'#field-radar',heading:'.radar-heading',tabs:'.radar-tabs',filters:'.radar-filters',card:'.radar-paper',title:'.radar-paper h3'});
  await page.locator('#field-radar-tab-table').click();
  await page.locator('.radar-literature-table tbody').waitFor();
  await record('radar-table',{panel:'#field-radar',heading:'.radar-heading',filters:'.radar-table-column-filters',table:'.radar-table-scroll',first:'.radar-literature-table tbody tr',evidence:'.radar-literature-evidence'});
  for(const name of ['catalog','annotations','radar-table','settings']){
    const m=measures[theme+'-'+name];
    if(name==='catalog')assert.equal(m.grid.extraX,0);
    if(name==='annotations'){assert.equal(m.card.extraX,0);assert.equal(m.tools.extraX,0);assert.equal(m.annotationTools.extraX,0);assert.ok(m.railTabs.w>0);assert.ok(m.annotationTools.y+m.annotationTools.h<=m.reader.y);}
    if(name==='radar-table')assert.ok(m.first.y+m.first.h<=982);
    if(name==='settings')assert.ok(m.switch.w>=28);
    if(name==='annotations'){const search=measures[theme+'-search'];assert.ok(search.search.y+search.search.h<=search.reader.y);assert.ok(search.top.y+search.top.h===search.reader.y);assert.ok(m.pen.x+m.pen.w<=1512&&m.pageNote.x+m.pageNote.w<=1512);}
  }
  await page.locator('#field-radar-close').click();
  await page.locator('#board-open').click();
  await page.locator('#board-stage').waitFor();
  await page.waitForFunction(() => document.querySelector('#board-select')?.options.length > 0);
  await record('board',{stage:'#board-stage',toolbar:'#board-view header',tools:'#board-tool-rect'});
  const board = measures[theme+'-board'];
  assert.ok(board.stage.w >= 900 && board.stage.h >= 500);
  await page.evaluate(async () => { await boardUI.close(); await persistence.flush(); });

  const slides=await browser.newPage({viewport:{width:1512,height:982},colorScheme:theme});
  slides.on('pageerror',e=>errors.push(e.message));
  await slides.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await slides.goto(origin+'/slides.html');
  await slides.locator('.slides-create input').fill('Synthetic desktop UI check '+theme);
  await slides.getByRole('button',{name:'新建',exact:true}).click();
  await slides.locator('.app-shell').waitFor();
  await slides.getByRole('button',{name:'导出',exact:true}).click();
  const exportDialog=slides.getByRole('dialog',{name:'导出',exact:true});await exportDialog.waitFor();
  const rect=await exportDialog.boundingBox();assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=1512&&rect.y+rect.height<=982);
  await slides.screenshot({path:join(run,theme+'-slides.png')});await slides.close();
  assert.deepEqual(errors,[]);
  await page.close();
 }
}finally {
  await writeFile(join(run, 'measurements.json'), JSON.stringify(measures, null, 2));
  console.log(run);
  await browser.close();
  await Promise.all(fixtures.map(fixture=>fixture.close()));
}
