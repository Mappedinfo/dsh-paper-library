import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { syncDirectory } from '../src/fs-portability.mjs';

test('Windows skips unsupported directory handles before open or sync', async () => {
  let opens = 0;
  await syncDirectory('C:\\synthetic-state', { platform: 'win32', openDirectory: async () => { opens++; throw Object.assign(new Error('unsupported directory handle'), { code: 'EPERM' }); } });
  assert.equal(opens, 0);
});

test('POSIX directory sync flushes and closes the opened directory', async () => {
  const operations = [];
  await syncDirectory('/synthetic-state', { platform: 'linux', openDirectory: async (path, flags) => {
    operations.push(['open', path, flags]);
    return { sync: async () => operations.push(['sync']), close: async () => operations.push(['close']) };
  } });
  assert.deepEqual(operations, [['open', '/synthetic-state', constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)], ['sync'], ['close']]);
});

test('POSIX fsync errors remain visible and the directory handle closes', async () => {
  const failure = Object.assign(new Error('device refused flush'), { code: 'EIO' });
  let closed = false;
  await assert.rejects(syncDirectory('/synthetic-state', { platform: 'darwin', openDirectory: async () => ({ sync: async () => { throw failure; }, close: async () => { closed = true; } }) }), error => error === failure);
  assert.equal(closed, true);
});

test('POSIX directory-open errors are not swallowed as portability fallbacks', async () => {
  const failure = Object.assign(new Error('directory access denied'), { code: 'EACCES' });
  await assert.rejects(syncDirectory('/synthetic-state', { platform: 'linux', openDirectory: async () => { throw failure; } }), error => error === failure);
});
