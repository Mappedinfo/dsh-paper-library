import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createLocalStateStore, resolveLocalStateHome } from '../src/local-state.mjs';

const run = promisify(execFile), moduleURL = new URL('../src/local-state.mjs', import.meta.url).href;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'paper-local-state-')), library = join(root, 'library'), home = join(root, 'home');
  await mkdir(library);
  t.after(() => rm(root, { recursive:true, force:true }));
  const hash = createHash('sha256').update(await realpath(library)).digest('hex'), directory = join(home, 'paper-library', hash, 'state');
  return { root, library, home, directory, options:{library, home}, store:createLocalStateStore({library, home}), file:key => join(directory, `${key.replaceAll(':','~')}.json`) };
}
function errorCode(code) { return error => error.code === code; }

test('home selection matches DSH explicit, environment and tilde rules', () => {
  assert.equal(resolveLocalStateHome('/private/tmp/explicit', {DSH_HOME:'/private/tmp/environment'}), '/private/tmp/explicit');
  assert.equal(resolveLocalStateHome(undefined, {DSH_HOME:'~/paper-state-home'}), join(homedir(),'paper-state-home'));
  assert.equal(resolveLocalStateHome(undefined, {DSH_HOME:'   '}), join(homedir(),'.dsh'));
  assert.equal(resolveLocalStateHome('~\\paper-state-home', {}), join(homedir(),'paper-state-home'));
  assert.equal(resolveLocalStateHome('relative-home', {}), resolve('relative-home'));
  assert.throws(() => resolveLocalStateHome(''));
});

test('records survive new stores and process reload; every write uses an explicit CAS revision', async t => {
  const f = await fixture(t), missing = await f.store.get('reader:paper_a');
  assert.deepEqual(missing, {key:'reader:paper_a',value:null,revision:0,updated_at:null});
  const first = await f.store.put(missing.key, {page:4, draft:'Keep this note'}, 0);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  const second = await createLocalStateStore(f.options).put(first.key, first.value, first.revision);
  assert.notEqual(second.revision, first.revision, 'same value must not cause an ABA revision');
  assert.deepEqual(await f.store.get(first.key), second, 'an existing store must read fresh disk state');
  const child = await run(process.execPath, ['--input-type=module','-e', `import {createLocalStateStore} from ${JSON.stringify(moduleURL)}; const o=JSON.parse(process.argv[1]); console.log(JSON.stringify(await createLocalStateStore(o).get('reader:paper_a')));`, JSON.stringify(f.options)]);
  assert.deepEqual(JSON.parse(child.stdout), second);
  await assert.rejects(f.store.put(first.key, {page:1}, first.revision), error => error.code === 'STATE_CONFLICT' && error.status === 409 && error.current.revision === second.revision);
  await assert.rejects(f.store.put(first.key, {}, undefined), errorCode('STATE_INVALID'));
  await assert.rejects(f.store.put(first.key, {}, 1), errorCode('STATE_INVALID'));
});

test('independent processes cannot silently overwrite the same revision', async t => {
  const f = await fixture(t), first = await f.store.put('chat:paper_a', {draft:'original'}, 0);
  const code = `import {createLocalStateStore} from ${JSON.stringify(moduleURL)}; const [o,revision,name]=JSON.parse(process.argv[1]); try {const result=await createLocalStateStore(o).put('chat:paper_a',{draft:name},revision); console.log(JSON.stringify({ok:true,result}));} catch(error) { console.log(JSON.stringify({ok:false,code:error.code,current:error.current}));}`;
  const outcomes = await Promise.all(['left','right'].map(name => run(process.execPath, ['--input-type=module','-e',code,JSON.stringify([f.options,first.revision,name])]).then(result=>JSON.parse(result.stdout))));
  assert.equal(outcomes.filter(item=>item.ok).length, 1);
  assert.equal(outcomes.filter(item=>item.code==='STATE_CONFLICT').length, 1);
  assert.deepEqual(await f.store.get(first.key), outcomes.find(item=>item.ok).result);
  assert.deepEqual((await readdir(f.directory)).filter(name=>name.endsWith('.lock')||name.endsWith('.tmp')), []);
});

test('canonical library aliases share state and different libraries stay isolated', async t => {
  const f = await fixture(t), alias = join(f.root,'alias'), other = join(f.root,'other');
  await symlink(f.library, alias, 'dir'); await mkdir(other);
  const record = await f.store.put('preferences', {color:'yellow'}, 0);
  assert.deepEqual(await createLocalStateStore({home:f.home,library:alias}).get(record.key), record);
  assert.equal((await createLocalStateStore({home:f.home,library:other}).get(record.key)).revision, 0);
  assert.equal((await readdir(join(f.home,'paper-library'))).length, 2);
  assert.deepEqual(await readdir(f.library), [], 'state must not move into the PDF library');
});

test('on-disk state is private and safely paginated without reading unrelated corrupt records', async t => {
  const f = await fixture(t);
  for (const key of ['chat:c','chat:a','chat:b','vocabulary:private']) await f.store.put(key, {key}, 0);
  for (const directory of [join(f.home,'paper-library'),join(f.directory,'..'),f.directory]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.file('chat:a'))).mode & 0o777, 0o600);
  await writeFile(f.file('vocabulary:private'), 'broken');
  const first = await f.store.list({prefix:'chat:',limit:2});
  assert.deepEqual(first.records.map(record=>record.key), ['chat:a','chat:b']);
  assert.equal(first.total,3); assert.equal(first.next_offset,2); assert.equal(first.hasMore,true);
  const second = await f.store.list({prefix:'chat:',offset:first.next_offset,limit:2});
  assert.deepEqual(second.records.map(record=>record.key), ['chat:c']);
  assert.equal(second.hasMore,false); assert.equal(second.next_offset,null);
  for (const options of [{limit:51},{offset:10001},{offset:-1},{limit:0},{prefix:'../'}]) await assert.rejects(f.store.list(options), errorCode('STATE_INVALID'));
});

test('path and JSON limits fail before unsafe writes, while 200-character keys remain valid', async t => {
  const f = await fixture(t);
  for (const key of ['', '../reader','reader/a','reader\\a','reader:%2f','reader:','x'.repeat(201)]) await assert.rejects(f.store.put(key, {}, 0), errorCode('STATE_INVALID'));
  const longKey = 'r'+':a'.repeat(99)+'z'; assert.equal(longKey.length,200);
  assert.equal((await f.store.put(longKey, {ok:true}, 0)).value.ok, true);
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined,NaN,Infinity,new Date(),{bad:undefined},cyclic,Array(30001).fill(1)]) await assert.rejects(f.store.put('reader',value,0),errorCode('STATE_INVALID'));
  await assert.rejects(f.store.put('reader',{draft:'文'.repeat(100000)},0), errorCode('STATE_TOO_LARGE'));
  assert.equal((await f.store.get('reader')).revision,0);
  assert.deepEqual((await readdir(f.directory)).filter(name=>name.endsWith('.lock')||name.endsWith('.tmp')), []);
});

test('large list pages expose continuation under an aggregate memory budget', async t => {
  const f = await fixture(t), text = 'x'.repeat(230000);
  for (let index=0;index<40;index++) await f.store.put(`chat:p${String(index).padStart(2,'0')}`, {draft:text}, 0);
  const result = await f.store.list({prefix:'chat:',limit:50});
  assert.equal(result.total,40); assert.equal(result.truncated,true); assert.equal(result.hasMore,true);
  assert.ok(result.records.length>0&&result.records.length<40);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<8*1024*1024+1024);
  const rest = await f.store.list({prefix:'chat:',offset:result.next_offset,limit:50});
  assert.equal(result.records.length+rest.records.length,40); assert.equal(rest.hasMore,false);
});

test('corrupt, oversized and identity-swapped records are preserved and never overwritten', async t => {
  const f = await fixture(t), record = await f.store.put('reader', {page:1}, 0), path = f.file('reader'), original = await readFile(path,'utf8');
  for (const corrupt of ['{broken', original.replace('"page":1','"page":9')]) {
    await writeFile(path, corrupt);
    await assert.rejects(f.store.get('reader'),errorCode('STATE_CORRUPT'));
    await assert.rejects(f.store.put('reader',{},record.revision),errorCode('STATE_CORRUPT'));
    assert.equal(await readFile(path,'utf8'),corrupt);
  }
  await writeFile(path,original); await writeFile(f.file('preferences'),original);
  await assert.rejects(f.store.get('preferences'),errorCode('STATE_CORRUPT'));
  await truncate(path, 1024*1024*1024);
  await assert.rejects(f.store.get('reader'),errorCode('STATE_CORRUPT'));
  assert.equal((await lstat(path)).size,1024*1024*1024);
});

test('record, directory, lock symlinks and hardlinks cannot redirect state reads or writes', async t => {
  const f = await fixture(t), target = join(f.root,'outside');
  await f.store.get('reader'); await writeFile(target,'outside');
  await symlink(target,f.file('reader'));
  await assert.rejects(f.store.get('reader'),errorCode('STATE_UNSAFE_PATH'));
  await assert.rejects(f.store.put('reader',{},0),errorCode('STATE_UNSAFE_PATH'));
  await assert.rejects(f.store.list({prefix:'reader'}),errorCode('STATE_UNSAFE_PATH'));
  await rm(f.file('reader')); await link(target,f.file('reader'));
  await assert.rejects(f.store.get('reader'),errorCode('STATE_UNSAFE_PATH'));
  await rm(f.file('reader'));
  if (process.platform !== 'win32') {
    await run('mkfifo',[f.file('reader')]);
    await assert.rejects(f.store.get('reader'),errorCode('STATE_UNSAFE_PATH'));
    await rm(f.file('reader'));
  }
  await symlink(target,`${f.file('reader')}.lock`);
  await assert.rejects(f.store.put('reader',{},0),errorCode('STATE_UNSAFE_PATH'));
  await rm(`${f.file('reader')}.lock`);
  await rename(f.directory,`${f.directory}-original`); await symlink(`${f.directory}-original`,f.directory,'dir');
  await assert.rejects(f.store.get('reader'),errorCode('STATE_UNSAFE_PATH'));
  assert.equal(await readFile(target,'utf8'),'outside');
});

test('pre-existing locks are preserved and reported explicitly, with no guessed stale-lock recovery', async t => {
  const f = await fixture(t); await f.store.get('reader');
  const path = `${f.file('reader')}.lock`; await writeFile(path,'999999999\n',{mode:0o600});
  await assert.rejects(f.store.put('reader',{},0), error => error.code === 'STATE_LOCKED' && error.status === 503);
  assert.equal(await readFile(path,'utf8'),'999999999\n');
});
