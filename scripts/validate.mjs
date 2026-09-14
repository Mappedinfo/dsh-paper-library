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
  ['workbench_syntax',process.execPath,['--check','web/workbench.js']],
  ['knowledge_graph_syntax',process.execPath,['--check','web/knowledge-graph.js']],
  ['pdf_reader_syntax',process.execPath,['--check','web/pdf-reader.js']],
  ['reading_panels_syntax',process.execPath,['--check','web/reading-panels.js']],
  ['reading_shell_syntax',process.execPath,['--check','web/reading-shell.js']],
  ['local_state_syntax',process.execPath,['--check','web/local-state.js']],
  ['language_learning_syntax',process.execPath,['--check','web/language-learning.js']],
  ['theme_syntax',process.execPath,['--check','web/theme.js']],
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
const report={verified_at:new Date().toISOString(),scope:'Synthetic fixtures, source/runtime integration and checks listed below; excludes WPS and real provider completion',checks};
await mkdir('docs/validation',{recursive:true});
await writeFile('docs/validation/automated.json',JSON.stringify(report,null,2)+'\n');
if(checks.some(c=>c.status!=='pass'))process.exitCode=1;
