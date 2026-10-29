/** Windows does not expose directory fsync through Node's file handles.
 * File data is still flushed before replacement. A rename is atomic, but this
 * fallback does not promise directory-entry durability after a power loss.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function syncDirectory(path, { platform = process.platform, openDirectory = open } = {}) {
  if (platform === 'win32') return;
  const directory = await openDirectory(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { await directory.sync(); } finally { await directory.close(); }
}
