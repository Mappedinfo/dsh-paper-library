#!/usr/bin/env node
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createLocalStateStore} from '../src/local-state.mjs';
import {createRelationsStore,RELATIONS_MAX_BYTES} from '../src/harness/field-radar-relations.mjs';
try {
 const [source,library,expected,home]=process.argv.slice(2);
 if(!source||!library||expected==null)throw Error('Usage: node scripts/import-field-radar-relations.mjs INPUT.json LIBRARY EXPECTED_REVISION [STATE_HOME] (initial revision: 0)');
 const stat=await lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>RELATIONS_MAX_BYTES)throw Error('Expected a regular JSON file below 1 MiB');
 const h=await open(source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let document;try{const a=await h.stat();if(a.ino!==stat.ino||a.dev!==stat.dev||a.size!==stat.size)throw Error('Source changed');const bytes=Buffer.alloc(stat.size+1);let size=0;while(size<bytes.length){const r=await h.read(bytes,size,bytes.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}if(size!==stat.size)throw Error('Source changed during read');document=JSON.parse(bytes.subarray(0,size));}finally{await h.close();}
 const store=createRelationsStore(createLocalStateStore({library:resolve(library),...(home?{home:resolve(home)}:{})}));
 console.log(JSON.stringify(await store.importDocument({document,expected_revision:expected==='0'?0:expected}),null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
