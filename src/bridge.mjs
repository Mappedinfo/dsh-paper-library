import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arxivID, isDirectPDFURL, resolveAndFetch, resolveMetadata, resolveTitleMetadata } from './paper-fetch.mjs';
import { bibliographicMetadata, importPDF } from './import-pdf.mjs';
import { createTranslationServerClient } from './translation-server.mjs';
import { resourcePolicyFor } from './resource-policy.mjs';
import { workerScheduler } from './worker-scheduler.mjs';
import { revealPDF } from './reveal-pdf.mjs';
import { apaCopyReadiness } from './citations.mjs';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const defaultLibrary = join(homedir(), '.local', 'share', 'dsh-paper-library');
const actions = new Set(['paper_outline','paper_visual_read','paper_text_find','paper_text_search','paper_text_read','document_elements_scan','document_elements_clear','document_elements_list','document_element_preview','document_element_annotate','document_element_flow','status','import','list','get','create','archive','restore','update','paper_organization_update','paper_tags_list','attach','page_layout','page','annotations','annotation_preview','annotation_caption_result','annotation_catalog','annotation_context_exact','annotation_translation_result','annotate','annotation_reply_create','annotation_update','annotation_reselect','annotation_style','annotation_delete','export_annotations','export_pdf','link','graph','graph_statistics','graph_references_extract','graph_references_get','graph_node_put','graph_node_delete','graph_edge_put','graph_edge_delete','feedback_context','save_feedback','feedback']);
const challengeActions = new Set(['challenge_scan','challenge_themes','challenge_theme_list','challenge_theme_get','challenge_theme_review','challenge_theme_merge','challenge_theme_check','challenge_export','challenge_comparison','challenge_comparison_list','challenge_comparison_get','challenge_review_packet']);
const projectActions = new Set(['project_create','project_update','project_get','project_list','project_archive','project_restore','project_link','project_unlink','project_for_paper']);
// Ordinary external sources come from deployment/settings. Management-only
// external_rebind accepts an explicit repair plan; browsers cannot invoke it.
// None of these actions deletes or moves an original PDF.
const externalActions = new Set(['external_status','external_scan','external_prune','external_promote','external_rebind']);
// LaTeX projects edit the reader's own folder: writes are revision-checked and
// compiling runs their local latexmk, so every action stays behind this list.
export const LATEX_RETRIEVAL_ACTIONS = new Set(['latex_retrieval_list', 'latex_search', 'latex_retrieval_read', 'latex_pdf_text']);
const latexActions = new Set(['latex_project_create','latex_project_list','latex_project_get','latex_project_update','latex_project_archive','latex_project_restore','latex_project_link_reading','latex_version_list','latex_version_get','latex_version_pdf_pages','latex_version_pdf_page','latex_version_read','latex_version_review','latex_version_review_export','latex_tree',...LATEX_RETRIEVAL_ACTIONS,'latex_source_search','latex_asset_import','latex_table_import','latex_formula_check','latex_outline','latex_media_preview','latex_review_list','latex_review_put','latex_review_export','latex_review_delete','latex_read','latex_lint','latex_write','latex_compile','latex_pdf_pages','latex_pdf_page','latex_pdf_search','latex_history','latex_diff','latex_compare','latex_synctex_edit','latex_synctex_view','latex_clean']);

const libraryActions = new Set(['resource_list','resource_export','dataset_import','dataset_put','dataset_get','dataset_archive','dataset_restore','dataset_release_put','dataset_release_get','dataset_release_list','dataset_link_put','dataset_link_list','dataset_link_delete','dataset_asset_put','dataset_asset_list','dataset_asset_preview','dataset_graph_promote','knowledge_source_put','knowledge_source_get','knowledge_source_check','knowledge_source_list','knowledge_draft_put','knowledge_draft_get','knowledge_draft_list','knowledge_draft_review','knowledge_draft_lint','knowledge_note_put','knowledge_note_get','knowledge_note_list','knowledge_export']);
/** Every action the reader bridge admits, grouped by the module that owns it.
 * Exported so a test can prove the tool surface and the bridge agree. */
export const BRIDGE_ACTIONS = {core: actions, challenge: challengeActions, project: projectActions, library: libraryActions, external: externalActions, latex: latexActions};
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

export async function core(request, options = {}) {
  const documentAction = /^document_element/.test(request.action || '');
  const resourcePolicy = documentAction ? await resourcePolicyFor(options) : null;
  options = {...options, ...(resourcePolicy?{resourcePolicy}: {})};
  // 优先级只来自内部调用选项，不读取浏览器/工具请求正文的同名字段。
  const background = request.action !== 'status' && (options.workerPriority === 'background'
    || ['document_elements_scan', 'document_element_preview', 'document_element_flow'].includes(request.action));
  const scan = request.action === 'document_elements_scan';
  const key = scan ? scanKey(request, options) : undefined;
  return workerScheduler.schedule(
    ({ signal }) => runWorker(request, { ...options, signal }),
    { priority: background ? 'background' : 'foreground', key, signal: options.signal, cancelRunning: scan, cooldownMs:resourcePolicy?.worker_idle_ms },
  );
}

function scanKey(request, options) {
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const payload = { request, resourcePolicy: options.resourcePolicy, library: resolve(options.library || defaultLibrary), python: options.python || 'managed' };
  return `scan:${createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex')}`;
}

function venvPython() {
  return process.platform === 'win32'
    ? join(projectRoot, '.venv', 'Scripts', 'python.exe')
    : join(projectRoot, '.venv', 'bin', 'python');
}

function commandExists(command) {
  return new Promise(accept => {
    const probe = spawn(command, ['--version'], { stdio: 'ignore' });
    probe.on('error', () => accept(false));
    probe.on('close', code => accept(code === 0));
  });
}

function runSetup(command, args, label) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => { if (output.length < 4000) output += chunk; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`文献内核自动安装超时（${label}）；请检查网络后重试。`)); }, 10 * 60 * 1000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) return accept();
      reject(new Error(`文献内核自动安装失败（${label}，退出码 ${code}）：${output.trim().slice(-600)}`));
    });
  });
}

/** The published package ships pyproject.toml/uv.lock but no virtualenv.
 * Provision one on first use instead of asking the reader to run uv sync. */
async function provisionVenv(python) {
  const requirements = ['pymupdf>=1.26.6,<2', 'pymupdf4llm==0.2.9', 'openpyxl>=3.1.5,<4', 'filelock>=3.32.7,<4'];
  if (await commandExists('uv')) {
    try {
      await runSetup('uv', ['sync', '--no-dev'], 'uv sync');
      if (existsSync(python)) return;
    } catch { /* fall through to direct venv creation */ }
    await runSetup('uv', ['venv', '.venv'], 'uv venv');
    await runSetup('uv', ['pip', 'install', '--python', python, ...requirements], 'uv pip install PDF dependencies');
    return;
  }
  for (const command of process.platform === 'win32' ? ['python', 'python3'] : ['python3']) {
    if (await commandExists(command)) {
      await runSetup(command, ['-m', 'venv', '.venv'], `${command} -m venv`);
      await runSetup(python, ['-m', 'pip', 'install', ...requirements], 'pip install PDF dependencies');
      return;
    }
  }
  throw new Error('文献内核需要 Python 3.11+：请安装 uv（https://docs.astral.sh/uv/）或 Python 后重试，插件会自动完成依赖安装。');
}

let venvProvisioning = null;
const dependencyRuntimes = new Map();
async function ensurePythonDependency(python, moduleName, requirement, label, install, probe = `import ${moduleName}`) {
  const identity = `${python}\0${moduleName}`;
  if (!dependencyRuntimes.has(identity)) dependencyRuntimes.set(identity, (async () => {
    const available = await new Promise(accept => {
      const child = spawn(python, ['-c', probe], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); accept(false); }, 10000);
      child.on('error', () => { clearTimeout(timer); accept(false); }); child.on('close', code => { clearTimeout(timer); accept(code === 0); });
    });
    if (available) return;
    if (!install) throw new Error(`指定的 Python 缺少${label}，请在该环境安装 ${requirement}。`);
    if (await commandExists('uv')) await runSetup('uv', ['pip', 'install', '--python', python, requirement], label);
    else await runSetup(python, ['-m', 'pip', 'install', requirement], label);
  })().catch(error => { dependencyRuntimes.delete(identity); throw error; }));
  return dependencyRuntimes.get(identity);
}
async function ensureVenv() {
  const python = venvPython();
  if (existsSync(python)) return python;
  if (!venvProvisioning) {
    // A failed attempt is retried on the next call rather than cached.
    venvProvisioning = provisionVenv(python).then(() => python, error => { venvProvisioning = null; throw error; });
  }
  return venvProvisioning;
}

async function runWorker(request, options) {
  const python = options.python || await ensureVenv();
  // Old plugin-owned venvs survive package updates; provision new core imports
  // once before starting a worker. Never mutate an explicitly selected runtime.
  await ensurePythonDependency(python, 'filelock', 'filelock>=3.32.7,<4', '跨平台文件锁依赖', !options.python,
    'import filelock; assert (3,32,7) <= tuple(map(int,filelock.__version__.split("."))) < (4,)');
  if (request.action === 'latex_table_import') await ensurePythonDependency(python, 'openpyxl', 'openpyxl>=3.1.5,<4', 'XLSX 读取依赖', !options.python);
  return runProcess(python, ['-m', 'dsh_paper_library.worker'], { ...request, _resource_policy: options.resourcePolicy || null, library: resolve(options.library || defaultLibrary) }, options);
}

function citationJob(request, options) {
  // CSL can allocate a large temporary heap. Keep that heap out of Harness and
  // release it with process exit, even when V8 would otherwise retain RSS.
  return workerScheduler.schedule(
    ({ signal }) => runProcess(process.execPath, [join(projectRoot,'src/citation-worker.mjs')], request, { ...options, signal }),
    { signal: options.signal, priority: options.workerPriority === 'background' ? 'background' : 'foreground' },
  );
}

function workerTimeout(request) {
  if (['paper_visual_read','paper_text_find', 'paper_text_search', 'paper_text_read'].includes(request.action)) return 15000;
  if (request.action === 'document_elements_scan') return 20000;
  if (request.action === 'latex_compile') {
    const configured = request.timeout_seconds;
    const numeric = typeof configured === 'number' || typeof configured === 'string';
    const seconds = configured == null ? 120 : numeric ? Math.trunc(Number(configured)) : NaN;
    // Python caps TeX at 600 s. Leave time for the build lock and snapshots
    // so it can return compiler diagnostics and register the verified PDF.
    if (seconds >= 5 && seconds <= 600) return (seconds + 60) * 1000;
  }
  const retrieval = LATEX_RETRIEVAL_ACTIONS.has(request.action) || ['latex_source_search', 'latex_pdf_search'].includes(request.action);
  return request.action === 'dataset_asset_preview' || retrieval ? 15000 : 90000;
}

function runProcess(command, args, request, options) {
  const timeoutMs = workerTimeout(request);
  const scan = request.action === 'document_elements_scan';
  const boundedDocumentRead = ['paper_visual_read','paper_text_find', 'paper_text_search', 'paper_text_read', 'document_elements_scan', 'document_elements_list', 'document_element_flow', 'document_element_preview'].includes(request.action);
  const maxOutputBytes = boundedDocumentRead ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
  return new Promise((accept, reject) => {
    if (options.signal?.aborted) return reject(new Error('操作已取消。'));
    const child = spawn(command, args, {
      cwd: projectRoot, stdio: ['pipe','pipe','pipe'],
      env: { ...process.env, PYTHONPATH: join(projectRoot, 'src'), PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '', stderr = '', bytes = 0, fail, scanKillTimer;
    const terminate = error => {
      if (fail) return;
      fail = error;
      child.kill();
      // 仅可重建的后台索引允许强杀兜底；正常 PDF 写入不采用此策略。
      if (scan) scanKillTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const abort = () => terminate(new Error('操作已取消。'));
    const timeout = setTimeout(() => terminate(new Error(`操作超过 ${timeoutMs / 1000} 秒；请缩小读取范围或检查文件。`)), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) terminate(new Error('结果过大，请缩小批次。'));
      else stdout += chunk;
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    child.stdin.on('error', () => {});
    const cleanup = () => { clearTimeout(timeout); clearTimeout(scanKillTimer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(new Error(`无法运行文献内核（${error.code || error.message}）；自动安装可能未完成，请重试或在插件目录手动运行 uv sync。`)); });
    child.on('close', code => {
      cleanup();
      if (fail) return reject(fail);
      try {
        const response = JSON.parse(stdout);
        if (!response.ok) {
          const error = new Error(typeof response.error === 'string' ? response.error : response.error?.message || '文献操作失败');
          if (typeof response.code === 'string') error.code = response.code;
          if (response.code === 'STATE_CONFLICT') { error.current = response.current; error.status = 409; }
          throw error;
        }
        if (code !== 0) throw new Error('文献内核意外退出。');
        accept(response.result);
      } catch (error) { reject(stdout.trim() ? error : new Error(`文献内核未返回结果。${stderr.slice(0, 1000)}`)); }
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

const normalizedIdentity = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const canonicalDOI = value => String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').toLowerCase();
const missingMetadata = value => value === undefined || value === null || typeof value === 'string' && !value.trim() || Array.isArray(value) && !value.length || value && typeof value === 'object' && !Object.keys(value).length;

function authorIdentities(person) {
  if (!person || typeof person !== 'object') return [];
  if (person.literal) return [normalizedIdentity(person.literal)];
  const family = [person['non-dropping-particle'],person.family].filter(Boolean).join(' ');
  const given = [person.given,person['dropping-particle']].filter(Boolean).join(' ');
  return [[given,family,person.suffix],[family,given,person.suffix]].map(parts=>normalizedIdentity(parts.filter(Boolean).join(' '))).filter(Boolean);
}

function metadataDraft(current, fetched) {
  const item = structuredClone(current);
  const incoming = bibliographicMetadata(fetched);
  for (const [field,value] of Object.entries(incoming)) {
    // Rankings are user/import-sourced. An online lookup never replaces or adds
    // them, nor does it substitute a different author list for a manual list.
    if (field === 'journal_rankings' || missingMetadata(value)) continue;
    if (missingMetadata(item[field])) item[field] = structuredClone(value);
  }
  if (incoming.publication_dates && current.publication_dates) {
    for (const [field,value] of Object.entries(incoming.publication_dates)) {
      if (missingMetadata(item.publication_dates[field]) && !missingMetadata(value)) item.publication_dates[field] = value;
    }
  }
  if (current.author?.length && incoming.author?.length) {
    const matches = (left,right) => authorIdentities(left).some(name=>authorIdentities(right).includes(name));
    item.author = current.author.map(person=>{
      // 缺少名字的姓氏只在远端唯一匹配时补齐；已填写的名字不覆盖。
      if(person.family&&!person.given&&!person.literal){
        const family=normalizedIdentity(person.family);
        const candidates=incoming.author.filter(candidate=>normalizedIdentity(candidate.family)===family||candidate.literal&&(normalizedIdentity(candidate.literal).endsWith(' '+family)||normalizedIdentity(candidate.literal)===family));
        if(candidates.length===1&&current.author.filter(other=>normalizedIdentity(other.family)===family).length===1){const candidate=candidates[0];return {...structuredClone(person),...(candidate.literal?{literal:candidate.literal}:candidate.given?{given:candidate.given}:{}),...(missingMetadata(person.affiliation)&&candidate.affiliation?{affiliation:structuredClone(candidate.affiliation)}:{})};}
      }
      if (!missingMetadata(person.affiliation)) return structuredClone(person);
      const candidates = incoming.author.filter(candidate=>matches(person,candidate));
      const localMatches = current.author.filter(candidate=>matches(person,candidate));
      return candidates.length === 1 && localMatches.length === 1 && !missingMetadata(candidates[0].affiliation)
        ? {...structuredClone(person),affiliation:structuredClone(candidates[0].affiliation)} : structuredClone(person);
    });
  }
  if (Buffer.byteLength(JSON.stringify(item),'utf8') > 256 * 1024) throw new Error('补全后的资料超过 256 KiB；请先缩短较长字段，再刷新资料。');
  return item;
}

async function lookupMetadata(request, options, { forCitation = false, current } = {}) {
  if (typeof request.id !== 'string' || !request.id || request.id.length > 200) throw new Error('请选择一篇文献，再刷新资料。');
  current ??= await core({action:'get',id:request.id},options);
  const doi = canonicalDOI(current.DOI);
  const url = typeof current.URL === 'string' ? current.URL.trim() : '';
  let pdfLink = isDirectPDFURL(url);
  const publishedOnly = Boolean(current['container-title']) || ['article-journal','paper-conference','chapter','book'].includes(current.type);
  let arxivHint;
  if (pdfLink) try { arxivHint = arxivID(url); } catch { /* Unusable URLs are not lookup targets. */ }
  let target = doi || (!pdfLink && url) || arxivHint || (String(current.archive||'').toLowerCase()==='arxiv'&&current.archive_location);
  let detected=false;
  const warnings = [];
  if(!target&&!pdfLink&&current.pdf){
    try {
      const probe=await core({action:'metadata_probe',id:request.id},options);
      target=probe.doi||probe.arxiv;detected=Boolean(target);
    } catch (error) {
      options.signal?.throwIfAborted();
      warnings.push(`未能从本地 PDF 核对标识符：${String(error.message).slice(0,160)}`);
    }
  }
  const allowTitle = !forCitation || Boolean(current['container-title'] || current.parse?.verified);
  if (!target && !allowTitle) throw new Error('请在资料详情中填写缺失项，或添加 DOI／公开论文链接以补全。');
  const fetchOptions={timeoutMs:21000,...options.fetchOptions,signal:options.signal};
  const targetOptions=!doi&&allowTitle ? {...fetchOptions,timeoutMs:Math.min(fetchOptions.timeoutMs,8000)} : fetchOptions;
  let result=target?await resolveMetadata(target,targetOptions):{ warnings, provenance:{ kind:'metadata-refresh', requests:[] } };
  pdfLink ||= Boolean(result.pdf_url && target === url);
  const identity = normalizedIdentity(current.title);
  const fitsTitle = item => identity.length >= 8 && normalizedIdentity(item?.title) === identity;
  const fitsEdition = item => !publishedOnly || Boolean(item?.['container-title']) || (item?.type && item.type !== 'article');
  if (detected && (!fitsTitle(result.metadata) || !fitsEdition(result.metadata))) result.metadata=undefined;
  // A PDF URL, an unavailable landing page, or a landing page without a DOI
  // must not prevent the registered-title search for this one work.
  if (!doi && allowTitle && (!result.metadata?.DOI || !fitsTitle(result.metadata) || !fitsEdition(result.metadata))) {
    try {
      const byTitle = await resolveTitleMetadata(current.title,{...fetchOptions,publishedOnly});
      if (fitsTitle(byTitle.metadata) && fitsEdition(byTitle.metadata)) result=byTitle;
      else result = {...result, warnings:[...(result.warnings||[]),...byTitle.warnings]};
    } catch (error) {
      options.signal?.throwIfAborted();
      result.warnings = [...(result.warnings||[]),String(error.message).slice(0,160)];
    }
  }

  if (!result.metadata && target && options.translationServer) {
    // Optional loopback Zotero translation-server: translators supply candidate
    // metadata for identifiers/pages the primary path could not resolve. The
    // same identity gates apply; candidates that fail them are discarded.
    try {
      const client = createTranslationServerClient(typeof options.translationServer === 'string' ? { url: options.translationServer } : options.translationServer);
      const candidates = await client.lookup(target);
      const matched = candidates.find(item => doi ? canonicalDOI(item.DOI) === doi : normalizedIdentity(current.title).length >= 8 && normalizedIdentity(item.title) === normalizedIdentity(current.title));
      if (matched) {
        result.metadata = matched;
        result.warnings = [...(result.warnings || []), '元数据候选来自本机 translation-server，已通过身份核对。'];
        result.provenance = { target, provider: 'translation-server', fetched_at: new Date().toISOString() };
      } else if (candidates.length) {
        result.warnings = [...(result.warnings || []), 'translation-server 返回的条目未能通过 DOI 或题名核对，未采用。'];
      } else {
        result.warnings = [...(result.warnings || []), 'translation-server 没有找到可用条目。'];
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      result.warnings = [...(result.warnings || []), `translation-server 不可用：${String(error.message).slice(0, 300)}`];
    }
  }
  if (!result.metadata) {
    const error = new Error(`未取得可用文献资料。请核对题名、DOI 或正式出版页面，也可以手工编辑。${result.warnings?.length?' '+result.warnings.join('；'):''}`);
    if (pdfLink) error.code = 'CITATION_PDF_LINK';
    throw error;
  }
  // Network latency must not put an older manual edit back into the editor.
  const latest = await core({action:'get',id:request.id},options);
  if (canonicalDOI(latest.DOI) !== doi || !doi && (latest.URL !== current.URL || latest.title !== current.title)) throw new Error('获取期间 DOI 或论文链接发生变化；请按最新资料重新刷新。');
  current = latest;
  if (doi) {
    if (canonicalDOI(result.metadata.DOI) !== doi) throw new Error('在线资料的 DOI 与当前文献不一致，未生成补全草稿；请核对当前 DOI。');
  } else {
    const title = normalizedIdentity(current.title);
    if (title.length < 8 || title !== normalizedIdentity(result.metadata.title)) throw new Error('在线题名与当前文献不能准确匹配，未生成补全草稿；请核对题名，或保存 DOI 后重试。');
  }
  const fetched = result.metadata;
  if (!fitsEdition(fetched)) {
    throw new Error('检索结果未能确认当前出版出处，请核对已发表版本的 DOI 或链接。');
  }
  if (forCitation && doi && fetched.title && normalizedIdentity(current.title) && normalizedIdentity(current.title) !== 'untitled' &&
      normalizedIdentity(current.title) !== normalizedIdentity(fetched.title)) {
    throw Object.assign(new Error('DOI 登记题名与当前文献不一致，请在资料详情核对。'), { code: 'CITATION_IDENTITY_CONFLICT' });
  }
  const item = metadataDraft(current, fetched);
  if (forCitation) {
    if (pdfLink && fetched.URL && !isDirectPDFURL(fetched.URL)) item.URL = fetched.URL;
    if (fetched.type && fetched.type !== 'article' &&
        (!current.type || current.type === 'article' || current.parse?.field_sources?.type === 'default-record-type')) item.type = fetched.type;
    if (current.title === 'Untitled' && fetched.title) item.title = fetched.title;
    if (current.parse?.field_sources?.author === 'pdf-info-author-literal' && fetched.author?.length) {
      item.author = fetched.author;
    } else if (Array.isArray(item.author) && fetched.author?.length) {
      item.author = item.author.map(person => {
        if (!person.literal || person.family) return person;
        const matches = fetched.author.filter(candidate => candidate.family && authorIdentities(candidate).includes(normalizedIdentity(person.literal)));
        if (matches.length !== 1) return person;
        const { literal, ...rest } = person;
        const { given, family, suffix } = matches[0];
        return { given, family, suffix, ...rest };
      });
    }
  }
  return {item,author_candidates:fetched.author||[],warnings:result.warnings || [],provenance:result.provenance};
}

/** Parse one reply per annotation. Returns null when the model answered with a
 * single combined text, so the caller can store it once instead of duplicating. */
export function splitFeedbackReplies(text, annotations) {
  const ids = annotations.map(annotation => annotation.id);
  const allowed = new Set(ids);
  const raw = String(text).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  const list = Array.isArray(value) ? value : Array.isArray(value?.replies) ? value.replies : null;
  if (!list) return null;
  if (!list.length || list.length > ids.length) throw new Error('模型返回的逐条回复数量与所选批注不符；未写入任何内容。');
  const seen = new Set(), replies = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('模型返回的逐条回复格式无效；未写入任何内容。');
    const annotation_id = item.annotation_id ?? item.annotationId ?? item.id;
    const comment = item.comment ?? item.text ?? item.reply;
    if (typeof annotation_id !== 'string' || !allowed.has(annotation_id)) throw new Error('模型回复引用了本次未提供的批注；未写入，以免回复错配。');
    if (typeof comment !== 'string' || !comment.trim()) throw new Error('模型返回了空回复；未写入任何内容。');
    if (comment.length > 8000) throw new Error('单条回复超过 8000 字符上限；未写入任何内容。');
    if (seen.has(annotation_id)) throw new Error('模型对同一条批注返回了多条回复；未写入任何内容。');
    seen.add(annotation_id);
    replies.push({ annotation_id, comment: comment.trim() });
  }
  return { replies, missing: ids.filter(id => !seen.has(id)) };
}

export async function dispatch(request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('请求必须是 JSON 对象。');
  const { library: ignoredLibrary, python: ignoredPython, ...safe } = request;
  if (safe.action === 'paper_reveal') {
    if (typeof safe.id !== 'string' || !safe.id || safe.id.length > 200) throw Error('请先选择一篇附有 PDF 的文献。');
    const file = await core({ action: 'export_pdf', id: safe.id }, options);
    return revealPDF(file.path, { signal: options.signal });
  }
  if (['handwriting_get','handwriting_save','linked_handwriting_text'].includes(safe.action)) {
    if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > 512 * 1024) throw new Error('手写便签超过 512 KiB，请缩短笔迹或文字。');
    return core(safe, options);
  }
  if (['paper_analysis_sources','paper_analysis_batch','paper_analysis_apply_metadata','companion_excerpt'].includes(safe.action)) {
    if (Buffer.byteLength(JSON.stringify(safe)) > 128 * 1024) throw new Error('所选论文整理请求超过预算。');
    return core(safe,options);
  }
  if (challengeActions.has(safe.action)) {
    // P1 scans PDFs; P3 aggregates saved drafts and writes exports/. Both are
    // explicit-scope requests, so the same 128 KiB admission guard applies.
    if (Buffer.byteLength(JSON.stringify(safe)) > 128 * 1024) throw new Error('难点请求超过预算；请缩小所选文献范围。');
    return core(safe, options);
  }
  if (libraryActions.has(safe.action) || safe.action === 'dataset_cite') {
    if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > 1024 * 1024) throw new Error('库请求超过 1 MiB；请缩小选中材料。');
    if (safe.action === 'dataset_cite') {
      const result = await core({action:'dataset_cite',id:safe.id,release_id:safe.release_id},options);
      return { ...await citationJob({action:'cite',items:[result.item],format:safe.format || 'apa'},options), warnings:result.warnings || [] };
    }
    return core(safe, options);
  }
  if (safe.action === 'metadata_lookup') return lookupMetadata(safe,options);
  if (safe.action === 'models') return options.models ? options.models(options.signal) : { models: [], configured: false };
  if (safe.action === 'bibliography_build') {
    // Canonical on-disk bibliography + factual audit. Verification is explicit,
    // bounded and read-only: online records are compared, never written back.
    const kind = safe.include_datasets === false ? 'paper' : 'all';
    const verify = safe.verify === true;
    const verifyLimit = safe.verify_limit === undefined ? 25 : safe.verify_limit;
    if (!Number.isSafeInteger(verifyLimit) || verifyLimit < 1 || verifyLimit > 100) throw new Error('核验条数须为 1–100 的整数。');
    const texts = []; const items = []; let offset = 0, revision, bytes = 0;
    while (true) {
      const page = await core({ action:'resource_export', offset, limit:100, kind, ...(revision===undefined?{}:{expected_catalog_revision:revision}) }, options);
      revision = page.catalog_revision;
      bytes += Buffer.byteLength(JSON.stringify(page.items),'utf8');
      if (bytes > 24*1024*1024) throw new Error('引用目录超过 24 MiB，请先缩小条目资料。');
      items.push(...page.items);
      if (page.items.length) texts.push((await citationJob({ action:'cite', items:page.items, format:'biblatex' }, options)).text);
      if (page.done) break;
      if (!Number.isInteger(page.next_offset) || page.next_offset <= offset) throw new Error('引用目录分页未推进，构建已停止。');
      offset = page.next_offset;
    }
    if (!items.length) throw new Error('文献库为空，无法构建引用库。');
    const audit = await core({ action:'bibliography_audit' }, options);
    // Field-level comparison keeps every differing value explicit: catalog and
    // online values are both recorded, and a conflict never writes back.
    const compareField = (catalogValue, onlineValue, normalize) => {
      const catalog = String(catalogValue ?? '').trim(), online = String(onlineValue ?? '').trim();
      const c = normalize(catalog), o = normalize(online);
      if (!c && !o) return { validation_status: 'missing-both' };
      if (!c) return { validation_status: 'missing-catalog', online: online.slice(0, 300) };
      if (!o) return { validation_status: 'missing-online', catalog: catalog.slice(0, 300) };
      // Values are compared normalized but reported as stored/registered.
      return c === o ? { validation_status: 'match' } : { validation_status: 'conflict', catalog: catalog.slice(0, 300), online: online.slice(0, 300) };
    };
    const firstAuthor = value => Array.isArray(value) && value.length ? normalizedIdentity(value[0]?.family || value[0]?.literal || '') : '';
    const issuedYear = value => Number.isInteger(value?.['date-parts']?.[0]?.[0]) ? String(value['date-parts'][0][0]) : '';
    const verification = { requested: verify, checked: 0, provider_confirmed: 0, conflict: 0, unavailable: 0, results: [] };
    if (verify) {
      const candidates = items.filter(item => item.resource_kind === 'paper' && typeof item.DOI === 'string' && canonicalDOI(item.DOI));
      for (const item of candidates.slice(0, verifyLimit)) {
        options.signal?.throwIfAborted();
        const doi = canonicalDOI(item.DOI);
        const entry = { id: item.external_id, citekey: item['citation-key'] || item.id, doi, checked_at: new Date().toISOString() };
        try {
          const found = await resolveMetadata(doi, { ...options.fetchOptions, signal: options.signal });
          const online = found.metadata;
          const sourceUrl = found.provenance?.requests?.find(request => request.kind === 'metadata')?.url;
          try { entry.source = sourceUrl ? new URL(sourceUrl).hostname : undefined; } catch {}
          if (!online || canonicalDOI(online.DOI) !== doi) { entry.validation_status = 'unavailable'; verification.unavailable++; }
          else {
            entry.fields = [
              { field: 'title', ...compareField(item.title, online.title, normalizedIdentity) },
              { field: 'year', ...compareField(issuedYear(item.issued), issuedYear(online.issued), value => value) },
              { field: 'container-title', ...compareField(item['container-title'], online['container-title'], normalizedIdentity) },
              { field: 'first-author', ...compareField(firstAuthor(item.author), firstAuthor(online.author), value => value) },
            ];
            entry.validation_status = entry.fields.some(field => field.validation_status === 'conflict') ? 'conflict' : 'provider-confirmed';
            verification[entry.validation_status === 'conflict' ? 'conflict' : 'provider_confirmed']++;
          }
        } catch (error) { entry.validation_status = 'unavailable'; entry.error = String(error.message).slice(0, 300); verification.unavailable++; }
        verification.results.push(entry);
        verification.checked++;
      }
      verification.truncated = candidates.length > verifyLimit;
      verification.remaining = Math.max(0, candidates.length - verifyLimit);
    }
    const report = { ...audit, verification, bibliography: { count: items.length, kind } };
    const written = await core({ action:'bibliography_write', bib_text: texts.join('\n'), audit: report }, options);
    return { count: items.length, kind, ...written,
      conflicts: audit.citekey_conflict_count, doi_duplicates: audit.doi_duplicate_count,
      missing: Object.fromEntries(Object.entries(audit.missing).map(([field, value]) => [field, value.count])),
      actionable: { lookup_by_url: audit.actionable.lookup_by_url.count, manual_only: audit.actionable.manual_only.count },
      pdf_missing: audit.totals.pdf_files_missing, verification,
      warnings: ['references.bib 保存引用元数据；文件、使用关联与知识正文不属于此格式。', ...(verification.truncated ? [`DOI 核验覆盖前 ${verifyLimit} 条，剩余 ${verification.remaining} 条未核验；请分批再次运行。`] : [])] };
  }
  if (safe.action === 'export_library') {
    const format = safe.format || 'biblatex';
    if (!['biblatex','csl-json'].includes(format)) throw new Error('整库导出支持 BibLaTeX 或 CSL JSON。');
    const texts = []; const records = []; let count = 0;
    let offset=0, revision, bytes=0;
    while (true) {
      const page = await core({action:'resource_export',offset,limit:100,...(revision===undefined?{}:{expected_catalog_revision:revision})}, options);
      revision=page.catalog_revision;
      const items=page.items;
      bytes+=Buffer.byteLength(JSON.stringify(items),'utf8');
      if(bytes>24*1024*1024) throw new Error('引用目录导出超过 24 MiB，请缩小条目资料。');
      count+=items.length;
      if(format==='csl-json') records.push(...items);
      else if(items.length) texts.push((await citationJob({action:'cite',items,format},options)).text);
      if(page.done) break;
      if(!Number.isInteger(page.next_offset)||page.next_offset<=offset) throw new Error('引用目录分页未推进，导出已停止。');
      offset=page.next_offset;
    }
    return {text:format==='csl-json'?JSON.stringify(records,null,2):texts.join('\n'),filename:format==='csl-json'?'library.json':'library.bib',mime:format==='csl-json'?'application/json':'application/x-bibtex',count,scope:'citation-metadata',warnings:format==='biblatex'?['BibLaTeX 保存引用信息；数据系列映射、文件、使用关联与知识正文不属于此格式。']:['CSL JSON 保存引用与数据版本身份；文件、使用关联与知识正文不属于此导出。']};
  }
  if (safe.action === 'cite') {
    if (!Array.isArray(safe.ids) || safe.ids.length < 1 || safe.ids.length > 500) throw new Error('请选择 1–500 篇文献。');
    if (safe.format === 'apa' && safe.prepare_metadata === true) {
      if (safe.ids.length !== 1) throw new Error('请逐篇核对并复制 APA 7 引用。');
      const [id] = safe.ids;
      let item = await core({ action: 'get', id }, options), lookupMessage = '', pdfLink = false;
      if (apaCopyReadiness(item).lookup || (!item.DOI && isDirectPDFURL(item.URL))) {
        try { ({ item } = await lookupMetadata({ id }, options, { forCitation: true, current: item })); }
        catch (error) {
          options.signal?.throwIfAborted();
          if (error.code === 'CITATION_IDENTITY_CONFLICT') throw error;
          pdfLink = error.code === 'CITATION_PDF_LINK';
          lookupMessage = String(error.message).slice(0, 300);
          // Use the latest local data even if an online source was unavailable.
          item = await core({ action: 'get', id }, options);
        }
      }
      const { missing } = apaCopyReadiness(item);
      if (!item.DOI && (pdfLink || isDirectPDFURL(item.URL))) missing.push('DOI 或已核对的出版页面');
      if (missing.length) return { prepared: true, missing_fields: missing, lookup_message: lookupMessage };
      const result = await citationJob({ action:'cite', items:[item], format:'apa' }, options);
      return { ...result, prepared: true };
    }
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
    const common = { id: safe.id, model: `${provider}/${model}`, annotation_ids: ids, expected_context_hash: context.context_hash };
    if (context.annotations.length > 1) {
      // Several annotations were asked about together: each answer must land under
      // the annotation it addresses. A combined answer is saved once, never copied.
      const split = splitFeedbackReplies(text, context.annotations);
      if (!split) {
        const combined = await core({ action: 'save_feedback', text, ...common }, options);
        return { ...combined, combined: true, warnings: [...(combined.warnings || []), '模型没有按批注分别回复；已保存为一条合并反馈，没有复制到每条批注。'] };
      }
      const saved = await core({ action: 'save_feedback', replies: split.replies, ...common }, options);
      return { ...saved, ...(split.missing.length ? { warnings: [...(saved.warnings || []), `${split.missing.length} 条批注没有获得对应回复；可重新生成补齐。`] } : {}) };
    }
    return core({ action: 'save_feedback', text, ...common }, options);
  }
  if (!actions.has(safe.action) && !projectActions.has(safe.action) && !externalActions.has(safe.action) && !latexActions.has(safe.action)) throw new Error('未知文献操作。');
  if (safe.action === 'import') {
    const sources=['path','doi','url','items','content_base64'].filter(key=>safe[key]!==undefined && safe[key]!==null && safe[key]!=='');
    if(sources.length!==1) throw new Error('请提供一种导入来源：PDF/文件路径、链接、DOI、元数据或上传文件。');
    const result=await enqueueImport(safe, options);
    if(options.onImported){try{result.analysis_queue=await options.onImported(result.items||[]);for(const item of result.analysis_queue||[])if(item.status==='failed')result.warnings=[...(result.warnings||[]),`文献已导入，自动整理未排队：${item.error}`]}catch(error){result.warnings=[...(result.warnings||[]),`文献已导入，自动整理未排队：${error.message}`]}}
    return result;
  }
  const result=await core(safe, options);
  if(safe.action==='attach'&&options.onImported){try{result.analysis_queue=await options.onImported([result])}catch(error){result.analysis_queue=[{status:'failed',error:error.message}]}}
  return result;
}
