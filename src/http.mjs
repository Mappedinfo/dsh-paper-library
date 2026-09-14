import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { dispatch, projectRoot } from './bridge.mjs';

const staticFiles = { '': ['index.html','text/html;charset=utf-8'], 'index.html': ['index.html','text/html;charset=utf-8'], 'app.js':['app.js','text/javascript;charset=utf-8'], 'paper-chat.js':['paper-chat.js','text/javascript;charset=utf-8'], 'style.css':['style.css','text/css;charset=utf-8'] };
for (const name of ['workbench.js','knowledge-graph.js','workbench.css','knowledge-graph.css','pdf-reader.js','pdf-reader.css','reading-panels.js','reading-panels.css','reading-shell.js','reading-shell.css']) staticFiles[name] = [name, name.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'text/css;charset=utf-8'];
const baseHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};
function json(result, status=200) { return new Response(JSON.stringify(result), { status, headers: { ...baseHeaders, 'Content-Type':'application/json;charset=utf-8' } }); }
const MAX_PDF_BYTES = 250 * 1024 * 1024;
let uploads = 0;
let jsonRequests = 0;

/** Stream a browser File to disk with backpressure; never encode a whole PDF as JSON. */
async function importUpload(request, url, options) {
  if (!request.headers.get('content-type')?.startsWith('application/pdf')) return json({ok:false,error:'PDF 上传需要 application/pdf。'},415);
  if (!request.body) return json({ok:false,error:'缺少 PDF 文件。'},400);
  if (Number(request.headers.get('content-length') || 0) > MAX_PDF_BYTES) return json({ok:false,error:'PDF 超过 250 MiB 上限。'},413);
  if (uploads >= 2) return json({ok:false,error:'已有文件正在导入，请稍后重试。'},429);
  const filename = basename(url.searchParams.get('filename') || 'import.pdf');
  if (!/\.pdf$/i.test(filename) || /[\x00-\x1f]/.test(filename) || Buffer.byteLength(filename) > 240) return json({ok:false,error:'需要有效的 PDF 文件名。'},400);
  uploads++;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(),'paper-library-upload-'));
    const path = join(directory,filename);
    let size = 0;
    const limit = new Transform({transform(chunk,encoding,callback) {
      size += chunk.length;
      callback(size > MAX_PDF_BYTES ? new Error('PDF 超过 250 MiB 上限。') : null,chunk);
    }});
    const signal = AbortSignal.any([request.signal,AbortSignal.timeout(180000)]);
    await pipeline(Readable.fromWeb(request.body),limit,createWriteStream(path,{flags:'wx',mode:0o600}),{signal});
    if (!size) throw new Error('PDF 文件为空。');
    return json({ok:true,result:await dispatch({action:'import',path},{...options,signal})});
  } finally {
    uploads--;
    if (directory) await rm(directory,{recursive:true,force:true});
  }
}

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
      if (path === 'upload' && request.method === 'POST') return await importUpload(request,url,options);
      if (path === 'api' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ok:false,error:'需要 application/json 请求。'},415);
        // Reserve admission before reading bodies, so parallel large JSON uploads
        // cannot allocate unbounded strings while waiting for serial workers.
        if (jsonRequests >= 2) return json({ok:false,error:'已有请求正在处理，请稍后重试。'},429);
        jsonRequests++;
        try {
          const input = JSON.parse(await readBounded(request, 45*1024*1024));
          // Browser cannot forge AI output or arbitrary worker internals.
          if (['save_feedback','save_conversation_feedback','export_pdf','inspect_pdf'].includes(input?.action)) return json({ok:false,error:'此操作不能直接提交。'},403);
          const chatAction = typeof input?.action === 'string' && input.action.startsWith('chat_');
          if (chatAction && !options.paperChat) return json({ok:false,error:'请从 DeepSeek Harness 的文献库面板打开论文对话。'},400);
          let result = chatAction
            ? await options.paperChat(input, { signal: request.signal })
            : await dispatch(input, { ...options, signal: request.signal });
          if (input.action === 'status') result = { ...result, paper_conversations: Boolean(options.paperChat), annotation_references: options.paperChat?.annotationReferences === true, catalog_management: true, typed_graph: true, reading_workspace: true };
          return json({ok:true,result});
        } finally { jsonRequests--; }
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
