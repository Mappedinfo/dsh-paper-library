import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { createFetchHandler } from './http.mjs';
import { defaultLibrary } from './bridge.mjs';

const args = process.argv.slice(2);
const option = (key,fallback) => args.includes(key) ? args[args.indexOf(key)+1] : fallback;
const port = Number(option('--port','43121'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const library = resolve(option('--library',defaultLibrary));
const handle = createFetchHandler({library,loopbackOnly:true});
const server = createServer(async(req,res) => {
  try {
    const controller = new AbortController();
    req.on('aborted',()=>controller.abort());
    res.on('close',()=> { if (!res.writableEnded) controller.abort(); });
    const request = new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,
      ...(!['GET','HEAD'].includes(req.method) ? {body:Readable.toWeb(req),duplex:'half'}:{}),signal:controller.signal});
    const response = await handle(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Request failed'); }
});
server.listen(port,'127.0.0.1',()=>console.log(`Paper Library: http://127.0.0.1:${server.address().port}/\nLibrary: ${library}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit(0)));
