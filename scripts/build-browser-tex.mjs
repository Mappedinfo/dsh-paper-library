import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { texBundles } from '../site/library/latex-compile.js';

const exec = promisify(execFile);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const release = 'mp-tikz-wasm-0.5.1';
const packages = [
  { name: release + '.tar.gz', digest:'af79f8cab30248a36e0ac88a859a8f733d8eb02443c7f66d75a716fd08cdb077',
    urls:['https://github.com/jmckalex/mp-tikz-wasm/releases/download/v0.5.1/mp-tikz-wasm-0.5.1.tar.gz'] },
  { name: 'NotoSansSC-Regular.otf', digest:'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9',
    urls:['https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf'] },
  { name: release + '-source.tar.gz', digest:'631fa1710ae8c73e15220dc5f0badb45f3c49fee76f955f6102665df0ef58f9b',
    urls:['https://codeload.github.com/jmckalex/mp-tikz-wasm/tar.gz/refs/tags/v0.5.1'] },
  { name: 'texlive-20250308-source.tar.xz', digest:'fffdb1a3d143c177a4398a2229a40d6a88f18098e5f6dcfd57648c9f2417490f',
    urls:['https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/texlive-20250308-source.tar.xz',
      'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/texlive-20250308-source.tar.xz'] },
];

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function acquire(dir, { name, digest: expected, urls }) {
  const file = join(dir, name);
  try { if (await digest(file) === expected) return file; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const part = join(dir, randomUUID() + '.part');
  try {
    let last;
    for (const url of urls) {
      try {
        await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
          '--retry', '2', '--retry-all-errors', '--connect-timeout', '10', '--max-time', '600', '--output', part, url]);
        if (await digest(part) !== expected) throw new Error('SHA-256 mismatch: ' + name);
        await rename(part, file);
        return file;
      } catch (error) { last = error; }
    }
    throw last;
  } finally { await rm(part, { force:true }); }
}

/** 从固定上游构建同源静态资源。资料库、用户目录和本机字体都不在构建输入中。 */
export async function buildBrowserTex(outDir) {
  const cache = process.env.PAPER_LIBRARY_TEX_CACHE || join(tmpdir(), 'paper-library-tex-0.5.1');
  await mkdir(cache, { recursive:true });
  const [archive, font, source, texSource] = await Promise.all(packages.map(item => acquire(cache, item)));
  const work = await mkdtemp(join(cache, 'extract-'));
  const target = join(outDir, 'tex-engine');
  try {
    await exec('tar', ['-xzf', archive, '-C', work]);
    const upstream = join(work, release);
    const dist = join(upstream, 'dist'), dest = join(target, 'dist');
    await mkdir(join(dest, 'bundles'), { recursive:true });
    // Restrict the engine, macro, and font distribution to the modules used by the editor.
    const modules = ['mplib.mjs','mplib.wasm','tex.mjs','tex.wasm','luatex.mjs','luatex.wasm','dvisvgm.mjs','bibtex.mjs','bibtex.wasm'];
    for (const name of await readdir(dist)) {
      if ((name.endsWith('.js') && !['cli.js','auto.js','prerender.js'].includes(name)) || modules.includes(name)) {
        await cp(join(dist, name), join(dest, name));
      }
    }
    for (const name of ['vfs','tex','render']) {
      await cp(join(dist,name), join(dest,name), { recursive:true, filter:path => !path.endsWith('.d.ts') });
    }
    for (const bundle of [...texBundles, 'luatex', 'opentype', 'hot.json']) {
      await cp(join(dist,'bundles',bundle), join(dest,'bundles',bundle), { recursive:true });
    }
    await mkdir(join(target,'bibstyles'), { recursive:true });
    for (const name of ['plain','alpha','abbrv','unsrt']) {
      await cp(join(dist,'bundles/latex-doc/files/bibtex/bst/base',name + '.bst'),join(target,'bibstyles',name + '.bst'));
    }
    await cp(font,join(target,'NotoSansSC-Regular.otf'));
    await cp(join(project,'vendor/browser-tex'),target,{recursive:true});
    await cp(join(upstream,'LICENSE'), join(target,'licenses/mp-tikz-wasm-LICENSE.txt'));
    await cp(join(upstream,'NOTICE.md'), join(target,'NOTICE.md'));
    for (const name of ['GPL-3.0.txt','LGPL-3.0.txt']) {
      await cp(join(upstream,'licenses',name), join(target,'licenses',name));
    }
    await mkdir(join(target,'sources'), {recursive:true});
    await cp(source, join(target,'sources',release + '.tar.gz'));
    await cp(texSource, join(target,'sources',basename(texSource)));
    for (const name of ['latex.js','latex-compile.js','latex-worker.js','latex.css']) {
      await cp(join(project,'site/library',name), join(outDir,name));
    }
  } finally { await rm(work, {recursive:true, force:true}); }
  return target;
}
