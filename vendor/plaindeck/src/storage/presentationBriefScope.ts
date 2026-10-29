import type { DirectoryHandle } from './browserStorage'

export interface DirectoryBriefScopeRecord { scope: string; handle: DirectoryHandle }
export interface DirectoryBriefScopeRegistry {
  read(): Promise<unknown[]>
  write(record: DirectoryBriefScopeRecord): Promise<void>
}

const databaseName = 'plaindeck-presentation-brief-scopes'
const storeName = 'directories'

function openRegistry(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let settled = false
    const fail = (error: unknown) => { settled = true; reject(error) }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'scope' })
    }
    request.onerror = () => fail(request.error ?? new Error('Brief scope registry could not be opened'))
    request.onblocked = () => fail(new Error('Brief scope registry is blocked'))
    request.onsuccess = () => {
      const database = request.result
      if (settled) { database.close(); return }
      database.onversionchange = () => database.close()
      settled = true
      resolve(database)
    }
  })
}

async function registryTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openRegistry()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode)
      let request: IDBRequest<T> | undefined
      transaction.oncomplete = () => resolve(request!.result)
      transaction.onerror = () => reject(transaction.error ?? request?.error ?? new Error('Brief scope transaction failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Brief scope transaction was aborted'))
      try { request = operation(transaction.objectStore(storeName)) }
      catch (error) {
        try { transaction.abort() } catch { /* The failed transaction may already be inactive. */ }
        reject(error)
      }
    })
  } finally { database.close() }
}

const browserRegistry: DirectoryBriefScopeRegistry = {
  read: () => registryTransaction('readonly', store => store.getAll()),
  write: async record => { await registryTransaction('readwrite', store => store.put(record)) },
}

function isRecord(value: unknown): value is DirectoryBriefScopeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<DirectoryBriefScopeRecord>
  return typeof record.scope === 'string' && record.scope.startsWith('directory:') && !!record.handle && record.handle.kind === 'directory'
}

/** Names and deck IDs cannot identify a directory; compare the actual handles. */
export function createDirectoryBriefScopeResolver(registry: DirectoryBriefScopeRegistry = browserRegistry) {
  const scopes = new WeakMap<DirectoryHandle, Promise<string>>()
  let queue: Promise<unknown> = Promise.resolve()
  return (handle: DirectoryHandle): Promise<string> => {
    const cached = scopes.get(handle)
    if (cached) return cached
    const pending = queue.then(async () => {
      const fresh = `directory:${crypto.randomUUID()}`
      try {
        if (typeof handle.isSameEntry !== 'function') return fresh
        const records = await registry.read()
        for (const record of records) {
          if (isRecord(record) && await handle.isSameEntry(record.handle)) return record.scope
        }
        await registry.write({ scope: fresh, handle })
      } catch { /* Storage, cloning or identity checks can fail; this handle keeps its own scope. */ }
      return fresh
    })
    scopes.set(handle, pending)
    queue = pending.catch(() => undefined)
    return pending
  }
}

/** Persistent when handle storage is supported; otherwise unique for this handle in this session. */
export const resolveDirectoryBriefScope = createDirectoryBriefScopeResolver()
