import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAndFetch } from './paper-fetch.mjs';
import { bibliographicMetadata, importPDF } from './import-pdf.mjs';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const defaultLibrary = join(homedir(), '.local', 'share', 'dsh-paper-library');
const actions = new Set(['status','import','list','get','update','attach','page','annotations','annotate','annotation_update','annotation_delete','export_annotations','export_pdf','link','graph','feedback_context','save_feedback','feedback']);
let pending = Promise.resolve();
let importsPending = Promise.resolve();
let importCount = 0;
let importPayloadBytes = 0;
const MAX_QUEUED_PAYLOAD = 96 * 1024 * 1024;

function payloadSize(request) {
  // Conservative UTF-16 accounting without making a second JSON/string copy.
  // Admission applies to tool/CLI callers too, not just browser uploads.
  const remaining = [request];
  let bytes = 0, nodes = 0;
  while (remaining.length) {
    const value = remaining.pop();
    if (++nodes > 100000) throw new Error('导入数据结构过大，请拆分文件。');
    if (typeof value === 'string') bytes += value.length * 2;
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        bytes += key.length * 2 + 16;
        remaining.push(child);
      }
    } else bytes += 8;
    if (bytes > MAX_QUEUED_PAYLOAD) throw new Error('导入数据超过内存预算，请拆分文件或使用本地路径。');
  }
  return bytes;
}

function enqueueImport(request,options) {
  if (importCount >= 50) throw new Error('导入队列已满，请等待当前文件处理完毕。');
  const bytes = payloadSize(request);
  if (importPayloadBytes + bytes > MAX_QUEUED_PAYLOAD) throw new Error('导入队列内存预算已满，请等待当前文件处理完毕。');
  importCount++;
  importPayloadBytes += bytes;
  const result = importsPending.catch(()=>{}).then(()=>{
    options.signal?.throwIfAborted();
    return importFile(request,options);
  }).finally(()=>{importCount--; importPayloadBytes -= bytes;});
  importsPending=result.then(()=>{},()=>{});
  return result;
}

export function core(request, options = {}) {
  // Serial workers bound aggregate native-memory cost and protect PDF writes.
  const result = pending.catch(() => {}).then(() => runWorker(request, options));
  pending = result.then(() => {}, () => {});
  return result;
}

function runWorker(request, options) {
  const python = options.python || join(projectRoot, '.venv', 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  return runProcess(python, ['-m', 'dsh_paper_library.worker'], { ...request, library: resolve(options.library || defaultLibrary) }, options);
}

function citationJob(request, options) {
  // CSL can allocate a large temporary heap. Keep that heap out of Harness and
  // release it with process exit, even when V8 would otherwise retain RSS.
  const result = pending.catch(() => {}).then(() => runProcess(process.execPath, [join(projectRoot,'src/citation-worker.mjs')], request, options));
  pending = result.then(() => {}, () => {});
  return result;
}

function runProcess(command, args, request, options) {
  return new Promise((accept, reject) => {
    if (options.signal?.aborted) return reject(new Error('操作已取消。'));
    const child = spawn(command, args, {
      cwd: projectRoot, stdio: ['pipe','pipe','pipe'],
      env: { ...process.env, PYTHONPATH: join(projectRoot, 'src'), PYTHONDONTWRITEBYTECODE: '1' },
    });
    let stdout = '', stderr = '', bytes = 0, fail;
    const abort = () => { fail = new Error('操作已取消。'); child.kill(); };
    const timeout = setTimeout(() => { fail = new Error('操作超过 90 秒；请缩小导入批次或检查 PDF。'); child.kill(); }, 90000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) { fail = new Error('结果过大，请缩小批次。'); child.kill(); }
      else stdout += chunk;
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    child.stdin.on('error', () => {});
    const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(new Error(`无法运行文献内核，请先完成 npm install 和 uv sync。${error.code || ''}`)); });
    child.on('close', code => {
      cleanup();
      if (fail) return reject(fail);
      try {
        const response = JSON.parse(stdout);
        if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : response.error?.message || '文献操作失败');
        if (code !== 0) throw new Error('文献内核意外退出。');
        accept(response.result);
      } catch (error) { reject(new Error(stdout.trim() ? error.message : `文献内核未返回结果。${stderr.slice(0, 1000)}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function importFile(request, options) {
  if (request.content_base64 !== undefined) {
    const content = String(request.content_base64);
    if (content.length > 44 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('上传文件无效或超过 32 MB；大文件请用本地路径导入。');
    const filename = basename(String(request.filename || 'import.pdf'));
    if (!['.pdf','.json','.ris','.bib'].includes(extname(filename).toLowerCase())) throw new Error('支持 PDF、JSON、RIS 和 BIB 文件。');
    const dir = await mkdtemp(join(tmpdir(), 'paper-library-upload-'));
    try {
      const path = join(dir, filename);
      await writeFile(path, Buffer.from(content, 'base64'), { mode: 0o600 });
      return await importFile({ action: 'import', path, offset:request.offset, limit:request.limit }, options);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  if (request.doi || request.url) {
    const target = String(request.doi || request.url).trim();
    const doi=target.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').toLowerCase();
    if (/^10\.\d{4,9}\/[^\s?#]+$/i.test(doi)) {
      const found=await core({action:'list',query:doi,limit:100},options);
      const existing=found.items.find(item=>item.DOI?.toLowerCase()===doi && item.pdf);
      if(existing) return {imported:0,duplicates:1,items:[existing],warnings:[],acquisition:{status:'reused',source_url:target}};
    }
    const directory = await mkdtemp(join(tmpdir(),'paper-library-fetch-'));
    try {
      const fetched=await resolveAndFetch(target,{...options.fetchOptions,directory,signal:options.signal});
      if(fetched.path) return await importPDF(fetched.path,options,core,fetched);
      if(fetched.metadata?.title) {
        const metadata={...bibliographicMetadata(fetched.metadata),acquisition:fetched.provenance};
        const result=await core({action:'import',items:[metadata]},options);
        result.acquisition={...fetched,path:undefined};
        result.warnings=[...(result.warnings || []),...(fetched.warnings || []),'已保存文献资料；尚未获得可读 PDF，可拖入文件继续关联。'];
        return result;
      }
      throw new Error(fetched.warnings?.join('；') || '未找到可公开获取的 PDF。请拖入已有 PDF，或使用论文的直接下载链接。');
    } finally {await rm(directory,{recursive:true,force:true});}
  }
  if (request.path && extname(String(request.path)).toLowerCase() === '.pdf') return importPDF(request.path,options,core);
  if (request.path && extname(String(request.path)).toLowerCase() === '.bib') {
    if ((await stat(request.path)).size > 16 * 1024 * 1024) throw new Error('BibTeX 文件超过 16 MB；请分批导入。');
    const items = await citationJob({ action:'parse', text:await readFile(request.path,'utf8') }, options);
    return core({ action: 'import', items, offset:request.offset, limit:request.limit }, options);
  }
  return core(request, options);
}

export async function dispatch(request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('请求必须是 JSON 对象。');
  const { library: ignoredLibrary, python: ignoredPython, ...safe } = request;
  if (safe.action === 'models') return options.models ? options.models(options.signal) : { models: [], configured: false };
  if (safe.action === 'export_library') {
    const format = safe.format || 'biblatex';
    if (!['biblatex','csl-json'].includes(format)) throw new Error('整库导出支持 BibLaTeX 或 CSL JSON。');
    const texts = []; const records = []; let count = 0;
    const snapshot = await core({action:'export_metadata'}, options);
    for (let offset=0;offset<snapshot.items.length;offset+=100) {
      const items=snapshot.items.slice(offset,offset+100);
      count+=items.length;
      if(format==='csl-json') records.push(...items);
      else texts.push((await citationJob({action:'cite',items,format},options)).text);
    }
    return {text:format==='csl-json'?JSON.stringify(records,null,2):texts.join('\n'),filename:format==='csl-json'?'library.json':'library.bib',mime:format==='csl-json'?'application/json':'application/x-bibtex',count};
  }
  if (safe.action === 'cite') {
    if (!Array.isArray(safe.ids) || safe.ids.length < 1 || safe.ids.length > 500) throw new Error('请选择 1–500 篇文献。');
    const items = [];
    for (const id of safe.ids) items.push(await core({ action: 'get', id }, options));
    return citationJob({ action:'cite', items, format:safe.format }, options);
  }
  if (safe.action === 'ai_feedback') {
    if (!options.ai) throw new Error('AI 尚未连接。请在 DeepSeek Harness 中打开插件并选择已配置的模型。');
    const context = await core({ action: 'feedback_context', id: safe.id, annotation_ids: safe.annotation_ids }, options);
    if (!context.annotations?.length) throw new Error('请先添加批注，再生成反馈。');
    const provider = safe.provider || options.provider;
    const model = safe.model || options.model;
    if (!provider || !model) throw new Error('请先选择 AI 服务和模型。');
    const text = await options.ai({ prompt: context.prompt, provider, model, reasoningEffort: safe.reasoning_effort ?? options.reasoningEffort, signal: options.signal });
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回反馈；批注已保留。');
    if (text.length > 28000) throw new Error('模型反馈超过保存上限，请缩小所选批注后重试。');
    const ids = context.annotations.map(a => a.id);
    const latest = await core({ action: 'feedback_context', id: safe.id, annotation_ids: ids }, options);
    if (JSON.stringify(latest.annotations) !== JSON.stringify(context.annotations)) throw new Error('生成期间批注发生变化；请重新生成以使用最新批注。');
    return core({ action: 'save_feedback', id: safe.id, text, model: `${provider}/${model}`, annotation_ids: ids, expected_context_hash:context.context_hash }, options);
  }
  if (!actions.has(safe.action)) throw new Error('未知文献操作。');
  if (safe.action === 'import') {
    const sources=['path','doi','url','items','content_base64'].filter(key=>safe[key]!==undefined && safe[key]!==null && safe[key]!=='');
    if(sources.length!==1) throw new Error('请提供一种导入来源：PDF/文件路径、链接、DOI、元数据或上传文件。');
    return enqueueImport(safe, options);
  }
  return core(safe, options);
}
