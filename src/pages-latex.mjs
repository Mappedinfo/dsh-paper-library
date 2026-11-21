import { lstat, mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

const prefix = '/api/pages/latex/';
const methods = new Map([
  ['projects', 'GET'], ['create', 'POST'], ['tree', 'POST'], ['read', 'POST'],
  ['write', 'POST'], ['compile', 'POST'], ['preview', 'POST'],
]);
const maxSourceBytes = 1024 * 1024;

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function projectBinding(input) {
  if (typeof input.id !== 'string' || !/^lt-[0-9a-f]{12}$/.test(input.id)
      || !Number.isSafeInteger(input.generation) || input.generation < 0) {
    invalid('请重新打开项目以确认文件夹。');
  }
  return { id: input.id, expected_binding_generation: input.generation };
}

function sourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\:\x00-\x1f]/u.test(value)
      || value.split('/').some(part => !part || part.startsWith('.'))) {
    invalid('请选择项目内的相对源文件路径。');
  }
  return value;
}

async function createProject(input, { library, run }) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 200) invalid('项目名称应为 1–200 个字符。');
  const parent = join(library, 'manuscripts');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!(await lstat(parent)).isDirectory()) invalid('库内 manuscripts 必须是本地目录。');
  const folder = await mkdtemp(join(parent, 'draft-'));
  try {
    return await run('latex_project_create', { root: folder, title, create_missing: true });
  } catch (error) {
    // 只回收空目录；已落盘的稿件可由用户在本机找回。
    await rmdir(folder).catch(() => {});
    throw error;
  }
}

/** Only expose the source editor, revision-checked saves, an explicit local build and a single preview page. */
export async function handleLatex(request, context) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(prefix)) return null;
  const operation = path.slice(prefix.length);
  const method = methods.get(operation);
  if (!method) return null;
  if (request.method !== method) return Response.json({ error: '请求方法不支持。' }, { status: 405, headers: { Allow: method } });
  const { run } = context;
  if (operation === 'projects') return Response.json(await run('latex_project_list', { limit: 200 }));
  const maxBytes = operation === 'write' ? 6 * maxSourceBytes + 4096 : 8192;
  const input = await context.readJson(request, maxBytes);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('需要 JSON 对象。');
  if (operation === 'create') return Response.json(await createProject(input, context), { status: 201 });
  const binding = projectBinding(input);
  if (operation === 'tree') {
    const result = await run('latex_tree', binding);
    return Response.json({ files: result.files.filter(item => item.kind === 'text'
      && !item.path.split('/').some(part => part.startsWith('.'))).map(item => item.path),
      main_path: result.main_path, truncated: result.truncated });
  }
  if (operation === 'read') return Response.json(await run('latex_read', { ...binding, path: sourcePath(input.path) }));
  if (operation === 'write') {
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > maxSourceBytes) invalid('单个源文件最多 1 MiB。');
    // An empty revision is create-only. The worker rejects it if any file already exists.
    if (typeof input.revision !== 'string' || (input.revision !== '' && !/^[a-f0-9]{64}$/.test(input.revision))) {
      invalid('请先打开源文件，保存时需要已读取的修订号。');
    }
    return Response.json(await run('latex_write', { ...binding, path: sourcePath(input.path),
      content: input.content, expected_revision: input.revision, origin: 'reader' }));
  }
  if (operation === 'compile') {
    if (!['xelatex', 'pdflatex', 'lualatex'].includes(input.engine)) invalid('请选择可用的 TeX 引擎。');
    return Response.json(await run('latex_compile', { ...binding, engine: input.engine, local_web: true }));
  }
  if (!Number.isSafeInteger(input.page) || input.page < 1) invalid('页码必须是正整数。');
  const { image, page, page_count } = await run('latex_pdf_page', { ...binding, page: input.page, scale: 1.25 });
  return Response.json({ image, page, page_count });
}
