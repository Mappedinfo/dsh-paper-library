#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createFieldRadarStore } from '../src/harness/field-radar.mjs';
import { importFieldRadarAnalysis } from '../src/harness/field-radar-analysis-import.mjs';
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--library' || args[2] !== '--input') throw Error('Usage: node scripts/import-field-radar-analysis.mjs --library PATH --input JSON');
  const file = resolve(args[3]), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024) throw Error('Input must be an independent JSON file at most 128 KiB');
  const input = JSON.parse(await readFile(file, 'utf8')), library = resolve(args[1]);
  const store = createLocalStateStore({ library }), radar = createFieldRadarStore({ store, library });
  const result = await importFieldRadarAnalysis({ store, radar }, input);
  console.log(JSON.stringify({ status: result.status, topic_id: result.topic_id, request_id: result.request_id, replayed: result.replayed, activated: result.activated, provenance: result.provenance }));
} catch (error) { console.error(JSON.stringify({ error: error.message, code: error.code })); process.exitCode = 1; }
