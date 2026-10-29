import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSlidesStore, SLIDES_LIMITS } from '../src/slides-store.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=';
const code = value => error => error.code === value;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'paper-slides-store-')); t.after(() => rm(root, { recursive: true, force: true }));
  const library = join(root, 'library'), store = createSlidesStore({ library });
  const request = (action, input = {}) => store.handle({ action, ...input });
  const created = await request('slides_create', { title: '合成演示', template: 'blank' });
  return { root, library, store, request, created, directory: join(library, 'slides', created.project.id) };
}

test('managed projects persist as PlainDeck source files and reopen across instances', async t => {
  const f = await fixture(t), current = f.created;
  assert.match(current.project.id, /^pd-[a-f0-9]{32}$/); assert.equal(current.project.slide_count, 1);
  const paths = current.document.deck.slides;
  assert.equal(JSON.parse(await readFile(join(f.directory, 'deck.json'), 'utf8')).title, '合成演示');
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, paths[0]), 'utf8')), current.document.slides[paths[0]]);
  const second = createSlidesStore({ library: f.library }), opened = await second.handle({ action: 'slides_get', id: current.project.id });
  assert.deepEqual(opened.document, current.document); assert.equal(opened.revision, current.revision);
  const listed = await f.request('slides_list', { limit: 1 }); assert.equal(listed.projects[0].id, current.project.id); assert.equal(listed.next_offset, null);
});

test('simultaneous CAS saves across store instances accept exactly one writer', async t => {
  const f = await fixture(t), other = createSlidesStore({ library: f.library }), { project, revision, document } = f.created;
  const a = structuredClone(document), b = structuredClone(document); a.deck.title = 'First synthetic edit'; b.deck.title = 'Second synthetic edit';
  const results = await Promise.allSettled([f.request('slides_save', { id: project.id, document: a, expected_revision: revision }), other.handle({ action: 'slides_save', id: project.id, document: b, expected_revision: revision })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = results.find(value => value.status === 'rejected').reason; assert.equal(rejected.code, 'STATE_CONFLICT'); assert.equal(rejected.status, 409); assert.match(rejected.current.revision, /^[a-f0-9]{64}$/);
  const saved = await f.request('slides_get', { id: project.id }); assert.equal(saved.document.deck.title, results[0].status === 'fulfilled' ? a.deck.title : b.deck.title);
});

test('external source edits reject stale saves and unrelated files survive page removal', async t => {
  const f = await fixture(t), { project, document, revision } = f.created;
  await writeFile(join(f.directory, 'notes.txt'), 'unrelated synthetic notes');
  const deck = { ...document.deck, title: 'Changed by another editor' }; await writeFile(join(f.directory, 'deck.json'), JSON.stringify(deck));
  await assert.rejects(f.request('slides_save', { id: project.id, document, expected_revision: revision }), code('STATE_CONFLICT'));
  assert.equal(JSON.parse(await readFile(join(f.directory, 'deck.json'), 'utf8')).title, deck.title);
  const opened = await f.request('slides_get', { id: project.id });
  const updated = structuredClone(opened.document), original = updated.deck.slides[0], second = './slides/002-second.json';
  updated.deck.slides.push(second); updated.slides[second] = { ...updated.slides[original], id: 'second' };
  const saved = await f.request('slides_save', { id: project.id, document: updated, expected_revision: opened.revision });
  updated.deck.slides = [second]; delete updated.slides[original];
  await f.request('slides_save', { id: project.id, document: updated, expected_revision: saved.revision });
  assert.equal(await readFile(join(f.directory, 'notes.txt'), 'utf8'), 'unrelated synthetic notes');
  assert.equal((await readdir(join(f.directory, 'slides'))).includes(original.split('/').at(-1)), false);
});

test('a new slide cannot overwrite an existing unregistered source file', async t => {
  const f = await fixture(t), { project, document, revision } = f.created, next = structuredClone(document), path = './slides/002-new.json';
  await writeFile(join(f.directory, path), 'unrelated source');
  next.deck.slides.push(path); next.slides[path] = { ...next.slides[next.deck.slides[0]], id: 'new-slide' };
  await assert.rejects(f.request('slides_save', { id: project.id, document: next, expected_revision: revision }), code('STATE_CONFLICT'));
  assert.equal(await readFile(join(f.directory, path), 'utf8'), 'unrelated source');
  assert.equal((await f.request('slides_get', { id: project.id })).revision, revision);
});

test('invalid paths, remote content, duplicate pages and oversized projects are rejected before writes', async t => {
  const f = await fixture(t), { project, document, revision } = f.created;
  for (const id of ['../escape', '/tmp/private', 'pd-nope']) await assert.rejects(f.request('slides_get', { id }), code('SLIDES_INVALID'));
  for (const path of ['../outside.json', './slides/../deck.json', './slides/a\\b.json']) {
    const next = structuredClone(document), slide = next.slides[next.deck.slides[0]]; next.deck.slides = [path]; next.slides = { [path]: slide };
    await assert.rejects(f.request('slides_save', { id: project.id, document: next, expected_revision: revision }), code('SLIDES_INVALID'));
  }
  for (const src of ['https://example.invalid/private.png', 'file:///etc/passwd', 'data:image/svg+xml,<svg onload="alert(1)"/>']) {
    const next = structuredClone(document); next.slides[next.deck.slides[0]].elements.push({ id: 'bad-image', type: 'image', src, frame: { x: 1, y: 1, w: 10, h: 10 } });
    await assert.rejects(f.request('slides_save', { id: project.id, document: next, expected_revision: revision }), code('SLIDES_INVALID'));
  }
  const large = structuredClone(document); large.deck.title = 'x'.repeat(SLIDES_LIMITS.documentBytes);
  await assert.rejects(f.request('slides_create', { document: large }), code('SLIDES_TOO_LARGE'));
  const many = structuredClone(document); many.deck.slides = Array(101).fill(many.deck.slides[0]);
  await assert.rejects(f.request('slides_create', { document: many }), code('SLIDES_INVALID'));
  assert.equal((await f.request('slides_get', { id: project.id })).revision, revision);
});

test('directory and file symlinks cannot redirect project or asset reads and writes', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'deck.json'), 'private sentinel');
  const foreign = `pd-${'a'.repeat(32)}`; await symlink(outside, join(f.library, 'slides', foreign), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.request('slides_get', { id: foreign }), code('SLIDES_UNSAFE_PATH'));
  const original = join(f.directory, 'deck.json'); await rm(original); await symlink(join(outside, 'deck.json'), original);
  await assert.rejects(f.request('slides_get', { id: f.created.project.id }), code('SLIDES_UNSAFE_PATH'));
  assert.equal(await readFile(join(outside, 'deck.json'), 'utf8'), 'private sentinel');
});

test('asset upload uses content-addressed project paths and rejects MIME and traversal mismatches', async t => {
  const f = await fixture(t), id = f.created.project.id;
  const image = await f.request('slides_asset_put', { id, name: '../../private.png', mime: 'image/png', content_base64: png });
  assert.match(image.path, /^\.\/assets\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(await f.request('slides_asset_get', { id, path: image.path }), { mime: 'image/png', content_base64: png });
  assert.deepEqual(await f.request('slides_asset_put', { id, mime: 'image/png', content_base64: png }), image);
  await assert.rejects(f.request('slides_asset_put', { id, mime: 'image/jpeg', content_base64: png }), code('SLIDES_INVALID'));
  await assert.rejects(f.request('slides_asset_put', { id, mime: 'image/svg+xml', content_base64: Buffer.from('<svg/>').toString('base64') }), code('SLIDES_INVALID'));
  await assert.rejects(f.request('slides_asset_get', { id, path: '../other.png' }), code('SLIDES_INVALID'));
  const outside = join(f.root, 'asset-sentinel'); await writeFile(outside, 'original sentinel'); await rm(join(f.directory, image.path)); await symlink(outside, join(f.directory, image.path));
  await assert.rejects(f.request('slides_asset_get', { id, path: image.path }), code('SLIDES_UNSAFE_PATH'));
  assert.equal(await readFile(outside, 'utf8'), 'original sentinel');
});

test('presentation briefs persist independently and reject stale edits', async t => {
  const f = await fixture(t), id = f.created.project.id, initial = await f.request('slides_brief_get', { id });
  assert.equal(initial.revision, '0'); assert.equal(initial.value.minutes, 10);
  const saved = await f.request('slides_brief_save', { id, value: { ...initial.value, purpose: 'Explain a synthetic result' }, expected_revision: initial.revision });
  const other = createSlidesStore({ library: f.library });
  assert.deepEqual(await other.handle({ action: 'slides_brief_get', id }), saved);
  await assert.rejects(f.request('slides_brief_save', { id, value: initial.value, expected_revision: initial.revision }), code('STATE_CONFLICT'));
  await assert.rejects(f.request('slides_brief_save', { id, value: { minutes: 0 }, expected_revision: saved.revision }), code('SLIDES_INVALID'));
  assert.equal((await f.request('slides_get', { id })).revision, f.created.revision);
});

test('project reads wait for an in-flight writer instead of observing partial source', async t => {
  const f = await fixture(t), lock = join(f.directory, '.paper-library.lock'), id = f.created.project.id;
  await writeFile(lock, 'synthetic writer\n');
  let finished = false;
  const reading = f.request('slides_get', { id }).finally(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(finished, false);
  await rm(lock);
  const loaded = await reading; assert.equal(loaded.revision, f.created.revision);
});

test('source byte budget counts canonical files before writes and accepted large decks reopen', async t => {
  const f = await fixture(t), { project, document, revision } = f.created, next = structuredClone(document);
  const slide = next.slides[next.deck.slides[0]];
  slide.elements = Array.from({ length: 5000 }, (_, index) => ({ id: `item-${index}`, type: 'text', text: 'x'.repeat(1550), frame: { x: 0, y: 0, w: 10, h: 10 } }));
  assert.ok(Buffer.byteLength(JSON.stringify(next)) < SLIDES_LIMITS.documentBytes, 'compact input alone is below the limit');
  await assert.rejects(f.request('slides_save', { id: project.id, document: next, expected_revision: revision }), code('SLIDES_TOO_LARGE'));
  await assert.rejects(f.request('slides_create', { document: next }), code('SLIDES_TOO_LARGE'));
  assert.equal((await f.request('slides_get', { id: project.id })).revision, revision);
  assert.equal((await f.request('slides_list')).projects.length, 1);
  for (const element of slide.elements) element.text = 'x'.repeat(1450);
  const saved = await f.request('slides_save', { id: project.id, document: next, expected_revision: revision });
  const reopened = await f.request('slides_get', { id: project.id });
  assert.equal(reopened.revision, saved.revision); assert.equal(reopened.document.slides[next.deck.slides[0]].elements.length, 5000);
});
