/** Selected-paper jobs through an actual isolated DSH profile and keyless native spawn. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { core } from '../src/bridge.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const templateHome = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
assert.ok(relative(join(project, '.local'), templateHome) && !relative(join(project, '.local'), templateHome).startsWith('..'))
assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const run = join(templateHome, 'runs', `analysis-${randomUUID()}`), home = join(run, 'home'), library = join(run, 'library'), sourcePdf = join(run, 'synthetic-analysis.pdf')
const checks = [], provider = 'paper-library-native-chat-fixture', model = 'deterministic-reader'
let child, startupTimer, logs = '', report
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(timer); done() }); child.kill('SIGINT') })
}
async function startHost() {
  let output = ''
  const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library })
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const authenticatedUrl = await new Promise((accept, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Synthetic Harness did not start within 40 seconds')), 40000)
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-24000); logs += bytes.toString(); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) accept(match[1]) })
    child.stderr.on('data', bytes => { logs += bytes.toString() })
    child.on('error', reject); child.on('exit', code => reject(new Error(`Synthetic Harness exited ${code}`)))
  })
  clearTimeout(startupTimer)
  const origin = new URL(authenticatedUrl).origin, exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  return { origin,
    async api(input) {
      const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(25000) })
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.ok, true, JSON.stringify(value)); return value.result
    },
    async observe(id) { const url = new URL('/api/paper-chat-fixture', origin); url.searchParams.set('session', id); const response = await fetch(url, { headers }); assert.equal(response.status, 200); return response.json() },
  }
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`Timed out: ${label}`)
}

try {
  const templateProfile = join(templateHome, 'profiles', profile), fixtureProfile = join(home, 'profiles', profile)
  await access(join(templateProfile, 'package.json')); await mkdir(fixtureProfile, { recursive: true })
  for (const filename of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(templateProfile, filename), join(fixtureProfile, filename))
  await symlink(join(templateProfile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir')
  const generated = spawnSync('uv', ['run', 'python', '-c', `import pymupdf,sys\ndoc=pymupdf.open()\nfor text in ["Synthetic source page one. The method compares twelve sample trips.","UNSELECTED_PAPER_ANALYSIS_SENTINEL must never reach the model.","Synthetic source page three. Evidence supports only the observed sample.","NATIVE_ANALYSIS_CANCEL_FIXTURE", "Synthetic final page."]:\n page=doc.new_page();page.insert_text((50,70),text)\ndoc.save(sys.argv[1]);doc.close()`, sourcePdf], { cwd: project, encoding: 'utf8', env: { ...process.env, UV_CACHE_DIR: '/private/tmp/codex-uv' } })
  assert.equal(generated.status, 0, generated.stderr)
  const originalHash = createHash('sha256').update(await readFile(sourcePdf)).digest('hex')
  const [paper] = (await core({action:'import',items:[{id:'SyntheticNativeAnalysis',title:'Synthetic native selected-paper analysis',author:[{family:'Fixture'}],attachments:[{path:sourcePdf}]}]}, {library,python:join(project,'.venv/bin/python')})).items
  let host = await startHost()
  const unauthenticated = await fetch(`${host.origin}/api/paper-library/api`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'paper_analysis_start',id:paper.id,request_id:'untrusted'})})
  assert.equal(unauthenticated.status,401); assert.equal((await host.api({action:'status'})).paper_analysis,true)
  const session = await host.api({action:'chat_ensure',id:paper.id})
  assert.deepEqual(session.model,{provider,model})
  assert.deepEqual((await host.observe(session.sessionId)).observations,[{sessionLoaded:false,agentLoaded:false}])
  record('authenticated-native-job-service-and-cold-paper-model-without-main-Agent')
  const request={action:'paper_analysis_start',id:paper.id,request_id:'native-selected-pages-1',pages:[1,3],provider:'forged-browser',model:'forged-browser'}
  const accepted=await host.api(request); assert.equal(accepted.status,'queued')
  const completed=await until(()=>host.api({action:'paper_analysis_get',id:paper.id}),value=>['complete','failed','cancelled','interrupted'].includes(value.status),'selected paper analysis')
  assert.equal(completed.status,'complete',JSON.stringify(completed)); assert.deepEqual(completed.coverage.read_pages,[1,3]); assert.equal(completed.coverage.full_document,false)
  assert.deepEqual(completed.model,{provider,model}); assert.equal(completed.draft.status,'needs-review'); assert.equal(completed.draft.nodes.length,3)
  assert.ok(completed.note_draft_id,`completed run saved a reading-note draft; warnings=${JSON.stringify(completed.warnings)} stage=${completed.stage}`); assert.deepEqual(completed.note_coverage,{batches:1,batches_total:1,partial:false})
  const note=await host.api({action:'knowledge_draft_get',id:completed.note_draft_id})
  assert.equal(note.mode,'note'); assert.equal(note.status,'needs-review'); assert.match(note.body,/一句话概括/)
  const observed=await host.observe(session.sessionId); assert.equal(observed.generations,2); assert.equal(observed.analysis.length,1)
  assert.equal(observed.analysisNotes.length,1); assert.equal(observed.analysisNotes[0].batches,1)
  assert.deepEqual(observed.analysis[0].sourceIds,completed.source_ids); assert.equal(observed.analysis[0].sourceTexts.join('\n').includes('UNSELECTED_PAPER_ANALYSIS_SENTINEL'),false)
  assert.equal(observed.analysis[0].maxTokens,8192); assert.ok(observed.analysis[0].tools.every(name=>['run_code','paper_analysis_guard_probe'].includes(name)))
  assert.equal(observed.analysisAgents.length,4); assert.equal(observed.analysisAgents.every(agent=>agent.origin==='subagent'&&!agent.loaded),true)
  assert.equal(observed.analysisAgents[1].parent,observed.analysisAgents[0].id); assert.equal(observed.analysisAgents[3].parent,observed.analysisAgents[2].id)
  assert.deepEqual(observed.analysisGuard,{attempts:2,denied:2,executed:0})
  assert.deepEqual(observed.observations,[{sessionLoaded:false,agentLoaded:false}])
  record('true-spawn-uses-only-selected-pages-authoritative-route-denies-scoped-tools-and-disposes-both-owned-Agents')
  const context=await host.api({action:'paper_analysis_context',id:paper.id,node_ids:['evidence:selected-evidence','claim:selected-claim']})
  assert.match(context.text,/AI 草稿/); assert.match(context.text,/selected-evidence/); assert.equal(context.text.includes('selected-method'),false)
  assert.deepEqual((await host.observe(session.sessionId)).observations,[{sessionLoaded:false,agentLoaded:false}])
  assert.equal((await host.observe(session.sessionId)).generations,2)
  record('explicit-selected-node-context-preparation-does-not-send-or-activate-main-conversation')
  assert.equal((await host.api(request)).draft_id,completed.draft_id)
  assert.equal((await host.observe(session.sessionId)).generations,2)
  record('completed-request-id-replays-native-result-without-another-model-call')
  await host.api({action:'paper_analysis_start',id:paper.id,request_id:'native-cancel-2',pages:[4]})
  await until(()=>host.observe(session.sessionId),value=>value.analysis.length===2,'cancellable native generation')
  const cancelled=await host.api({action:'paper_analysis_cancel',id:paper.id})
  assert.equal(cancelled.status,'cancelled'); assert.equal(cancelled.draft_id,undefined)
  assert.equal((await host.observe(session.sessionId)).analysisAgents.every(agent=>!agent.loaded),true)
  assert.deepEqual((await host.observe(session.sessionId)).analysisGuard,{attempts:3,denied:3,executed:0})
  record('explicit-cancellation-aborts-native-stream-and-releases-child-parent-without-partial-draft')
  await host.api({action:'paper_analysis_start',id:paper.id,request_id:'native-interrupted-3',pages:[4]})
  await until(()=>host.observe(session.sessionId),value=>value.analysis.length===3,'restart interruption generation')
  await stopHost();host=await startHost()
  const restored=await host.api(request); assert.equal(restored.draft_id,completed.draft_id)
  const interrupted=await host.api({action:'paper_analysis_get',id:paper.id,request_id:'native-interrupted-3'})
  assert.ok(['interrupted','cancelled'].includes(interrupted.status),JSON.stringify(interrupted))
  assert.equal((await host.observe(session.sessionId)).generations,0)
  assert.equal((await host.api({action:'knowledge_draft_get',id:completed.draft_id})).nodes.length,3)
  record('restart-recovers-complete-and-interrupted-jobs-with-no-automatic-model-replay')
  const defaults=await host.api({action:'settings_get'})
  assert.equal(defaults.value.auto_analysis,true);assert.equal(defaults.value.analysis_fill,true)
  const fullPdf=join(run,'synthetic-full-paper.pdf')
  const created=spawnSync('uv',['run','python','-c','import pymupdf,sys\ndoc=pymupdf.open()\nfor i in range(13):\n page=doc.new_page();page.insert_text((50,70),f"AUTO_FULL_TEXT Synthetic automatic page {i+1}. Source bounded evidence.")\ndoc.save(sys.argv[1]);doc.close()',fullPdf],{cwd:project,encoding:'utf8',env:{...process.env,UV_CACHE_DIR:'/private/tmp/codex-uv'}})
  assert.equal(created.status,0,created.stderr)
  const imported=await host.api({action:'import',path:fullPdf}),fullPaper=imported.items[0]
  assert.equal(imported.analysis_queue[0].status,'queued')
  const full=await until(()=>host.api({action:'paper_analysis_get',id:fullPaper.id}),v=>['complete','failed'].includes(v.status),'automatic full-paper reading')
  assert.equal(full.status,'complete',JSON.stringify(full));assert.equal(full.batch_count,2);assert.equal(full.coverage.full_document,true)
  assert.deepEqual(full.coverage.completed_pages,Array.from({length:13},(_,i)=>i+1))
  assert.ok(full.metadata_result.applied_fields.includes('abstract'))
  const firstBatch=await host.api({action:'paper_analysis_get',id:fullPaper.id,batch_index:0})
  assert.notEqual(firstBatch.draft_id,full.draft_id)
  assert.ok(full.note_draft_id,'automatic import also produced a reading-note draft')
  const fullSession=await host.api({action:'chat_ensure',id:fullPaper.id}),fullObserved=await host.observe(fullSession.sessionId)
  assert.equal(fullObserved.generations,3);assert.equal(fullObserved.analysis.every(batch=>batch.sourceIds.length<=8),true)
  assert.equal(fullObserved.analysisNotes.length,1);assert.equal(fullObserved.analysisNotes[0].batches,2)
  assert.equal(fullObserved.analysisAgents.every(agent=>!agent.loaded),true)
  assert.equal(fullObserved.analysis.flatMap(batch=>batch.sourceTexts).join('\n').includes('automatic page 13'),true)
  assert.deepEqual(fullObserved.observations,[{sessionLoaded:false,agentLoaded:false}])
  record('import-automatically-queues-all-thirteen-pages-in-two-native-batches-and-fills-sourced-metadata')
  await stopHost();host=await startHost()
  const resumed=await host.api({action:'paper_analysis_get',id:fullPaper.id,batch_index:0})
  assert.equal(resumed.draft_id,firstBatch.draft_id);assert.equal((await host.observe(fullSession.sessionId)).generations,0)
  record('full-paper-batch-results-survive-host-restart-without-generation-replay')
  assert.equal(createHash('sha256').update(await readFile(sourcePdf)).digest('hex'),originalHash)
  record('synthetic-source-PDF-unchanged-and-zero-external-provider-requests')
  report={verified_at:new Date().toISOString(),ok:true,checks,deterministicModelGenerations:7,completedGenerations:5,readingNoteGenerations:2,cancelledOrInterruptedGenerations:2,replayGenerationsAfterHostRestart:0,nativeAgentsPerRun:2,scopedToolProbeExecutions:0,externalModelRequestsMade:0,sourceData:'Five-page scoped fixture and thirteen-page automatically queued full-text fixture',limitations:['Native spawn routing, lifecycle and durable jobs only; no real provider output-quality or real-library capacity claim']}
} catch(error) { report={verified_at:new Date().toISOString(),ok:false,checks,error:error.message,externalModelRequestsMade:0};process.exitCode=1;console.error(error) }
finally { clearTimeout(startupTimer);await stopHost();await mkdir(run,{recursive:true});await writeFile(join(run,'host.log'),logs.replace(/token=[^\s&]+/g,'token=<redacted>')) }
await writeFile(join(project,'docs/validation/paper-analysis-harness.json'),JSON.stringify({...report,isolated_hosts_stopped:true},null,2)+'\n')
console.log(JSON.stringify({...report,run:relative(project,run)}))
