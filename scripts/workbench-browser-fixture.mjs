/** Isolated UI acceptance fixture: synthetic catalog only, no model or network lookup.
 * Use PLAYWRIGHT_MODULE to reuse an existing runtime. --recon captures only the
 * initial surfaces; the normal run exercises catalog, metadata and graph actions.
 */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {core} from '../src/bridge.mjs';
const project=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/workbench-browser-'));
const library=join(run,'library'),source=join(run,'source'),checks=[];
const record=label=>{checks.push(label);console.log(`PASS ${label}`);};
const generated=spawnSync(join(project,'.venv/bin/python'),['scripts/create-demo.py','--output',source],{cwd:project,encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
const imported=await core({action:'import',path:join(source,'zotero-export.json')},{library});
const [paper,other]=imported.items;
await core({action:'update',id:paper.id,metadata:{author:[{family:'Park',given:'Ada',affiliation:[{name:'Example Urban Institute',source:'Synthetic fixture',id:'example-org'}]}],publication_dates:{published:'2025-06',received:'2024-09-12',accepted:'2025-04-01'},journal_rankings:[{system:'JCR',year:2025,quartile:'Q2',category:'Synthetic urban studies',source:'Synthetic fixture only'}]}},{library});
await core({action:'import',items:Array.from({length:45},(_,i)=>({id:`catalog-fixture-${i}`,title:`Synthetic catalog ${String(i).padStart(2,'0')}`,author:[{family:`Reader${i}`,given:'Example'}],issued:{'date-parts':[[2000+i%25]]},'container-title':'Synthetic Journal'}))},{library});
let server,browser,startTimer;const errors=[],apiCalls=[];
try {
  server=spawn(process.execPath,['src/server.mjs','--port','0','--library',library],{cwd:project,env:{...process.env,DSH_HOME:process.env.DSH_HOME||join(run,'dsh-home')},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((accept,reject)=>{startTimer=setTimeout(()=>reject(new Error('Server startup timed out')),15000);server.stdout.on('data',data=>{const match=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match)accept(match[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Server exited ${code}`)));});clearTimeout(startTimer);
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:741,height:597}});
  const metadataReady=()=>page.waitForFunction(()=>{const form=document.getElementById('metadata-form');return form&&!form.inert;});
  const graphReady=()=>page.waitForFunction(()=>document.querySelector('[data-kg="canvas"] svg')&&!document.querySelector('[data-kg="save"]')?.disabled);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/api')){try{apiCalls.push(request.postDataJSON());}catch{}}});
  await page.goto(origin);await page.waitForLoadState('networkidle');
  await page.locator('#search').fill(paper.title);await page.locator(`.paper-card[data-id="${paper.id}"]`).waitFor();await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('.pdr-sheet[data-loaded="true"]').first().waitFor();
  await page.screenshot({path:join(run,'reader-741.png')});
  await page.locator('#ribbon-citations').click();await page.locator('#paper-tools #copy-apa').waitFor();await page.locator('#metadata-open').click();await page.locator('#reading-side-panel').waitFor();
  assert.equal(await page.locator('#paper-tools #copy-apa').count(),1);assert.equal(await page.locator('.paper-header #copy-apa').count(),0);
  assert.ok(Number.parseFloat(await page.locator('#paper-title').evaluate(n=>getComputedStyle(n).fontSize))<=20);
  assert.ok(Number.parseFloat(await page.locator('.paper-card h3').first().evaluate(n=>getComputedStyle(n).fontSize))<=14);
  assert.match(await page.locator('#paper-metadata').innerText(),/Example Urban Institute/);assert.match(await page.locator('#paper-metadata').innerText(),/2024-09-12/);assert.match(await page.locator('#paper-metadata').innerText(),/2025 Q2/);
  await page.locator('#reading-side-panel').getByRole('button',{name:'收起阅读侧栏',exact:true}).click();
  record('compact-current-paper-toolbar-cards-title-and-sourced-metadata');
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  assert.equal(await overflow(),false);record('741px-reader-has-no-document-horizontal-overflow');
  await page.locator('#catalog-expand').click();await page.locator('#catalog-table table').waitFor();
  await page.screenshot({path:join(run,'catalog-741.png')});
  if(process.argv.includes('--recon')){console.log(JSON.stringify({run:relative(project,run),dom:await page.locator('body').innerText(),errors}));}
  else {
    await page.locator('#search').fill('Synthetic catalog');await page.locator('#list-range').filter({hasText:'1–40 / 45'}).waitFor();
    const pagesBefore=apiCalls.filter(c=>c.action==='page').length;
    await page.locator('#catalog-sort').selectOption('title');
    if(await page.locator('#catalog-order').innerText()==='降序 ↓')await page.locator('#catalog-order').click();
    await page.locator('#catalog-table .table-title').first().filter({hasText:'Synthetic catalog 00'}).waitFor();
    await page.locator('#next-list').click();await page.locator('#list-range').filter({hasText:'41–45 / 45'}).waitFor();assert.equal(await page.locator('#catalog-table tbody tr').count(),5);
    await page.locator('#catalog-table .table-title').first().click();assert.equal(apiCalls.filter(c=>c.action==='page').length,pagesBefore);
    assert.equal(await overflow(),false);record('server-sort-search-40-row-pagination-and-metadata-only-selection');
    await page.locator('#catalog-create').click();await metadataReady();await page.locator('#edit-title').fill('UI synthetic newly created paper');await page.locator('#edit-authors').fill('Example, Taylor');await page.locator('#edit-year').fill('2026');await page.locator('#edit-journal').fill('Fixture Journal');await page.locator('#edit-affiliations').fill('1 | Fixture Institute');await page.locator('#edit-received').fill('2025-10-12');
    await page.locator('#ranking-add').click();await page.getByRole('spinbutton',{name:'报告年份',exact:true}).fill('2025');await page.getByRole('combobox',{name:'分区',exact:true}).selectOption('Q1');await page.getByRole('textbox',{name:'学科',exact:true}).fill('Fixture science');await page.getByRole('textbox',{name:'来源 URL 或书目',exact:true}).fill('Synthetic source');
    await page.locator('#metadata-form button[type="submit"]').click();await page.locator('#metadata-dialog').waitFor({state:'hidden'});
    await page.locator('#search').fill('UI synthetic');await page.locator('#catalog-table .table-title').filter({hasText:'newly created'}).waitFor();
    let row=page.locator('#catalog-table tbody tr').first();await row.getByRole('button',{name:'编辑',exact:true}).click();await metadataReady();await page.locator('#edit-title').fill('UI synthetic edited paper');await page.locator('#metadata-form button[type="submit"]').click();await page.locator('#metadata-dialog').waitFor({state:'hidden'});await page.locator('#catalog-table .table-title').filter({hasText:'edited paper'}).waitFor();
    await row.getByRole('button',{name:'移入回收站',exact:true}).click();await page.locator('#list-range').filter({hasText:'0 篇'}).waitFor();
    await page.locator('#catalog-scope').selectOption('archived');await page.locator('#catalog-table tbody tr').waitFor();await page.getByRole('button',{name:'恢复',exact:true}).click();await page.locator('#list-range').filter({hasText:'0 篇'}).waitFor();await page.locator('#catalog-scope').selectOption('active');await page.locator('#catalog-table .table-title').filter({hasText:'edited paper'}).waitFor();record('manual-create-rich-metadata-edit-archive-and-restore-through-visible-ui');
    await page.locator('#search').fill(paper.title);await page.locator('#catalog-table .table-title').filter({hasText:paper.title}).waitFor();await page.locator('#catalog-table tbody tr').first().getByRole('button',{name:'阅读',exact:true}).click();await page.locator('.pdr-sheet[data-loaded="true"]').first().waitFor();
    await page.locator('#metadata-open').click();await metadataReady();await page.locator('#edit-title').fill(paper.title+' revised');await page.locator('#metadata-form button[type="submit"]').click();await page.locator('#metadata-dialog').waitFor({state:'hidden'});
    const saved=await core({action:'get',id:paper.id},{library});assert.equal(saved.author[0].affiliation[0].source,'Synthetic fixture');assert.equal(saved.author[0].affiliation[0].id,'example-org');record('ordinary-metadata-edits-preserve-affiliation-provenance');
    await page.locator('[data-tab="graph"]').click();await page.locator('[data-kg="canvas"] svg').waitFor();
    for(const [type,label] of [['method','Matched pair comparison'],['dataset','Synthetic observations'],['claim','A synthetic testable claim'],['evidence','Synthetic supporting observation']]){
      await graphReady();await page.locator('[data-kg="add-node"]').click();const form=page.locator('[data-kg="form"]');await form.locator('[name="type"]').selectOption(type);await form.locator('[name="label"]').fill(label);await form.locator('[name="page"]').fill('2');await form.locator('[name="quote"]').fill('Synthetic exact passage for fixture validation.');await form.locator('[name="note"]').fill('Reader assertion for a synthetic test.');await page.locator('[data-kg="save"]').click();await page.locator('[data-kg="dialog"]').waitFor({state:'hidden'});await graphReady();
    }
    await page.locator('[data-kg="add-edge"]').click();const form=page.locator('[data-kg="form"]');await form.locator('[name="source"]').selectOption({label:'论据 · Synthetic supporting observation'});await form.locator('[name="target"]').selectOption({label:'论点 · A synthetic testable claim'});await form.locator('[name="relation"]').selectOption('supports');await form.locator('[name="page"]').fill('2');await form.locator('[name="note"]').fill('Comparison provides support under the stated synthetic assumptions.');await page.locator('[data-kg="save"]').click();await page.locator('[data-kg="dialog"]').waitFor({state:'hidden'});
    const graph=await core({action:'graph',id:paper.id},{library});for(const type of ['author','institution','method','dataset','claim','evidence'])assert.ok(graph.nodes.some(n=>n.type===type));assert.ok(graph.edges.some(e=>e.relation==='supports'));record('typed-scientific-nodes-metadata-projections-directed-evidence-edge-persist');
    await page.screenshot({path:join(run,'graph-741.png')});assert.equal(await overflow(),false);
    await page.getByRole('button',{name:/论据 · Synthetic supporting observation/}).first().click();await page.locator('[data-kg="inspector"]').getByRole('button',{name:'返回 PDF 第 2 页',exact:true}).click();await page.waitForFunction(()=>document.getElementById('page-number').value==='2');await page.locator('.pdr-sheet[data-pdf-page="2"][data-loaded="true"]').waitFor();record('graph-evidence-returns-to-known-pdf-page');
    await page.setViewportSize({width:430,height:800});assert.equal(await overflow(),false);await page.screenshot({path:join(run,'reader-430.png')});await page.setViewportSize({width:1400,height:950});assert.equal(await overflow(),false);
    await page.waitForFunction(()=>{const number=document.getElementById('page-number').value;const image=document.querySelector(`.pdr-sheet[data-pdf-page="${number}"] img`),reader=document.getElementById('continuous-reader');return image?.complete&&Math.abs(image.clientWidth-Math.min(1100,reader.clientWidth-24))<2&&image.naturalWidth>=image.clientWidth*.95;});
    assert.equal(await page.locator('#page-number').inputValue(),'2');await page.screenshot({path:join(run,'reader-1400.png')});record('430-and-1400px-reading-layout-has-no-document-overflow-and-resize-restores-sharp-page-anchor');
    // A durable reader may restore the graph tab, where the loaded PDF is
    // intentionally hidden; graph visibility below is the acceptance target.
    await page.reload();await page.waitForLoadState('networkidle');await page.locator('#search').fill(paper.title);await page.locator(`.paper-card[data-id="${paper.id}"]`).waitFor();await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('.pdr-sheet[data-loaded="true"]').first().waitFor({state:'attached'});await page.locator('[data-tab="graph"]').click();await page.locator('[data-kg="canvas"] svg').waitFor();assert.match(await page.locator('[data-kg="relations"]').innerText(),/支持/);record('fresh-page-reloads-saved-graph-and-rich-metadata');
    // Exercise graph changes through the same visible controls a reader uses.
    // Existing screenshots intentionally retain the full graph before deletion.
    const originalMethod=graph.nodes.find(node=>node.type==='method'),originalDataset=graph.nodes.find(node=>node.type==='dataset'),originalEdge=graph.edges.find(edge=>edge.relation==='supports');
    await page.getByRole('button',{name:'方法 · Matched pair comparison',exact:true}).click();
    await page.locator('[data-kg="inspector"]').getByRole('button',{name:'编辑节点',exact:true}).click();
    await form.locator('[name="label"]').fill('Revised matched pair method');await form.locator('[name="description"]').fill('A revised synthetic method description.');await form.locator('[name="note"]').fill('Revised reader method interpretation.');
    await page.locator('[data-kg="save"]').click();await page.locator('[data-kg="dialog"]').waitFor({state:'hidden'});await page.getByRole('button',{name:'方法 · Revised matched pair method',exact:true}).waitFor();
    let editedGraph=await core({action:'graph',id:paper.id},{library});let editedMethod=editedGraph.nodes.find(node=>node.id===originalMethod.id);
    assert.equal(editedMethod.label,'Revised matched pair method');assert.equal(editedMethod.description,'A revised synthetic method description.');assert.equal(editedMethod.evidence.note,'Revised reader method interpretation.');assert.equal(editedMethod.evidence.quote,'Synthetic exact passage for fixture validation.');
    await page.locator('[data-kg="filter"]').selectOption('method');assert.equal(await page.locator('[data-kg="canvas"] .kg-node').count(),2);assert.equal(await page.locator('[data-kg="canvas"] .kg-type-method').count(),1);
    assert.match(await page.locator('[data-kg="relations-heading"]').innerText(),/此节点的关系/);await page.locator('[data-kg="reset"]').click();assert.equal(await page.locator('[data-kg="inspector"]').isVisible(),false);assert.equal(await page.locator('[data-kg="relations-heading"]').innerText(),`关系 · ${editedGraph.edges.length}`);await page.locator('[data-kg="filter"]').selectOption('');assert.equal(await page.locator('[data-kg="canvas"] .kg-node').count(),editedGraph.nodes.length);
    record('visible-node-edit-preserves-source-and-type-filter-restores-all-relations');
    let relation=page.locator('[data-kg="relations"] .kg-relation').filter({has:page.locator('summary').filter({hasText:'A synthetic testable claim'})}).filter({has:page.locator('.kg-relation-name').filter({hasText:'支持'})});
    await relation.locator('summary').click();await relation.getByRole('button',{name:'编辑关系',exact:true}).click();await form.locator('[name="relation"]').selectOption('contradicts');await form.locator('[name="note"]').fill('Revised interpretation contradicts the synthetic claim.');await page.locator('[data-kg="save"]').click();await page.locator('[data-kg="dialog"]').waitFor({state:'hidden'});
    relation=page.locator('[data-kg="relations"] .kg-relation').filter({has:page.locator('summary').filter({hasText:'A synthetic testable claim'})}).filter({has:page.locator('.kg-relation-name').filter({hasText:'矛盾'})});await relation.waitFor();
    editedGraph=await core({action:'graph',id:paper.id},{library});const editedEdge=editedGraph.edges.find(edge=>edge.id===originalEdge.id);assert.equal(editedEdge.relation,'contradicts');assert.equal(editedEdge.source,originalEdge.source);assert.equal(editedEdge.target,originalEdge.target);assert.equal(editedEdge.evidence.note,'Revised interpretation contradicts the synthetic claim.');assert.equal(editedEdge.evidence.page,2);
    // Confirm dialogs authorize only deletions in this isolated synthetic library.
    page.on('dialog',dialog=>dialog.accept());await relation.locator('summary').click();await relation.getByRole('button',{name:'删除关系',exact:true}).click();await relation.waitFor({state:'hidden'});
    editedGraph=await core({action:'graph',id:paper.id},{library});assert.equal(editedGraph.edges.some(edge=>edge.id===originalEdge.id),false);assert.ok(editedGraph.nodes.some(node=>node.id===originalEdge.source));assert.ok(editedGraph.nodes.some(node=>node.id===originalEdge.target));record('visible-relation-edit-and-delete-preserve-direction-sources-and-endpoint-nodes');
    await page.getByRole('button',{name:'数据 · Synthetic observations',exact:true}).click();await page.locator('[data-kg="inspector"]').getByRole('button',{name:'删除节点',exact:true}).click();await page.getByRole('button',{name:'数据 · Synthetic observations',exact:true}).waitFor({state:'hidden'});
    editedGraph=await core({action:'graph',id:paper.id},{library});assert.equal(editedGraph.nodes.some(node=>node.id===originalDataset.id),false);assert.equal(editedGraph.edges.some(edge=>edge.source===originalDataset.id||edge.target===originalDataset.id),false);assert.equal((await core({action:'get',id:paper.id},{library})).pdf,true);
    await page.reload();await page.waitForLoadState('networkidle');await page.locator('#search').fill(paper.title);await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('.pdr-sheet[data-loaded="true"]').first().waitFor({state:'attached'});await page.locator('[data-tab="graph"]').click();await page.getByRole('button',{name:'方法 · Revised matched pair method',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'数据 · Synthetic observations',exact:true}).count(),0);assert.equal(await page.locator('[data-kg="relations"] .kg-relation-name').filter({hasText:'矛盾'}).count(),0);record('visible-node-delete-and-fresh-reload-retain-edits-and-deletions-with-pdf-intact');
    assert.deepEqual(errors,[]);record('no-browser-runtime-errors');
    await writeFile(join(project,'docs/validation/workbench-browser.json'),JSON.stringify({verified_at:new Date().toISOString(),checks,viewports:[[741,597],[430,800],[1400,950]],browser_errors:errors,model_requests:0,scope:'Synthetic catalog and PDF only; no external metadata lookup, no formal user validation',screenshots:relative(project,run)},null,2)+'\n');
  }
  console.log(JSON.stringify({run:relative(project,run),checks:checks.length,errors}));
} catch(error) {console.error(error);process.exitCode=1;}
finally{clearTimeout(startTimer);await browser?.close();if(server&&server.exitCode===null){server.kill('SIGINT');await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},2000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}}
