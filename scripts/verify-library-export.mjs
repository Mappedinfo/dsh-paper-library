import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { dispatch, core } from '../src/bridge.mjs';
import { parseBibtex } from '../src/citations.mjs';

const library=resolve(process.argv[2] || 'artifacts/capacity-2000-1000/library');
const reportPath=resolve(process.argv[3] || 'docs/validation/export-2000.json');
const start=performance.now();
const source=await core({action:'export_metadata'},{library});
const result=await dispatch({action:'export_library',format:'biblatex'},{library});
const parsed=await parseBibtex(result.text);
const expected=new Set(source.items.map(item=>item.citekey));
const actual=new Set(parsed.map(item=>item.citekey));
const missing=[...expected].filter(key=>!actual.has(key));
const report={verified_at:new Date().toISOString(),source_count:source.total,exported_count:result.count,parsed_count:parsed.length,unique_keys:actual.size,missing_keys:missing,
  elapsed_ms:Math.round(performance.now()-start),status:source.total===parsed.length&&actual.size===expected.size&&missing.length===0?'pass':'fail',source:'Synthetic capacity fixture'};
await mkdir(dirname(reportPath),{recursive:true});
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(report.status!=='pass')process.exitCode=1;
