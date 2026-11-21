const maxFileBytes = 1024 * 1024;
const maxProjectBytes = 32 * 1024 * 1024;
const maxInputs = 64;
const imageType = /\.(?:png|jpe?g)$/i;

function relativePath(name) {
  if (!name || /[\\:{}\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').includes('..')) return null;
  return name.split('/').filter(part => part && part !== '.').join('/');
}

function references(source, find) {
  // Only explicit project inputs enter the worker. Built-in packages resolve inside the static TeX tree.
  const visible = source.replace(/(?<!\\)%[^\r\n]*/g, '');
  for (const match of visible.matchAll(/\\(?:input|include)\s*(?:\{([^{}]+)\}|([^{}\s%]+))/g)) {
    find((match[1] || match[2]).trim(), ['tex']);
  }
  const extensions = { usepackage:'sty', RequirePackage:'sty', documentclass:'cls', LoadClass:'cls', bibliography:'bib', bibliographystyle:'bst' };
  for (const match of visible.matchAll(/\\(usepackage|RequirePackage|documentclass|LoadClass|bibliography|bibliographystyle)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)) {
    for (const name of match[2].split(',')) find(name.trim(), [extensions[match[1]]]);
  }
  const dirs = [''];
  for (const match of visible.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
    for (const item of match[1].matchAll(/\{([^{}]+)\}/g)) {
      const dir = relativePath(item[1].trim());
      if (dir && dirs.length < 16) dirs.push(dir + '/');
    }
  }
  for (const match of visible.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)) {
    const name = match[1].trim();
    if (/\.pdf$/i.test(name)) throw new Error('浏览器 TeX 支持 PNG、JPEG 配图。项目中的 PDF 配图请先导出为图片。');
    for (const dir of dirs) if (find(dir + name, ['png','jpg','jpeg'])) break;
  }
}

export async function collectTexInputs(store, path, source) {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > maxFileBytes) throw new Error('单个 TeX 文件最多支持 1 MiB。');
  const prefix = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const known = new Set((await store.list()).map(entry => entry.path));
  const files = Object.create(null), visited = new Set([path]), pending = [];
  let total = bytes;
  function find(raw, extensions) {
    const name = relativePath(raw);
    if (!name) return false;
    const candidates = /\.[^/]+$/.test(name) ? [name] : extensions.map(ext => name + '.' + ext);
    const found = candidates.find(file => known.has(prefix + file) && /\.(tex|bib|sty|cls|bst|def|cfg|clo|tikz|png|jpe?g)$/i.test(file));
    if (!found) return false;
    if (!visited.has(prefix + found)) {
      visited.add(prefix + found);
      if (visited.size > maxInputs) throw new Error('一次编译最多支持 64 个项目文件。');
      pending.push(found);
    }
    return true;
  }
  references(source, find);
  while (pending.length) {
    const name = pending.pop();
    const { blob } = await store.read(prefix + name);
    total += blob.size;
    const image = imageType.test(name);
    if (blob.size > (image ? 16 * maxFileBytes : maxFileBytes) || total > maxProjectBytes) {
      throw new Error('编译输入超过上限（单个源码 1 MiB、单张图片 16 MiB、合计 32 MiB）。');
    }
    files[name] = image ? new Uint8Array(await blob.arrayBuffer()) : await blob.text();
    if (!image && !/\.(?:bib|bst)$/i.test(name)) references(files[name], find);
  }
  return files;
}

export async function saveCompiledPdf(store, path, blob, confirmOverwrite) {
  let revision = null;
  if ((await store.list()).some(entry => entry.path === path)) {
    revision = (await store.read(path)).revision;
    if (!confirmOverwrite(path)) return false;
  }
  await store.write(path, blob, revision);
  return true;
}

export const texBundles = ['core', 'cm-tfm', 'cm-type1', 'lm-fonts', 'tex-plain', 'latex-core', 'latex-extra'];

export async function compileDocument({ source, files, engine }, { MetaPost, fontBytes, bibStyle }) {
  const lua = engine === 'lualatex';
  const bundles = lua ? [...texBundles, 'luatex', 'opentype'] : texBundles;
  const compiler = await MetaPost.create({ worker: false, bundles, ghostscript: false, logLevel: 'silent', prefetch: [lua ? 'lualatex' : 'latex'] });
  try {
    if (lua && [source, ...Object.values(files)].some(part => typeof part === 'string' && part.includes('NotoSansSC-Regular.otf'))) {
      await compiler.addFiles({ 'NotoSansSC-Regular.otf': await fontBytes() });
    }
    const options = { engine: lua ? 'lualatex' : 'latex', output: 'pdf', files, date: 'now' };
    let result = await compiler.latex(source, options);
    const aux = result.artifacts['doc.aux'];
    const auxText = aux && new TextDecoder().decode(aux);
    if (result.pdf && result.status === 'ok' && auxText?.includes('\\bibdata{')) {
      const style = /\\bibstyle\{([a-z]+)\}/.exec(auxText)?.[1];
      const extra = {};
      if (['plain', 'abbrv', 'unsrt', 'alpha'].includes(style) && !files[style + '.bst']) {
        extra[style + '.bst'] = await bibStyle(style);
      }
      const bib = await compiler.bibtex({ files: { ...files, ...extra, ...result.artifacts } });
      if (bib.status === 'error' || bib.status === 'fatal' || !bib.artifacts['doc.bbl']) {
        throw Object.assign(new Error('BibTeX 未能生成参考文献，请检查数据库和样式。'), { log: (bib.log || '').slice(-8000) });
      }
      options.files = { ...files, ...result.artifacts, 'doc.bbl': bib.artifacts['doc.bbl'] };
      result = await compiler.latex(source, options);
    }
    if (result.pdf && result.status === 'ok' && /Rerun to get|Label\(s\) may have changed|No file doc\.toc/i.test(result.texLog)) {
      result = await compiler.latex(source, { ...options, files: { ...options.files, ...result.artifacts } });
    }
    const log = (result.texLog || result.log || '').slice(-8000);
    const error = result.diagnostics?.find(item => item.severity === 'error');
    if (result.status !== 'ok' || !result.pdf?.length) {
      throw Object.assign(new Error(error?.message || 'TeX 未能生成 PDF，请查看编译日志。'), { log });
    }
    if (result.pdf.byteLength > 32 * 1024 * 1024) throw new Error('生成的 PDF 超过 32 MiB。');
    return { pdf: result.pdf, log };
  } finally { compiler.dispose(); }
}
