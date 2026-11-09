#!/usr/bin/env node
// Explicit local metadata import. Never reads PDFs or contacts external services.
import { readFile, mkdir, lstat, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const MAX_BYTES = 6 * 1024 * 1024;
export function extractSnapshot(html) {
  const match = html.match(/<script\b(?=[^>]*\bid=["']radar-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!match) throw new Error('HTML does not contain radar-data application/json');
  if (Buffer.byteLength(match[1]) > MAX_BYTES) throw new Error('Snapshot exceeds 6 MiB');
  const data = JSON.parse(match[1]);
  if (!Array.isArray(data.people) || !Array.isArray(data.works) || !data.method || !data.audit || !data.health || !Array.isArray(data.manifest)) throw new Error('Incomplete radar snapshot');
  if (data.people.length > 2000 || data.works.length > 50000) throw new Error('Snapshot record limit exceeded');
  for (const person of data.people) {
    if (!Array.isArray(person.works) || person.works.some(i => !Number.isInteger(i) || i < 0 || i >= data.works.length)) throw new Error('Invalid person-work reference');
  }
  return data;
}
async function forbidSymlink(file) {
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlink: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function importSnapshot(source, library) {
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.size > MAX_BYTES * 2) throw new Error('Expected an HTML file below 12 MiB');
  const data = extractSnapshot(await readFile(source, 'utf8'));
  const base = await realpath(library);
  const directory = path.join(base, '.paper-library');
  await forbidSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'field-radar-snapshot.json');
  await forbidSymlink(target);
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Snapshot exceeds 6 MiB');
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, json, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return { target, people: data.people.length, works: data.works.length, snapshot: data.snapshot };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, library] = process.argv.slice(2);
  if (!source || !library) { console.error('Usage: node scripts/import-field-radar-snapshot.mjs <existing-field-radar.html> <library-directory>'); process.exitCode=1; }
  else { try { console.log(JSON.stringify(await importSnapshot(source, library), null, 2)); } catch(e) { console.error(e.message); process.exitCode=1; } }
}
