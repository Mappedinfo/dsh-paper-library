import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { dispatch, projectRoot } from './bridge.mjs';

const staticFiles = { '': ['index.html','text/html;charset=utf-8'], 'index.html': ['index.html','text/html;charset=utf-8'], 'app.js':['app.js','text/javascript;charset=utf-8'], 'style.css':['style.css','text/css;charset=utf-8'] };
const baseHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};
function json(result, status=200) { return new Response(JSON.stringify(result), { status, headers: { ...baseHeaders, 'Content-Type':'application/json;charset=utf-8' } }); }

async function readBounded(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('上传超过 32 MB，请使用本地路径。');
  const chunks = []; let size = 0;
  if (!request.body) throw new Error('缺少请求内容。');
  for await (const chunk of request.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('上传超过 32 MB，请使用本地路径。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createFetchHandler(options = {}) {
  const basePath = (options.basePath || '').replace(/\/$/, '');
  return async function handle(request) {
    const url = new URL(request.url);
    if (options.loopbackOnly) {
      if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return json({ok:false,error:'仅允许本机访问。'},403);
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ok:false,error:'拒绝跨站请求。'},403);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return new Response('Not found',{status:404});
    if (url.pathname === basePath && !url.pathname.endsWith('/')) return new Response(null,{status:302,headers:{location:`${basePath}/`}});
    const path = url.pathname.slice(basePath.length).replace(/^\//,'');
    try {
      if (path === 'api' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ok:false,error:'需要 application/json 请求。'},415);
        const input = JSON.parse(await readBounded(request, 45*1024*1024));
        // Browser cannot forge AI output or arbitrary worker internals. It can
        // request AI through the configured model and receive its saved result.
        if (['save_feedback','export_pdf'].includes(input.action)) return json({ok:false,error:'此操作不能直接提交。'},403);
        const result = await dispatch(input, { ...options, signal: request.signal });
        return json({ok:true,result});
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ok:false,error:'不支持的请求方法。'},405);
      if (path.startsWith('pdf/')) {
        const id = decodeURIComponent(path.slice(4));
        if (!id || id.includes('/')) return new Response('Not found',{status:404});
        const result = await dispatch({action:'export_pdf',id}, { ...options, signal: request.signal });
        const info = await stat(result.path);
        const filename = String(result.filename || 'annotated.pdf').replace(/[\r\n"\\]/g,'_');
        return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(result.path)), {
          headers:{...baseHeaders,'Content-Type':'application/pdf','Content-Length':String(info.size),'Content-Disposition':`attachment; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`},
        });
      }
      if (!Object.hasOwn(staticFiles,path)) return new Response('Not found',{status:404});
      const [file,mime] = staticFiles[path];
      const body = await readFile(join(projectRoot,'web',file));
      return new Response(request.method === 'HEAD' ? null : body,{headers:{...baseHeaders,'Content-Type':mime}});
    } catch(error) { return json({ok:false,error:error.message || '操作失败，请重试。'},400); }
  };
}
