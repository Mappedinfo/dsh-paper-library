import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultLibrary, dispatch, projectRoot } from './bridge.mjs';
import { createLocalStateStore, LocalStateError } from './local-state.mjs';
import { createLanguageLearning } from './harness/language-learning.mjs';
import { createPaperAnalysis } from './harness/paper-analysis.mjs';
import { createPaperLibrarySettings } from './harness/settings.mjs';

const staticFiles = { '': ['index.html','text/html;charset=utf-8'], 'index.html': ['index.html','text/html;charset=utf-8'], 'app.js':['app.js','text/javascript;charset=utf-8'], 'paper-chat.js':['paper-chat.js','text/javascript;charset=utf-8'], 'style.css':['style.css','text/css;charset=utf-8'] };
for (const name of ['workbench.js','knowledge-graph.js','workbench.css','knowledge-graph.css','pdf-reader.js','pdf-reader.css','reading-panels.js','reading-panels.css','reading-shell.js','reading-shell.css','local-state.js','language-learning.js','language-learning.css','theme.js','theme.css']) staticFiles[name] = [name, name.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'text/css;charset=utf-8'];
for (const name of ['resource-library.js','resource-library.css','knowledge-workflow.js']) staticFiles[name] = [name, name.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'text/css;charset=utf-8'];
for (const name of ['paper-analysis.js','paper-analysis.css']) staticFiles[name] = [name, name.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'text/css;charset=utf-8'];
for (const name of ['settings.js','settings.css']) staticFiles[name] = [name, name.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'text/css;charset=utf-8'];
const languageActions = new Set(['language_generate','language_history','vocabulary_list','vocabulary_update','vocabulary_delete','vocabulary_export']);
staticFiles['companion.js']=['companion.js','text/javascript;charset=utf-8'];
const browserStatePrefixes = ['reader:', 'chat:', 'metadata:', 'language-draft:', 'resource-draft:', 'knowledge-draft:'];
function browserStateKey(key, listPrefix = false) {
  if (typeof key !== 'string' || !(key === 'preferences' || key === 'reader' || browserStatePrefixes.some(prefix => key.startsWith(prefix)) || /^migration:[a-f0-9]{64}$/.test(key) || (listPrefix && key === 'migration:'))) throw new LocalStateError('此状态类别不能直接从浏览器访问。', 'STATE_FORBIDDEN', 403);
  return key;
}
async function stateRequest(store, input) {
  if (input.action === 'state_get') return store.get(browserStateKey(input.key));
  if (input.action === 'state_put') return store.put(browserStateKey(input.key), input.value, input.expected_revision);
  if (input.action !== 'state_list') throw new LocalStateError('未知的本地状态操作。');
  const prefix = browserStateKey(input.prefix, true);
  // Exact singleton keys must not make a new namespace readable by prefix.
  if (prefix === 'preferences' || prefix === 'reader') {
    const offset = input.offset ?? 0, limit = input.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new LocalStateError('状态分页要求 offset 0–10000、limit 1–50。');
    const record = await store.get(prefix), total = record.revision === 0 ? 0 : 1;
    return { records: offset === 0 && total ? [record] : [], total, offset, limit, next_offset: null, hasMore: false, truncated: false };
  }
  return store.list({ prefix, offset: input.offset ?? 0, limit: input.limit ?? 20 });
}
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
  const store = options.localState || createLocalStateStore({ library: options.library || defaultLibrary, home: options.localStateHome });
  const settings = options.settings || createPaperLibrarySettings({store});
  const localState = options.settings ? store : settings.localState;
  // Browsing saved learning data is local and does not initialize an AI route or
  // paper conversation. Only the host-injected adapter may generate new output.
  const learningRecords = options.languageLearning || createLanguageLearning({ store: localState, dispatch, library: options.library || defaultLibrary, python: options.python });
  const analysisRecords = options.paperAnalysis || createPaperAnalysis({store:localState,dispatch,library:options.library||defaultLibrary,python:options.python});
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
          if (['save_feedback','save_conversation_feedback','export_pdf','inspect_pdf','companion_excerpt','paper_analysis_sources','paper_analysis_batch','paper_analysis_apply_metadata'].includes(input?.action)) return json({ok:false,error:'此操作不能直接提交。'},403);
          const companionAction=['companion_status','companion_retry','companion_cancel'].includes(input?.action);
          if(companionAction&&!options.companion)return json({ok:false,error:'实时伴学需要连接 DSH 服务。'},409);
          const chatAction = typeof input?.action === 'string' && input.action.startsWith('chat_');
          const stateAction = typeof input?.action === 'string' && input.action.startsWith('state_');
          const languageAction = languageActions.has(input?.action);
          if (chatAction && !options.paperChat) return json({ok:false,error:'请从 DeepSeek Harness 的文献库面板打开论文对话。'},400);
          if (input?.action === 'language_generate' && !options.languageLearning) return json({ok:false,error:'请从 DeepSeek Harness 的文献库面板生成翻译或润色，已保存记录仍可在此查看。'},400);
          if (input?.action === 'knowledge_generate' && !options.libraryKnowledge) return json({ok:false,error:'尚未连接 DSH 模型服务；已保存的来源和知识笔记仍可查看。'},409);
          let result = companionAction ? await options.companion.handle(input)
            : input?.action === 'settings_get' ? await settings.get()
            : input?.action === 'settings_update' ? await settings.update(input.patch, input.expected_revision)
            : input?.action === 'settings_reset' ? await settings.reset(input.expected_revision)
            : stateAction ? await stateRequest(localState, input)
            : typeof input?.action === 'string' && input.action.startsWith('paper_analysis_') ? await analysisRecords(input)
            : input?.action === 'knowledge_generate' ? await options.libraryKnowledge(input, { signal: request.signal })
            : languageAction ? await learningRecords(input, { signal: request.signal })
            : chatAction
            ? await options.paperChat(input, { signal: request.signal })
            : await dispatch(input, { ...options, signal: request.signal });
          if(options.companion&&['annotate','annotation_update'].includes(input?.action)&&input.companion_skip!==true){
            try{result.companion=await options.companion.saved(input.id,result.annotation)}
            catch(error){result.companion={status:'failed',error:`批注已保存，伴学未入队：${error.message}`}}
          }
          if(input.action==='status')result={...result,realtime_companion:Boolean(options.companion)};
          if (input.action === 'status') result = { ...result, paper_conversations: Boolean(options.paperChat), annotation_references: options.paperChat?.annotationReferences === true, catalog_management: true, typed_graph: true, reading_workspace: true, durable_state: true, learning_records: true, language_learning: Boolean(options.languageLearning) };
          if (input.action === 'status') result = { ...result, dataset_library:true, dataset_preview:true, knowledge_workflow:true, knowledge_generation:Boolean(options.libraryKnowledge),paper_analysis:Boolean(options.paperAnalysis),paper_analysis_records:true };
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
    } catch(error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
      return json({ok:false,error:error.message || '操作失败，请重试。', ...(error.code ? {code:error.code} : {}), ...(error.code === 'STATE_CONFLICT' ? {current:error.current} : {}), ...(['failed','pending','committing'].includes(error.generation_status) ? {generation_status:error.generation_status} : {}), ...(typeof error.retry_with_new_request === 'boolean' ? {retry_with_new_request:error.retry_with_new_request} : {})},status);
    }
  };
}
