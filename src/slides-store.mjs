/** Managed PlainDeck projects. Source JSON stays in the selected library; no
 * browser cache, external directory scan, model request or background worker.
 * A project lock protects readers and CAS writers across instances. Individual
 * files are flushed and replaced atomically; ordinary write failures roll back
 * the files touched by that save. This is not a power-loss multi-file journal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assertDocument, canonicalJson, createDeckTemplate, createSavePlan, PresentationBriefSchema, PROJECT_PATHS, PLACEHOLDER_IMAGE_SRC } from '../lib/plaindeck-core.mjs';
import { syncDirectory } from './fs-portability.mjs';
import { assertSafeSlideStyles } from './slides-safety.mjs';

export const SLIDES_LIMITS = Object.freeze({ slides: 100, documentBytes: 8 * 1024 * 1024, assetBytes: 8 * 1024 * 1024, elements: 5000, projectsScanned: 1000 });
const ID = /^pd-[a-f0-9]{32}$/;
const REVISION = /^[a-f0-9]{64}$/;
const SLIDE = /^\.\/slides\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.json$/;
const ASSET = /^\.\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/;
const META = '.paper-library.json', BRIEF = '.presentation-brief.json', LOCK = '.paper-library.lock';
const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const hash = value => createHash('sha256').update(value).digest('hex');
export const slidesError = (message, code = 'SLIDES_INVALID', status = 400, current) => Object.assign(new Error(message), { code, status, ...(current === undefined ? {} : { current }) });
const unsafe = () => slidesError('演示项目路径不是独立的普通文件或目录，已保留原文件。', 'SLIDES_UNSAFE_PATH', 409);
function idValue(id) { if (typeof id !== 'string' || !ID.test(id)) throw slidesError('演示项目标识无效。'); return id; }
function revisionValue(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw slidesError('需要已读取的演示项目修订号。'); return value; }
function jsonText(value, maximum = SLIDES_LIMITS.documentBytes) {
  let text; try { text = JSON.stringify(value); } catch { throw slidesError('演示项目必须是普通 JSON。'); }
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum) throw slidesError(`内容超过 ${Math.round(maximum / 1024)} KiB 上限。`, 'SLIDES_TOO_LARGE', 413);
  return text;
}
function imageBytes(encoded, mime) {
  if (!Object.hasOwn(MIME, mime) || typeof encoded !== 'string' || encoded.length > Math.ceil(SLIDES_LIMITS.assetBytes / 3) * 4 || (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))) throw slidesError('图片需要不超过 8 MiB 的 PNG、JPEG、WebP 或 GIF。');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > SLIDES_LIMITS.assetBytes || bytes.toString('base64') !== encoded) throw slidesError('图片内容无效或超过 8 MiB。');
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw slidesError('图片类型与内容不匹配。');
  return bytes;
}
function documentValue(input) {
  jsonText(input);
  if (!input || !Array.isArray(input.deck?.slides) || input.deck.slides.length > SLIDES_LIMITS.slides || !input.slides || typeof input.slides !== 'object' || Object.keys(input.slides).length > SLIDES_LIMITS.slides) throw slidesError('演示项目最多 100 页。');
  let document; try { document = assertDocument(input); } catch { throw slidesError('PlainDeck 项目结构无效，请检查页面、主题及元素。'); }
  assertSafeSlideStyles(document);
  const { deck, slides } = document;
  if (deck.title.length > 200 || deck.theme !== PROJECT_PATHS.theme || deck.canvas.width > 7680 || deck.canvas.height > 4320) throw slidesError('项目标题最多 200 字，主题使用 ./theme.json，画布最大 7680 × 4320。');
  if (new Set(deck.slides.map(path => path.toLowerCase())).size !== deck.slides.length || deck.slides.some(path => !SLIDE.test(path)) || Object.keys(slides).some(path => !deck.slides.includes(path))) throw slidesError('页面路径必须是 ./slides/ 下不重复的 JSON 文件。');
  let elements = 0;
  for (const slide of Object.values(slides)) {
    elements += slide.elements.length;
    for (const element of slide.elements) if (element.type === 'image') {
      const src = element.src;
      if (src === 'placeholder:image' || src === PLACEHOLDER_IMAGE_SRC || ASSET.test(src)) continue;
      const data = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(src);
      if (!data) throw slidesError('图片只能使用项目内图片或嵌入的 PNG、JPEG、WebP、GIF；不加载远程地址或任意 SVG。');
      imageBytes(data[2], data[1]);
    }
  }
  if (elements > SLIDES_LIMITS.elements) throw slidesError('单个演示项目最多 5000 个元素。');
  jsonText(document);
  // Reads budget the actual source files. Count the same canonical output here
  // before any write, so indentation/defaults cannot make a saved deck unreadable.
  const sourceBytes = createSavePlan(document).writes.reduce((total, item) => total + Buffer.byteLength(item.content), 0);
  if (sourceBytes > SLIDES_LIMITS.documentBytes) throw slidesError('演示源文件序列化后超过 8 MiB 上限，原项目未修改。', 'SLIDES_TOO_LARGE', 413);
  return document;
}
async function safeInfo(path, optional = false, directory = false) {
  let info; try { info = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw unsafe();
  return info;
}
async function privateDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await safeInfo(path, false, true); await chmod(path, 0o700);
}
async function readSafe(path, maximum, optional = false) {
  const expected = await safeInfo(path, optional); if (!expected) return null;
  if (expected.size > maximum) throw slidesError('已保存的演示文件超出读取预算，已保留原文件。', 'SLIDES_TOO_LARGE', 413);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== expected.dev || info.ino !== expected.ino) throw unsafe();
    const bytes = Buffer.alloc(Math.min(maximum + 1, info.size + 1)); let size = 0;
    while (size < bytes.length) { const chunk = await handle.read(bytes, size, bytes.length - size, size); if (!chunk.bytesRead) break; size += chunk.bytesRead; }
    if (size !== info.size || size > maximum) throw slidesError('演示文件在读取时发生变化，请重试。', 'SLIDES_BUSY', 409);
    return bytes.subarray(0, size);
  } finally { await handle?.close(); }
}
async function readJSON(path, maximum, optional = false) {
  const bytes = await readSafe(path, maximum, optional); if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw slidesError('已保存的演示 JSON 损坏，已保留原文件。', 'SLIDES_CORRUPT', 409); }
}
async function writeAtomic(path, content) {
  await safeInfo(path, true);
  const temporary = join(dirname(path), `.paper-library-${randomUUID()}.tmp`); let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
    await safeInfo(path, true); await rename(temporary, path); await syncDirectory(dirname(path));
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}
async function withProjectLock(path, operation) {
  await safeInfo(path, false, true); const lockPath = join(path, LOCK), deadline = Date.now() + 2000; let handle;
  while (!handle) {
    await safeInfo(lockPath, true);
    try { handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw slidesError('演示项目正在读写，请稍后重试；现有锁文件未删除。', 'SLIDES_LOCKED', 503);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { await handle.writeFile(`${process.pid}\n`); await safeInfo(path, false, true); return await operation(); }
  finally { await handle.close(); await rm(lockPath); }
}
async function sourcePath(project, relative) {
  const path = relative.replace(/^\.\//, '');
  if (path.includes('/')) await safeInfo(join(project, path.split('/')[0]), false, true);
  return join(project, path);
}
async function readDocument(project) {
  let consumed = 0;
  const read = async relative => {
    const bytes = await readSafe(await sourcePath(project, relative), SLIDES_LIMITS.documentBytes - consumed); consumed += bytes.length;
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw slidesError('演示源文件 JSON 损坏，已保留原文件。', 'SLIDES_CORRUPT', 409); }
  };
  const deck = await read(PROJECT_PATHS.deck);
  if (!Array.isArray(deck?.slides) || deck.slides.length > SLIDES_LIMITS.slides || deck.theme !== PROJECT_PATHS.theme || deck.slides.some(path => typeof path !== 'string' || !SLIDE.test(path))) throw slidesError('已保存项目的页面或主题路径无效。', 'SLIDES_CORRUPT', 409);
  const theme = await read(deck.theme), slides = {};
  for (const path of deck.slides) slides[path] = await read(path);
  const document = documentValue({ deck, theme, slides });
  return { document, revision: hash(canonicalJson(document)) };
}
async function metadata(project) {
  const value = await readJSON(join(project, META), 4096);
  if (!value || !ID.test(value.id) || typeof value.title !== 'string' || value.title.length > 200 || !Number.isSafeInteger(value.slide_count) || typeof value.updated_at !== 'string' || value.id !== basename(project)) throw slidesError('演示项目登记资料损坏，已保留原文件。', 'SLIDES_CORRUPT', 409);
  return value;
}
async function writeDocument(project, document, previous, meta) {
  const plan = createSavePlan(document);
  const writes = plan.writes.map(item => [item.path, item.content]);
  writes.push([META, canonicalJson(meta)]);
  const deletions = previous ? previous.deck.slides.filter(path => !document.deck.slides.includes(path)) : [];
  const backups = new Map(), known = new Set(previous ? [PROJECT_PATHS.deck, previous.deck.theme, ...previous.deck.slides, META] : []);
  for (const [relative] of writes) {
    const bytes = await readSafe(await sourcePath(project, relative), SLIDES_LIMITS.documentBytes, true);
    if (bytes && !known.has(relative)) throw slidesError('新页面路径已有未登记文件，已保留原文件；请更换页面文件名。', 'STATE_CONFLICT', 409);
    backups.set(relative, bytes);
  }
  for (const relative of deletions) backups.set(relative, await readSafe(await sourcePath(project, relative), SLIDES_LIMITS.documentBytes, true));
  try {
    for (const [relative, content] of writes) await writeAtomic(await sourcePath(project, relative), content);
    for (const relative of deletions) { const path = await sourcePath(project, relative); await safeInfo(path, true); await rm(path, { force: true }); }
  } catch (error) {
    const recoveryErrors = [];
    for (const [relative, bytes] of backups) try {
      const path = await sourcePath(project, relative);
      if (bytes === null) { await safeInfo(path, true); await rm(path, { force: true }); } else await writeAtomic(path, bytes);
    } catch (recoveryError) { recoveryErrors.push(recoveryError.message); }
    if (recoveryErrors.length) throw slidesError('保存中断且部分文件无法恢复；请保留当前草稿并检查项目目录。', 'SLIDES_RECOVERY_REQUIRED', 500);
    throw error;
  }
}

export function createSlidesStore({ library } = {}) {
  if (typeof library !== 'string' || !library.trim()) throw slidesError('需要本地资料库路径。');
  let rootPromise;
  async function root() {
    rootPromise ??= (async () => { const selected = resolve(library); await mkdir(selected, { recursive: true, mode: 0o700 }); const canonical = await realpath(selected); const path = join(canonical, 'slides'); await privateDirectory(path); return path; })();
    const path = await rootPromise; await safeInfo(path, false, true); return path;
  }
  async function projectPath(id) {
    const path = join(await root(), idValue(id));
    try { await safeInfo(path, false, true); } catch (error) { if (error.code === 'ENOENT') throw slidesError('演示项目不存在。', 'SLIDES_NOT_FOUND', 404); throw error; }
    return path;
  }
  async function scanProjects() {
    const directory = await opendir(await root()), projects = []; let scanned = 0, truncated = false;
    for await (const entry of directory) {
      if (!ID.test(entry.name)) continue;
      if (++scanned > SLIDES_LIMITS.projectsScanned) { truncated = true; break; }
      const path = await projectPath(entry.name);
      const value = await withProjectLock(path, () => metadata(path));
      if (value.id !== entry.name) throw slidesError('演示项目标识与目录不符。', 'SLIDES_CORRUPT', 409);
      projects.push(value);
    }
    return { projects, truncated };
  }
  async function handle(input) {
    switch (input?.action) {
      case 'slides_catalog': {
        const result = await scanProjects();
        if (result.truncated) throw slidesError('演示项目超过 1000 项扫描上限，无法提供完整排序。', 'SLIDES_CATALOG_LIMIT', 413);
        return result;
      }
      case 'slides_list': {
        const offset = input.offset ?? 0, limit = input.limit ?? 30;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > SLIDES_LIMITS.projectsScanned || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw slidesError('项目分页要求 offset 0–1000、limit 1–50。');
        const { projects, truncated } = await scanProjects();
        projects.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
        const end = offset + limit;
        return { projects: projects.slice(offset, end), next_offset: end < projects.length ? end : null, truncated };
      }
      case 'slides_create': {
        if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)) throw slidesError('演示标题需要 1–200 个字符。');
        let document;
        try { document = input.document === undefined ? createDeckTemplate(input.template ?? 'paper-reading', { title: input.title, lang: 'zh' }) : input.document; }
        catch { throw slidesError('演示模板不存在。'); }
        if (input.title && input.document) document = { ...document, deck: { ...document.deck, title: input.title.trim() } };
        document = documentValue(document);
        const id = `pd-${randomUUID().replaceAll('-', '')}`, path = join(await root(), id), now = new Date().toISOString();
        await mkdir(path, { mode: 0o700 }); await privateDirectory(join(path, 'slides')); await privateDirectory(join(path, 'assets'));
        const project = { id, title: document.deck.title, slide_count: document.deck.slides.length, created_at: now, updated_at: now };
        try { await withProjectLock(path, () => writeDocument(path, document, null, project)); }
        catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
        return { project, document, revision: hash(canonicalJson(document)) };
      }
      case 'slides_get': {
        const path = await projectPath(input.id);
        return withProjectLock(path, async () => ({ project: await metadata(path), ...await readDocument(path) }));
      }
      case 'slides_save': {
        const document = documentValue(input.document), expected = revisionValue(input.expected_revision), path = await projectPath(input.id);
        return withProjectLock(path, async () => {
          const current = await readDocument(path), previousMeta = await metadata(path);
          if (expected !== current.revision) throw slidesError('演示已在另一窗口或编辑器更新；当前草稿保留，请重新打开或导出副本。', 'STATE_CONFLICT', 409, { revision: current.revision, project: previousMeta });
          const project = { ...previousMeta, title: document.deck.title, slide_count: document.deck.slides.length, updated_at: new Date().toISOString() };
          await writeDocument(path, document, current.document, project);
          return { project, revision: hash(canonicalJson(document)) };
        });
      }
      case 'slides_asset_put': {
        const bytes = imageBytes(input.content_base64, input.mime), relative = `${PROJECT_PATHS.assetsDir}${hash(bytes)}.${MIME[input.mime]}`, path = await projectPath(input.id);
        return withProjectLock(path, async () => {
          await metadata(path); const destination = await sourcePath(path, relative), existing = await readSafe(destination, SLIDES_LIMITS.assetBytes, true);
          if (existing && !existing.equals(bytes)) throw slidesError('已有图片与内容标识不符，原文件已保留。', 'SLIDES_CORRUPT', 409);
          if (!existing) await writeAtomic(destination, bytes);
          return { path: relative };
        });
      }
      case 'slides_asset_get': {
        if (typeof input.path !== 'string' || !ASSET.test(input.path)) throw slidesError('图片路径必须是当前项目内上传的图片。');
        const path = await projectPath(input.id);
        return withProjectLock(path, async () => { await metadata(path); const bytes = await readSafe(await sourcePath(path, input.path), SLIDES_LIMITS.assetBytes); const extension = input.path.split('.').at(-1), mime = Object.keys(MIME).find(key => MIME[key] === extension); imageBytes(bytes.toString('base64'), mime); return { mime, content_base64: bytes.toString('base64') }; });
      }
      case 'slides_brief_get': {
        const path = await projectPath(input.id);
        return withProjectLock(path, async () => { await metadata(path); const saved = await readJSON(join(path, BRIEF), 16 * 1024, true); if (!saved) return { value: PresentationBriefSchema.parse({}), revision: '0' }; const value = PresentationBriefSchema.parse(saved); return { value, revision: hash(canonicalJson(value)) }; });
      }
      case 'slides_brief_save': {
        jsonText(input.value, 16 * 1024); let value; try { value = PresentationBriefSchema.parse(input.value); } catch { throw slidesError('制作简报格式无效。'); }
        if (input.expected_revision !== '0') revisionValue(input.expected_revision);
        const path = await projectPath(input.id);
        return withProjectLock(path, async () => {
          await metadata(path); const saved = await readJSON(join(path, BRIEF), 16 * 1024, true), current = saved ? hash(canonicalJson(PresentationBriefSchema.parse(saved))) : '0';
          if (current !== input.expected_revision) throw slidesError('制作简报已在另一窗口更新，当前草稿保留。', 'STATE_CONFLICT', 409, { revision: current });
          await writeAtomic(join(path, BRIEF), canonicalJson(value)); return { value, revision: hash(canonicalJson(value)) };
        });
      }
      default: throw slidesError('未知的演示项目操作。');
    }
  }
  return { handle };
}
