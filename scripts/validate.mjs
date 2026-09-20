import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const commands=[
  ['client_build',process.execPath,['scripts/build.mjs']],
  ['javascript_tests',process.execPath,['--test',...(await readdir('tests-js')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`tests-js/${name}`)]],
  ['python_tests','uv',['run','--offline','pytest','-q']],
  ['browser_syntax',process.execPath,['--check','web/app.js']],
  ['paper_chat_syntax',process.execPath,['--check','web/paper-chat.js']],
  ['companion_syntax',process.execPath,['--check','web/companion.js']],
  ['workbench_syntax',process.execPath,['--check','web/workbench.js']],
  ['knowledge_graph_syntax',process.execPath,['--check','web/knowledge-graph.js']],
  ['pdf_reader_syntax',process.execPath,['--check','web/pdf-reader.js']],
  ['reading_panels_syntax',process.execPath,['--check','web/reading-panels.js']],
  ['reading_shell_syntax',process.execPath,['--check','web/reading-shell.js']],
  ['local_state_syntax',process.execPath,['--check','web/local-state.js']],
  ['language_learning_syntax',process.execPath,['--check','web/language-learning.js']],
  ['theme_syntax',process.execPath,['--check','web/theme.js']],
  ['resource_library_syntax',process.execPath,['--check','web/resource-library.js']],
  ['knowledge_workflow_syntax',process.execPath,['--check','web/knowledge-workflow.js']],
  ['paper_analysis_syntax',process.execPath,['--check','web/paper-analysis.js']],
  ['challenge_mining_syntax',process.execPath,['--check','web/challenge-mining.js']],
  ['annotation_threads_syntax',process.execPath,['--check','web/annotation-threads.js']],
  ['board_syntax',process.execPath,['--check','web/board.js']],
  ['board_bridge_syntax',process.execPath,['--check','web/board-bridge.js']],
  ['standalone_syntax',process.execPath,['--check','site/standalone.js']],
  ['site_build',process.execPath,['scripts/build-site.mjs']],
  ['settings_syntax',process.execPath,['--check','web/settings.js']],
];
const checks=[];
for(const[id,command,args]of commands){
  const start=performance.now();
  const run=spawnSync(command,args,{encoding:'utf8',env:{...process.env,UV_CACHE_DIR:'/private/tmp/codex-uv'},maxBuffer:4*1024*1024});
  const output=(run.stdout||'')+(run.stderr||'');
  const count=id==='javascript_tests'?output.match(/(?:#|ℹ) tests (\d+)/)?.[1]:id==='python_tests'?output.match(/(\d+) passed/)?.[1]:undefined;
  checks.push({id,command:[command,...args].join(' '),exit_code:run.status,elapsed_ms:Math.round(performance.now()-start),status:run.status===0?'pass':'fail',...(count?{test_count:Number(count)}:{}),output:output.replaceAll(process.cwd(),'<project>')});
  console.log(`${id}: ${run.status===0?'PASS':'FAIL'}`);
  if(run.status!==0)console.log(output);
}
const manifest=JSON.parse(await readFile('vendor/csl/manifest.json','utf8'));
for(const asset of manifest.resources){
  const digest=createHash('sha256').update(await readFile(`vendor/csl/${asset.name}`)).digest('hex');
  checks.push({id:`csl_hash_${asset.name}`,status:digest===asset.sha256?'pass':'fail',sha256:digest});
}
// A web module can be copied and served yet never loaded: the standalone site shipped
// `board-mermaid.js` (200 OK, listed in the asset log) while its template had no script tag for
// it, so the feature was dead online. This check keeps every script tag and every copied asset
// in step with what the two hosts actually load.
try{
  const shell=await readFile('web/index.html','utf8');
  const siteTemplate=await readFile('site/index.html','utf8');
  const httpSource=await readFile('src/http.mjs','utf8');
  const buildSite=await readFile('scripts/build-site.mjs','utf8');
  const tags=source=>[...source.matchAll(/<script src="\.\/([\w.-]+\.js)"/g)].map(match=>match[1]);
  const pluginScripts=tags(shell), siteScripts=tags(siteTemplate);
  const served=source=>[...source.matchAll(/'([\w.-]+\.js)'/g)].map(match=>match[1]);
  const allowlisted=new Set(served(httpSource));
  const copied=new Set(served(buildSite));
  const notServed=pluginScripts.filter(name=>!allowlisted.has(name));
  const notCopied=siteScripts.filter(name=>!copied.has(name));
  const notLoadedBySite=pluginScripts.filter(name=>!siteScripts.includes(name) && copied.has(name));
  const problems=[...notServed.map(name=>`web/index.html loads ${name} but src/http.mjs does not serve it`),
    ...notCopied.map(name=>`site/index.html loads ${name} but scripts/build-site.mjs does not copy it`),
    ...notLoadedBySite.map(name=>`${name} is copied to the standalone site but site/index.html never loads it`)];
  checks.push({id:'web_asset_wiring',status:problems.length?'fail':'pass',plugin_scripts:pluginScripts.length,site_scripts:siteScripts.length,...(problems.length?{problems}:{})});
  console.log(`web_asset_wiring: ${problems.length?'FAIL':'PASS'}`);
  if(problems.length)console.log(problems.join('\n'));
}catch(error){
  checks.push({id:'web_asset_wiring',status:'fail',problems:[error.message]});
  console.log(`web_asset_wiring: FAIL\n${error.message}`);
}
const report={verified_at:new Date().toISOString(),scope:'Synthetic fixtures, source/runtime integration and checks listed below; excludes WPS and real provider completion',checks};
await mkdir('docs/validation',{recursive:true});
await writeFile('docs/validation/automated.json',JSON.stringify(report,null,2)+'\n');
if(checks.some(c=>c.status!=='pass'))process.exitCode=1;
