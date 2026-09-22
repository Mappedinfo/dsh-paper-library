/** Speak MCP to any stdio server: initialize, then list its tools.
 *
 *  Usage: node scripts/mcp-probe.mjs <entry.mjs> [--root <dir> ...] [--write]
 *
 *  This is how the tool surface quoted in `docs/mcp.md` was read from the official draw.io MCP
 *  server, and how our own `mcp/server.mjs` can be checked by hand. It is a client, not a test
 *  harness: it prints what the server says and exits non-zero if the handshake fails.
 */
import { spawn } from 'node:child_process';

const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
  console.error('用法：node scripts/mcp-probe.mjs <server.mjs> [服务器参数…]');
  process.exit(2);
}
const child = spawn(process.execPath, [entry, ...rest], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
let failed = false;
child.stdout.on('data', bytes => {
  buffer += bytes.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue }
    if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
child.stderr.on('data', bytes => process.stderr.write(`[server] ${bytes}`));
child.on('exit', code => { if (code && code !== 0) { failed = true; console.error(`服务器退出码 ${code}`); process.exitCode = 1; } });
const call = (id, method, params) => new Promise((resolve, reject) => {
  pending.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  setTimeout(() => reject(new Error(`${method} 超时`)), 15000);
});
try {
  const initialized = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-paper-library-probe', version: '1.0.0' } });
  console.log('server:', JSON.stringify(initialized.result?.serverInfo), '| protocol:', initialized.result?.protocolVersion);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await call(2, 'tools/list', {});
  const tools = listed.result?.tools ?? [];
  console.log('tools:', tools.length);
  for (const tool of tools) {
    const properties = tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [];
    const required = tool.inputSchema?.required ?? [];
    console.log(`  - ${tool.name}(${properties.join(', ')})${required.length ? ` required=${required.join('+')}` : ''}`);
  }
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
} finally { child.kill(); }
