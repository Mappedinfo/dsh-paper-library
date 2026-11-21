// Knowledge-base contents stay in IndexedDB or the directory explicitly selected by the reader.
export const MAX_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_TEX_BYTES = 1024 * 1024;
export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_LIBRARY_FILES = 5000;
const BACKUPS = '.paper-library-backups';
const DB_NAME = 'mappedinfo.dsh-paper-library.web.v1';
const LOCK_NAME = DB_NAME + ':storage';
const SOURCE_EXT = /\.(tex|bib|sty|cls|bst|def|cfg|clo|tikz)$/i;
const changing = () => new Error('文件已被修改，请重新打开后再保存。');
const wrongLibrary = () => new Error('资料库位置已在其他标签页切换，请刷新后继续。');
const permissionError = () => new Error('需要重新授权当前文件夹。请点击「重新授权」或切换回浏览器资料库。');

export function kindForPath(path) {
  if (typeof path !== 'string' || path.length > 1024) return null;
  const parts = path.split('/');
  if (parts.length > 33 || parts.includes('node_modules') || parts.some(part =>
    !part || part.startsWith('.') || /[\\:\u0000-\u001f]/.test(part))) return null;
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (SOURCE_EXT.test(path)) return 'tex';
  return /\.(png|jpe?g)$/i.test(path) ? 'asset' : null;
}

function checkSize(file, kind) {
  const limit = { tex: MAX_TEX_BYTES, asset: MAX_ASSET_BYTES, pdf: MAX_PDF_BYTES, backup: MAX_PDF_BYTES }[kind];
  if (file.size > limit) throw new Error('文件超过 ' + (limit / 1024 / 1024) + ' MiB 上限。');
}

async function digest(blob) {
  const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const files = request.result.createObjectStore('files', { keyPath: 'path' });
      files.createIndex('catalog', ['kind', 'path', 'size', 'revision']);
      request.result.createObjectStore('settings');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

// All callbacks in a transaction issue IDB requests synchronously, including dependent reads/writes.
function transaction(db, stores, mode, setup) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result, failure;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('浏览器保存未完成。'));
    const finish = value => { result = value; };
    const abort = error => { failure = error; tx.abort(); };
    try { setup(tx, finish, abort); } catch (error) { abort(error); }
  });
}

function getRecord(db, table, key) {
  return transaction(db, [table], 'readonly', (tx, finish) => {
    const req = tx.objectStore(table).get(key);
    req.onsuccess = () => finish(req.result);
  });
}

function catalog(db, includeBackups) {
  return transaction(db, ['files'], 'readonly', (tx, finish, abort) => {
    const index = tx.objectStore('files').index('catalog');
    const rows = [];
    const req = index.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return finish(rows);
      const [kind, path, size, revision] = cursor.key;
      // The catalog key orders asset, backup, pdf, tex. Skip all hidden backups in one cursor step.
      if (!includeBackups && kind === 'backup') return cursor.continue(['pdf']);
      if (rows.length >= (includeBackups ? MAX_LIBRARY_FILES * 10 : MAX_LIBRARY_FILES)) return abort(new Error('文件数量超过单次列出上限。'));
      rows.push({ path, kind, size, revision });
      cursor.continue();
    };
  });
}

let fallbackLock = Promise.resolve();
function locked(action) {
  if (globalThis.navigator?.locks) return navigator.locks.request(LOCK_NAME, action);
  const result = fallbackLock.then(action);
  fallbackLock = result.catch(() => {});
  return result;
}

function folderStamp(file) {
  // Listing avoids loading PDF contents. Only read() produces a content revision accepted by write().
  return 'stat:' + file.lastModified + ':' + file.size;
}

async function* walk(directory, includeBackups = false, prefix = '', budget = { visited: 0, files: 0 }) {
  for await (const [name, handle] of directory.entries()) {
    if (++budget.visited > 50000) throw new Error('目录过大，请选择较小的资料文件夹。');
    const path = prefix + name;
    const backup = path === BACKUPS || path.startsWith(BACKUPS + '/');
    if (name.startsWith('.') && !(includeBackups && backup && name === BACKUPS && !prefix)) continue;
    if (handle.kind === 'directory') {
      if (name === 'node_modules') continue;
      if (path.split('/').length > (backup ? 34 : 32)) throw new Error('目录层级过深，请选择较小的资料文件夹。');
      yield* walk(handle, includeBackups, path + '/', budget);
    } else {
      const original = backup ? prefix.slice(BACKUPS.length + 1, -1) : '';
      const kind = backup && /^[0-9a-f]{64}\.pdf$/.test(name) && kindForPath(original) === 'pdf'
        ? 'backup' : kindForPath(path);
      if (!kind) continue;
      if (++budget.files > (includeBackups ? MAX_LIBRARY_FILES * 10 : MAX_LIBRARY_FILES)) throw new Error('文件数量超过单次列出上限。');
      const file = await handle.getFile();
      yield { path, kind, size: file.size, revision: folderStamp(file) };
    }
  }
}

async function locate(root, path, createDirectories) {
  const parts = path.split('/');
  const name = parts.pop();
  let parent = root;
  for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: createDirectories });
  return { parent, name };
}

async function lookup(root, path) {
  try {
    const { parent, name } = await locate(root, path, false);
    return await parent.getFileHandle(name);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function fileRevision(file, kind) {
  checkSize(file, kind);
  return digest(file);
}

// The system commits a writable stream's temporary contents on close. Recheck versions before commit.
async function writeDisk(root, path, blob, expected, kind) {
  const { parent, name } = await locate(root, path, true);
  const existing = await lookup(parent, name);
  if (Boolean(existing) !== (expected !== null)) throw changing();
  const handle = existing || await parent.getFileHandle(name, { create: true });
  let stream, committed = false;
  const verify = async () => {
    const file = await handle.getFile();
    if (expected === null ? file.size !== 0 : await fileRevision(file, kind) !== expected) throw changing();
  };
  try {
    stream = await handle.createWritable({ mode: 'exclusive' });
    await verify();
    await stream.write(blob);
    await verify();
    await stream.close();
    committed = true;
  } finally {
    if (!committed) {
      if (stream) await stream.abort().catch(() => {});
      if (!existing) {
        try {
          const found = await parent.getFileHandle(name);
          if (await found.isSameEntry(handle) && (await found.getFile()).size === 0) await parent.removeEntry(name);
        } catch { /* The user may have revoked access or moved the entry. */ }
      }
    }
  }
}

function backupPath(path, revision) {
  return BACKUPS + '/' + path + '/' + revision + '.pdf';
}

async function identicalOrMissing(root, path, revision, kind) {
  const target = await lookup(root, path);
  if (!target) return false;
  if (await fileRevision(await target.getFile(), kind) !== revision) throw new Error('已有不同内容的同名文件：' + path);
  return true;
}

async function copyVerified(root, path, blob, revision, kind) {
  if (await identicalOrMissing(root, path, revision, kind)) return;
  await writeDisk(root, path, blob, null, kind);
  if (!await identicalOrMissing(root, path, revision, kind)) throw new Error('迁移后没有找到文件：' + path);
}

export async function openBrowserLibrary({ indexedDB: factory = globalThis.indexedDB } = {}) {
  if (!factory) throw new Error('浏览器未开放 IndexedDB。请在允许网站存储的窗口中打开。');
  const db = await openDatabase(factory);
  let active = (await getRecord(db, 'settings', 'active')) || { id: null, handle: null };
  let needsPermission = false;

  async function permission(handle) {
    try { return await handle.queryPermission({ mode: 'readwrite' }) === 'granted'; }
    catch { return false; }
  }
  if (active.handle) needsPermission = !await permission(active.handle);

  async function checkActive() {
    const saved = await getRecord(db, 'settings', 'active');
    if ((saved?.id || null) !== active.id) throw wrongLibrary();
    if (active.handle) {
      needsPermission = !await permission(active.handle);
      if (needsPermission) throw permissionError();
    }
  }

  async function select(handle) {
    if (handle && (handle.kind !== 'directory' || !await permission(handle))) throw permissionError();
    const next = { id: crypto.randomUUID(), handle };
    await transaction(db, ['settings'], 'readwrite', (tx) => tx.objectStore('settings').put(next, 'active'));
    active = next;
    needsPermission = false;
  }

  async function rows(includeBackups) {
    if (!active.handle) return catalog(db, includeBackups);
    const files = [];
    for await (const item of walk(active.handle, includeBackups)) files.push(item);
    return files;
  }

  async function read(path, kind) {
    if (!active.handle) {
      const record = await getRecord(db, 'files', path);
      if (!record) throw new Error('文件不存在：' + path);
      return { blob: record.blob, revision: record.revision };
    }
    const handle = await lookup(active.handle, path);
    if (!handle) throw new Error('文件不存在：' + path);
    const file = await handle.getFile();
    return { blob: file, revision: await fileRevision(file, kind) };
  }

  function putBrowser(path, blob, expected, revision, kind) {
    return transaction(db, ['files', 'settings'], 'readwrite', (tx, finish, abort) => {
      const binding = tx.objectStore('settings').get('active');
      binding.onsuccess = () => {
        if ((binding.result?.id || null) !== active.id) return abort(wrongLibrary());
        const files = tx.objectStore('files');
        const request = files.get(path);
        request.onsuccess = () => {
          const previous = request.result;
          if ((previous?.revision ?? null) !== expected) return abort(changing());
          if (previous && kind === 'pdf' && revision !== expected) {
            files.put({ ...previous, kind: 'backup', path: backupPath(path, expected) });
          }
          const put = () => {
            files.put({ path, blob, kind, size: blob.size, revision });
            finish({ revision });
          };
          if (previous) return put();
          // Browser paths must also be representable in an ordinary filesystem after migration.
          const parts = path.split('/');
          const pathError = () => abort(new Error('文件名与库内的目录路径冲突。'));
          const firstDescendant = files.getKey(IDBKeyRange.lowerBound(path + '/'));
          firstDescendant.onsuccess = () => { if (firstDescendant.result?.startsWith(path + '/')) pathError(); };
          for (let i = 1; i < parts.length; i++) {
            const parentFile = files.getKey(parts.slice(0, i).join('/'));
            parentFile.onsuccess = () => { if (parentFile.result !== undefined) pathError(); };
          }
          const index = files.index('catalog');
          const assetCount = index.count(IDBKeyRange.upperBound(['backup'], true));
          const documentCount = index.count(IDBKeyRange.lowerBound(['pdf']));
          documentCount.onsuccess = () => {
            if (assetCount.result + documentCount.result >= MAX_LIBRARY_FILES) return abort(new Error('浏览器资料库已达到文件数量上限。'));
            put();
          };
        };
      };
    });
  }

  const store = {
    get mode() { return active.handle ? 'folder' : 'browser'; },
    get name() { return active.handle?.name || '浏览器资料库'; },
    get needsPermission() { return needsPermission; },
    async reconnect() {
      if (!active.handle) return;
      needsPermission = await active.handle.requestPermission({ mode: 'readwrite' }) !== 'granted';
      if (needsPermission) throw permissionError();
    },
    openFolder(handle) {
      return locked(() => {
        if (handle?.kind !== 'directory') throw new Error('请先选择一个文件夹。');
        return select(handle);
      });
    },
    useBrowser() { return locked(() => select(null)); },
    async list() {
      await checkActive();
      return (await rows(false)).sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      const kind = kindForPath(path);
      if (!kind) throw new Error('不支持此文件路径。');
      await checkActive();
      return read(path, kind);
    },
    write(path, blob, expected) {
      return locked(async () => {
        const kind = kindForPath(path);
        if (!kind || !(blob instanceof Blob)) throw new Error('不支持的文件或路径。');
        if (!(expected === null || typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected))) throw new Error('请先读取文件再保存。');
        checkSize(blob, kind);
        await checkActive();
        const revision = await digest(blob);
        if (!active.handle) return putBrowser(path, blob, expected, revision, kind);
        if (expected !== null) {
          const previous = await read(path, kind);
          if (previous.revision !== expected) throw changing();
          if (revision === expected) return { revision };
          if (kind === 'pdf') await copyVerified(active.handle, backupPath(path, expected), previous.blob, expected, 'backup');
        }
        await writeDisk(active.handle, path, blob, expected, kind);
        return { revision };
      });
    },
    migrateTo(handle) {
      return locked(async () => {
        await checkActive();
        if (active.handle) throw new Error('请先切换到要迁移的浏览器资料库。');
        if (handle?.kind !== 'directory' || !await permission(handle)) throw permissionError();
        const records = await catalog(db, true);
        // Check every collision before writing the first file; interrupted copies can be resumed.
        for (const item of records) await identicalOrMissing(handle, item.path, item.revision, item.kind);
        for (const item of records) {
          const record = await getRecord(db, 'files', item.path);
          if (!record || item.revision !== record.revision) throw changing();
          await copyVerified(handle, item.path, record.blob, record.revision, item.kind);
        }
        await select(handle);
        return { count: records.length };
      });
    },
    async *exportFiles() {
      await checkActive();
      const binding = active.id;
      for (const item of await rows(true)) {
        if (active.id !== binding) throw wrongLibrary();
        await checkActive();
        const { blob, revision } = await read(item.path, item.kind);
        if (active.handle ? folderStamp(blob) !== item.revision : revision !== item.revision) throw changing();
        yield { path: item.path, blob };
      }
    },
  };
  return store;
}
