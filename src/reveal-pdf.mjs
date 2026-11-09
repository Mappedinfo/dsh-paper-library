import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const execute = promisify(execFile);

// Only a catalog-resolved path reaches this helper, never a browser-supplied path.
export async function revealPDF(path, { platform = process.platform, run = execute, signal } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || !(await stat(path)).isFile()) throw Error('PDF 文件不存在，无法打开所在文件夹。');
  let command, args;
  if (platform === 'darwin') { command = 'open'; args = ['-R', path]; }
  else if (platform === 'win32') { command = 'explorer.exe'; args = [`/select,${path}`]; }
  else if (platform === 'linux') { command = 'xdg-open'; args = [dirname(path)]; }
  else throw Error('当前系统不支持打开文件管理器。');
  try { await run(command, args, { timeout: 5000, maxBuffer: 16384, windowsHide: true, signal }); }
  catch { throw Error('无法打开文件管理器，请确认运行 DSH 的主机有可用的桌面环境。'); }
  return { opened: true, location: 'host', selected: platform !== 'linux' };
}
