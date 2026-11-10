#!/usr/bin/env node
import { resolve } from 'node:path';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createFieldRadarStore } from '../src/harness/field-radar.mjs';
import { createFieldRadarAnalysis } from '../src/harness/field-radar-analysis.mjs';
import { createFieldRadarExporter } from '../src/harness/field-radar-export.mjs';
try {
  const args = process.argv.slice(2), values = {}, allowed = ['library','id','expected-revision','view','format','query','task','year','width','offset','limit','group-by','frequency-by','language','analysis-request-id','state-home'];
  for(let i=0;i<args.length;i+=2){const k=args[i]?.replace(/^--/,'');if(!args[i]?.startsWith('--')||!allowed.includes(k)||!args[i+1]||args[i+1].startsWith('--')||k in values)throw new Error('Expected unique --library/--id/--view/--format/--query/--task/--year/--width/--offset/--limit pairs');values[k]=args[i+1];}
  if(!values.library||!values.id)throw new Error('Usage: node scripts/export-field-radar.mjs --library PATH --id TOPIC [--view overview --format png]');
  const library=resolve(values.library), store=createLocalStateStore({library,...(values['state-home']?{home:resolve(values['state-home'])}:{})}), radar=createFieldRadarStore({store,library});
  const input={id:values.id,filters:Object.fromEntries(['query','task','year'].filter(k=>k in values).map(k=>[k,values[k]]))};
  if('expected-revision' in values)input.expected_revision=values['expected-revision'];
  for(const k of ['group-by','frequency-by'])if(k in values)input[k.replace('-','_')]=values[k];
  for(const k of ['view','format','language'])if(k in values)input[k]=values[k];for(const k of ['width','offset','limit'])if(k in values)input[k]=Number(values[k]);
  if(values['analysis-request-id'])input.analysis_request_id=values['analysis-request-id'];
  const analysis=createFieldRadarAnalysis({store,radar}),exporter=createFieldRadarExporter({library,radar,getAnalysis:request=>analysis.handle(request)});
  console.log(JSON.stringify(await (input.view==='literature-table'?exporter.tableExport(input):exporter.render(input)),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
