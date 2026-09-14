import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatch } from '../src/bridge.mjs';

const library=resolve(process.argv[2] || 'artifacts/capacity-2000-1000/library');
const output=resolve(process.argv[3] || 'artifacts/capacity-2000-1000/node-report.json');
const measurements=[];
function sample(stage) {
  const m=process.memoryUsage();
  measurements.push({stage,rss_mib:+(m.rss/1048576).toFixed(2),heap_used_mib:+(m.heapUsed/1048576).toFixed(2)});
}
sample('adapter_loaded');
const status=await dispatch({action:'status'},{library});
sample('catalog_opened');
for(let i=0;i<30;i++) await dispatch({action:'list',query:'urban',limit:40,offset:i*40},{library});
sample('after_30_searches');
const result=await dispatch({action:'list',limit:200},{library});
const ids=result.items.filter(i=>i.pdf).slice(0,20).map(i=>i.id);
for(const id of ids) await dispatch({action:'page',id,page:1,scale:1.25},{library});
sample('after_document_switches');
if(global.gc)global.gc();
sample('after_explicit_gc');
await dispatch({action:'cite',ids:[result.items[0].id],format:'apa'},{library});
sample('after_first_apa');
if(global.gc)global.gc();
sample('after_citation_gc');
const children=spawnSync('pgrep',['-P',String(process.pid)],{encoding:'utf8'});
const report={generated_at:new Date().toISOString(),node:process.version,records:status.count,document_switches:ids.length,explicit_gc_available:!!global.gc,
  measurements,resident_worker_pids:children.status===1?[]:children.stdout.trim().split('\n').filter(Boolean),
  limits:['Node adapter only, excluding Harness/browser','Synthetic text PDFs','Explicit GC measurements are diagnostic, not normal timing guarantees']};
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
