import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const defaultLibrary = join(homedir(), '.local', 'share', 'dsh-paper-library');
const actions = new Set(['status','import','list','get','update','attach','page','annotations','annotate','annotation_update','annotation_delete','export_annotations','export_pdf','link','graph','feedback_context','save_feedback','feedback']);
let pending = Promise.resolve();

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
  if (request.doi) {
    const doi = String(request.doi).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
    if (!/^10\.\d{4,9}\/[^\s?#]+$/i.test(doi) || doi.length > 512) throw new Error('请输入有效 DOI（例如 10.1038/s41586-023-06410-y）。');
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/vnd.citationstyles.csl+json`, {
      headers: { Accept: 'application/vnd.citationstyles.csl+json', 'User-Agent': 'DSHPaperLibrary/0.1 (local literature catalog)' },
      redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Crossref 返回 ${response.status}；可改用 PDF 或引用文件导入。`);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('DOI 元数据响应过大。');
    const item = JSON.parse(text);
    item.DOI = item.DOI || doi;
    return core({ action: 'import', items: [item] }, options);
  }
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
  if (safe.action === 'import') return importFile(safe, options);
  return core(safe, options);
}
