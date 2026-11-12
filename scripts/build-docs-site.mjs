/** Build the Paper Library documentation site for GitHub Pages.
 *
 * Every page is rendered from markdown that is already public in this repository, so the site
 * cannot claim a feature the plugin does not have. The landing page is generated from the same
 * manifest: a book only exists when a real document backs it, and its preview text is an actual
 * paragraph from that document.
 *
 * Output is `_site/docs/`, which sits beside the standalone whiteboard at the Pages root instead
 * of replacing it — the whiteboard URL is advertised in the README and must keep working.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const project = dirname(dirname(fileURLToPath(import.meta.url)));

/** Shelves are topics a reader actually browses, and every entry is a file in this repo. */
const SHELVES = [
  { id: 'start', title: '入门与社区', blurb: '安装、发布说明与社区展示', hue: 38 },
  { id: 'reading', title: '阅读与批注', blurb: 'PDF 原生批注、手写与阅读轨迹', hue: 16 },
  { id: 'library', title: '文献库与数据', blurb: '导入、元数据、数据集与知识工作流', hue: 168 },
  { id: 'analysis', title: 'AI 分析与雷达', blurb: '无界面分析、领域雷达与难点挖掘', hue: 268 },
  { id: 'board', title: '画板与论文流程', blurb: '多文献画板、流程与独立站点', hue: 200 },
  { id: 'latex', title: 'LaTeX 与 Slides', blurb: '工作台、自审、演示文稿导出', hue: 340 },
  { id: 'demo', title: '演示与案例', blurb: '可下载的公开演示与使用说明', hue: 48 },
  { id: 'ui', title: '工作台与导航', blurb: '布局、分栏与阅读项目导航', hue: 190 },
  { id: 'api', title: '接口与互操作', blurb: '操作契约、MCP 与外部系统边界', hue: 100 },
  { id: 'quality', title: '验证与质量', blurb: '检查清单与可复现的验证回执', hue: 12 },
];

/** Repo path -> shelf id. The build fails if a published markdown file is left unmapped. */
const SHELF_OF = {
  'README.md': 'start',
  'README.en.md': 'start',
  'docs/community/README.md': 'start',
  'docs/community/release-v0.1.0.md': 'start',
  'docs/community/release-v0.2.0.md': 'start',
  'docs/community/update-2026-11-06.md': 'start',
  'docs/community/showcase.md': 'start',
  'docs/community/showcase.en.md': 'start',
  'docs/pdf-annotation-variants.md': 'reading',
  'docs/ai-annotation-style.md': 'reading',
  'docs/annotation-reference-design.md': 'reading',
  'docs/handwriting-interaction-design.md': 'reading',
  'docs/reading-distribution.md': 'reading',
  'docs/reading-questions.md': 'reading',
  'docs/question-placement.md': 'reading',
  'docs/formula-detection.md': 'reading',
  'docs/library-datasets-knowledge-design.md': 'library',
  'docs/bulk-import-design.md': 'library',
  'docs/external-sources.md': 'library',
  'docs/pdf-metadata-audit.md': 'library',
  'docs/auto-parse-flow.md': 'library',
  'docs/headless-analysis.md': 'analysis',
  'docs/direct-model-probe.md': 'analysis',
  'docs/field-radar.md': 'analysis',
  'docs/field-radar-agent-import.md': 'analysis',
  'docs/gap-finder-design-review.md': 'analysis',
  'docs/research-challenge-mining-design.md': 'analysis',
  'docs/paper-review-skill-design.md': 'analysis',
  'docs/whiteboard-design.md': 'board',
  'docs/paper-flow.md': 'board',
  'docs/board-pages.md': 'board',
  'docs/docs-site.md': 'board',
  'docs/a local overleaf.md': 'latex',
  'docs/latex-projects.md': 'latex',
  'docs/latex-self-review.md': 'latex',
  'docs/latex-workbench-design-review.md': 'latex',
  'docs/slides-workbench.md': 'latex',
  'docs/demo/README.md': 'demo',
  'docs/demo/guide.md': 'demo',
  'docs/community/learning-demo.md': 'demo',
  'docs/community/handwriting-demo.md': 'demo',
  'docs/community/latex-demo.md': 'demo',
  'docs/ui-review-design.md': 'ui',
  'docs/workspace-navigation.md': 'ui',
  'docs/api.md': 'api',
  'docs/mcp.md': 'api',
  'docs/research-os-compatibility.md': 'api',
  'docs/upstream-manifest.md': 'api',
  'docs/validation.md': 'quality',
  'docs/validation/README.md': 'quality',
};

const REPO = 'https://github.com/mappedinfo/dsh-paper-library';
const SOURCE_REF = process.env.SITE_SOURCE_REF ?? 'main';

/** Files with non-text payloads that the pages link to; they are copied, not rendered. */
const COPY_DIRS = ['docs/images', 'docs/demo'];
const SKIP_IN_COPY = new Set(['.md', '.gitignore', '.gitattributes', '.DS_Store']);

function joinHref(path, anchor) {
  return `${path}${anchor}`;
}

function slugify(text) {
  const base = String(text)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return base || 'section';
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdown(dir) {
  const out = [];
  for (const entry of await readdir(join(project, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(path)));
    else if (entry.isFile() && extname(entry.name) === '.md') out.push(normalize(path).replace(/\\/g, '/'));
  }
  return out;
}

/** Site path of the rendered page, keeping the reader's URL short and predictable. */
function sitePathFor(repoPath) {
  if (repoPath === 'README.md') return 'readme.html';
  if (repoPath === 'README.en.md') return 'readme-en.html';
  const inDocs = repoPath.startsWith('docs/') ? repoPath.slice('docs/'.length) : repoPath;
  const dir = dirname(inDocs) === '.' ? '' : `${dirname(inDocs)}/`;
  const stem = basename(inDocs, '.md');
  const name = stem === 'README' ? 'index' : slugify(stem);
  return `${dir}${name}.html`;
}

/** Turn a markdown link into something a reader on GitHub Pages can actually follow. */
/**
 * A document may name a file of this very repository with an absolute URL. The site ships those
 * files itself, so follow them locally rather than sending the reader's browser across the network.
 */
const SELF_PREFIXES = [
  `${REPO}/blob/${SOURCE_REF}/`,
  `https://raw.githubusercontent.com/${REPO.slice(REPO.indexOf('/', 8) + 1)}/${SOURCE_REF}/`,
].map(prefix => prefix.toLowerCase());

function selfRepoPath(href) {
  const at = href.search(/[?#]/);
  const base = (at < 0 ? href : href.slice(0, at)).toLowerCase();
  for (const prefix of SELF_PREFIXES) {
    if (base.startsWith(prefix)) return href.slice(prefix.length);
  }
  return null;
}

function createLinkRewriter(pageRepoDir, targets, assets) {
  // Relative to the page's own file, so a page in a subdirectory reaches its neighbours with
  // `name.html` and the docs root with `../name.html`.
  const own = posix.dirname(sitePathFor(join(pageRepoDir, 'x.md')));
  const rel = site => posix.relative(own, site);
  return (rawHref) => {
    const input = String(rawHref ?? '').trim();
    const self = selfRepoPath(input);
    if (!input || (self === null && (input.startsWith('#') || /^[a-z][a-z\d+\-.]*:/i.test(input) || input.startsWith('//')))) return input;
    const href = self ?? input;
    const cut = href.search(/[#?]/);
    const pathPart = cut < 0 ? href : href.slice(0, cut);
    const anchor = cut < 0 ? '' : href.slice(cut);
    let decoded = pathPart;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      /* keep the raw form when a path is not percent-encoded */
    }
    const target = posix.normalize(self === null ? posix.join(pageRepoDir, decoded) : decoded).replace(/^\.\//, '');
    if (targets.has(target)) return joinHref(rel(targets.get(target)), anchor);
    if (assets.has(target)) return joinHref(rel(posix.join('_assets', posix.relative('docs', assets.get(target)))), anchor);
    if (/^docs\/.+/.test(target) && !target.endsWith('.md')) {
      // A file inside docs/ that we neither render nor copy (for example a JSON sidecar).
      return `${REPO}/blob/${SOURCE_REF}/${target}`;
    }
    // Everything else is repository content the site does not publish: send the reader to the source.
    return `${REPO}/blob/${SOURCE_REF}/${target}${/\.md$/i.test(target) ? '' : anchor}`;
  };
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|table|pre)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A stop inside a date, a version or a commit hash is not the end of a sentence, so a Latin mark
// only counts when whitespace follows it.
const SENTENCE = /(?<=[。！？；])|(?<=[.!?;])\s+/;

function pickSentence(text, minLength) {
  const parts = String(text).split(SENTENCE).map(part => part.trim()).filter(Boolean);
  return parts.find(part => part.length >= minLength) ?? parts[0] ?? String(text).slice(0, minLength);
}

/**
 * Render one markdown file.
 *
 * The heading renderer both injects anchor ids (so a heading is a linkable address) and records
 * them, which is what the table of contents and the search index are built from.
 */
async function renderPage(repoPath, targets, assets) {
  const source = await readFile(join(project, repoPath), 'utf8');
  const pageRepoDir = dirname(repoPath).replace(/\\/g, '/');
  const rewrite = createLinkRewriter(pageRepoDir === '.' ? '' : pageRepoDir, targets, assets);
  const headings = [];
  const used = new Map();
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading(token) {
        const inline = this.parser.parseInline(token.tokens);
        const text = stripHtml(inline);
        const stem = slugify(text);
        const count = used.get(stem) ?? 0;
        used.set(stem, count + 1);
        const id = count === 0 ? stem : `${stem}-${count}`;
        if (token.depth <= 3) headings.push({ id, text, depth: token.depth });
        return `<h${token.depth} id="${id}"><a class="dl" href="#${id}" aria-label="复制到此处的链接">#</a>${inline}</h${token.depth}>\n`;
      },
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        const href = rewrite(token.href);
        const external = /^[a-z][a-z\d+\-.]*:/i.test(href);
        const title = token.title ? ` title="${String(token.title).replace(/"/g, '&quot;')}"` : '';
        return `<a href="${href}"${title}${external ? ' rel="noopener noreferrer" target="_blank"' : ''}>${label}</a>`;
      },
      image(token) {
        const href = rewrite(token.href);
        const alt = escapeHtml(stripHtml(String(token.text ?? '')));
        // A badge drawn by someone else's server would make the reader ask that server for help; the label says the same thing.
        if (/^https?:/i.test(href)) return `<span class="badge">${alt}</span>`;
        return `<img src="${href}" alt="${alt}" loading="lazy">`;
      },
    },
  });
  const parsedBody = await marked.parse(source);
  const first = headings[0];
  const trimmed = parsedBody.replace(/^\s+/, '');
  // A post that opens on its own heading would say the title twice if we also injected one, so that
  // heading is promoted to the page h1 and stops counting as a section.
  const openTag = first && first.depth > 1 ? `<h${first.depth} id="${first.id}">` : null;
  let body = parsedBody;
  let opensOnHeading = /^<h1[\s>]/.test(trimmed);
  if (openTag && trimmed.startsWith(openTag)) {
    const closeTag = `</h${first.depth}>`;
    const end = trimmed.indexOf(closeTag);
    if (end > -1) {
      body = `<h1 class="doc-title" id="${first.id}">${trimmed.slice(openTag.length, end)}</h1>${trimmed.slice(end + closeTag.length)}`;
      headings.shift();
      opensOnHeading = true;
    }
  }
  const plain = stripHtml(body);
  const firstParagraph = body.match(/<p>[\s\S]*?<\/p>/)?.[0] ?? '';
  const preview = stripHtml(firstParagraph).replace(/^!\[[^\]]*\]\([^)]*\)\s*/, '');
  // A release note opens on a bold status line and then lists sections; that line names the page, its first section does not.
  const boldLead = opensOnHeading ? null : trimmed.match(/^<p><strong>([^<]{2,60})<\/strong>/)?.[1];
  const title = boldLead ?? first?.text ?? basename(repoPath, '.md');
  const words = plain.length;
  const toc = headings.filter(heading => heading.depth >= 2);
  // The opened book quotes prose only: a heading, its permalink glyph or a table cell is not read text.
  const prose = stripHtml(body.replace(/<h\d[^>]*>[\s\S]*?<\/h\d>/gi, ' ')).replace(/\s+/g, ' ').trim();
  // A book is only opened for reading when the document really has that opening text.
  const read = pickSentence(prose.slice(0, 900), 260) === prose.slice(0, 900)
    ? prose.slice(0, 420)
    : prose.slice(0, 420).replace(/[^。！？；.!?;]\s*$/, '');
  return {
    repoPath,
    title,
    // The README carries its own title inside a centered block, so only pages with no h1 at all get one.
    titleBlock: /<h1[\s>]/.test(body) ? '' : `<h1 class="doc-title">${escapeHtml(title)}</h1>`,
    headings,
    toc,
    body,
    plain,
    preview: preview || '见正文。',
    read: read || preview || '见正文。',
    highlight: pickSentence(preview, 28),
    note: pickSentence(prose.replace(preview, '').trim() || preview, 18),
    words,
    mins: Math.max(1, Math.round(words / 420)),
    sections: toc.filter(heading => heading.depth === 2).length,
    sourceUrl: `${REPO}/blob/${SOURCE_REF}/${repoPath}`,
  };
}

async function copyAssets(siteDocs) {
  const assets = new Map();
  const copied = [];
  for (const dir of COPY_DIRS) {
    const abs = join(project, dir);
    if (!(await exists(abs))) continue;
    const walk = async (current, relBase) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const repoPath = posix.join(relBase, entry.name);
        if (entry.isDirectory()) {
          await walk(join(current, entry.name), repoPath);
          continue;
        }
        if (!entry.isFile() || extname(entry.name) === '.md' || SKIP_IN_COPY.has(entry.name)) continue;
        // `docs/images/x.jpg` and `docs/demo/x.pdf` are published under `_assets/`, keeping the
        // part below `docs/` so a page can still find a file by the name it used in markdown.
        const published = posix.relative('docs', repoPath);
        const dest = join(siteDocs, '_assets', published);
        await mkdir(dirname(dest), { recursive: true });
        await cp(join(current, entry.name), dest);
        assets.set(repoPath, repoPath);
        copied.push(posix.join('_assets', published));
      }
    };
    await walk(abs, dir);
  }
  return { assets, copied };
}

export async function buildDocsSite({ outDir } = {}) {
  const siteDocs = join(outDir ?? join(project, '_site'), 'docs');
  const markdown = [...(await listMarkdown('docs'))];
  const roots = ['README.md', 'README.en.md'].filter(await exists);
  const all = [...roots, ...markdown];
  const unmapped = all.filter(path => !SHELF_OF[path]);
  if (unmapped.length) throw new Error(`Published markdown without a shelf: ${unmapped.join(', ')}`);

  await rm(siteDocs, { recursive: true, force: true });
  await mkdir(siteDocs, { recursive: true });

  // Assets first, so the link rewriter can point at their published location.
  const { assets, copied } = await copyAssets(siteDocs);

  const targets = new Map();
  for (const path of all) targets.set(path, sitePathFor(path));

  const pages = [];
  for (const path of all) pages.push(await renderPage(path, targets, assets));

  // The Chinese and English README share a title, and two identical book spines tell the reader nothing.
  const titleCount = new Map();
  for (const page of pages) titleCount.set(page.title, (titleCount.get(page.title) ?? 0) + 1);
  for (const page of pages) {
    const lang = /\.([a-z]{2})\.md$/.exec(page.repoPath)?.[1];
    if (lang && titleCount.get(page.title) > 1) page.title = `${page.title}（${lang === 'en' ? 'English' : lang.toUpperCase()}）`;
  }

  const byShelf = new Map(SHELVES.map(shelf => [shelf.id, []]));
  for (const page of pages) {
    const shelf = SHELF_OF[page.repoPath];
    if (!byShelf.has(shelf)) throw new Error(`Unknown shelf ${shelf} for ${page.repoPath}`);
    byShelf.get(shelf).push(page);
  }

  const generatedAt = new Date().toISOString();
  const generatedStamp = `${generatedAt.slice(0, 10)}`;

  /* ---- templates ---- */
  const templatesDir = join(project, 'docs-site');
  const template = {
    landing: await readFile(join(templatesDir, 'landing.html'), 'utf8'),
    article: await readFile(join(templatesDir, 'article.html'), 'utf8'),
  };
  const staticNames = ['landing.css', 'landing.js', 'page.css', 'page.js', 'favicon.svg'];
  for (const name of staticNames) {
    const dest = join(siteDocs, '_assets', name);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(templatesDir, name), dest);
  }

  /** A book only carries facts the document itself supports. */
  const books = [];
  for (const shelf of SHELVES) {
    for (const page of byShelf.get(shelf.id)) {
      books.push({
        id: slugify(page.repoPath.replace(/\//g, '-')),
        title: page.title,
        shelf: shelf.id,
        shelfTitle: shelf.title,
        href: targets.get(page.repoPath),
        preview: page.preview.slice(0, 220),
        read: page.read.slice(0, 430),
        highlight: page.highlight.slice(0, 200),
        note: page.note.slice(0, 150),
        sourcePath: page.repoPath,
        sourceUrl: page.sourceUrl,
        mins: page.mins,
        headings: page.toc.slice(0, 4).map(item => ({ text: item.text, href: `${targets.get(page.repoPath)}#${item.id}` })),
        thickness: Math.max(16, Math.min(58, Math.round(14 + Math.log10(Math.max(10, page.words)) * 13))),
        words: page.words,
        sections: page.sections,
        hue: shelf.hue,
      });
    }
  }

  const searchIndex = pages.map(page => ({
    title: page.title,
    shelf: SHELF_OF[page.repoPath],
    shelfTitle: SHELVES.find(shelf => shelf.id === SHELF_OF[page.repoPath]).title,
    href: targets.get(page.repoPath),
    headings: page.toc.slice(0, 40).map(item => ({ text: item.text, id: item.id })),
    body: page.plain.slice(0, 14000),
    words: page.words,
  }));

  const shelfMeta = SHELVES.map(shelf => ({
    ...shelf,
    count: byShelf.get(shelf.id).length,
    books: byShelf.get(shelf.id).map(page => targets.get(page.repoPath)),
  }));

  const landing = template.landing
    .replaceAll('<!--BOOKS-->', JSON.stringify(books))
    .replaceAll('<!--SHELVES-->', JSON.stringify(shelfMeta))
    .replaceAll('<!--CATALOG-->', catalogHtml(byShelf, targets))
    .replaceAll('<!--REPO-->', REPO)
    .replaceAll('<!--GENERATED-->', generatedStamp);
  await writeFile(join(siteDocs, 'index.html'), landing);

  const searchPath = join(siteDocs, '_assets', 'search.json');
  await writeFile(searchPath, JSON.stringify({ generatedAt, count: searchIndex.length, entries: searchIndex }));

  /* ---- article pages ---- */
  const nav = SHELVES.map(shelf => ({
    id: shelf.id,
    title: shelf.title,
    items: byShelf.get(shelf.id)
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
      .map(page => ({ text: page.title, href: targets.get(page.repoPath), current: false })),
  }));

  for (const page of pages) {
    const site = targets.get(page.repoPath);
    const dir = dirname(site) === '.' ? '' : dirname(site);
    const up = dir ? '../'.repeat(dir.split('/').length) : './';
    const shelfId = SHELF_OF[page.repoPath];
    const shelf = SHELVES.find(item => item.id === shelfId);
    const rel = h => `${up}${h}`;
    const tocHtml = page.toc.length
      ? page.toc
          .map(item => `<li class="toc-l${item.depth}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`)
          .join('')
      : '<li class="toc-empty">这篇文档没有小节标题。</li>';
    const navHtml = nav
      .map(group => {
        const items = group.items
          .map(item => {
            const isCurrent = item.href === site;
            return `<a class="nav-item${isCurrent ? ' is-current' : ''}" href="${rel(item.href)}">${escapeHtml(item.text)}</a>`;
          })
          .join('');
        return `<section class="nav-shelf"><h3><a href="${rel('index.html')}#shelf-${group.id}">${escapeHtml(group.title)}</a></h3>${items}</section>`;
      })
      .join('');
    const html = template.article
      .replaceAll('<!--TITLE-->', escapeHtml(page.title))
      .replaceAll('<!--TITLE-BLOCK-->', page.titleBlock)
      .replaceAll('<!--SHELF-->', escapeHtml(shelf.title))
      .replaceAll('<!--SHELF-ID-->', shelfId)
      .replaceAll('<!--SHELF-BLURB-->', escapeHtml(shelf.blurb))
      .replaceAll('<!--ASSET-BASE-->', rel('_assets'))
      .replaceAll('<!--DOCS-ROOT-->', rel('index.html'))
      .replaceAll('<!--SHARED-ROOT-->', `${up}../`)
      .replaceAll('<!--SOURCE-->', page.sourceUrl)
      .replaceAll('<!--BODY-->', page.body)
      .replaceAll('<!--TOC-->', tocHtml)
      .replaceAll('<!--NAV-->', navHtml)
      .replaceAll('<!--WORDS-->', String(page.words))
      .replaceAll('<!--SECTIONS-->', String(page.sections))
      .replaceAll('<!--GENERATED-->', generatedStamp);
    const abs = join(siteDocs, site);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, html);
  }

  await writeFile(join(siteDocs, '.nojekyll'), '');

  const summary = {
    output: relative(project, siteDocs).replace(/\\/g, '/'),
    pages: pages.length,
    shelves: shelfMeta.map(shelf => ({ id: shelf.id, books: shelf.count })),
    search_bytes: (await stat(searchPath)).size,
    copied_assets: copied.length,
    landing_books: books.length,
  };
  return summary;
}

/** The catalog is the same wall of shelves in text, so navigation never depends on the animation. */
function catalogHtml(byShelf, targets) {
  return SHELVES.map(shelf => {
    const pages = byShelf.get(shelf.id).slice().sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    const cards = pages.map(page => {
      const id = slugify(page.repoPath.replace(/\//g, '-'));
      const tags = page.toc.filter(heading => heading.depth === 2).slice(0, 3)
        .map(heading => `<i>${escapeHtml(heading.text)}</i>`)
        .join('');
      return `<div class="card" style="--hue:${shelf.hue}">
  <a class="card-link" href="${targets.get(page.repoPath)}"><b>${escapeHtml(page.title)}</b><span>${escapeHtml(page.preview.slice(0, 130))}</span></a>
  <div class="card-foot"><span class="tags">${tags}</span><span class="meta">${page.words.toLocaleString()} 字 · ${page.sections} 节 <button class="peek" type="button" data-book="${id}">翻开</button></span></div>
</div>`;
    }).join('\n');
    return `<section class="shelf-block" id="shelf-${shelf.id}">
  <h3>${escapeHtml(shelf.title)} · ${pages.length} 本</h3>
  <p>${escapeHtml(shelf.blurb)}。</p>
  <div class="cards">
${cards}
  </div>
</section>`;
  }).join('\n');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolveArg(process.argv[1])) {
  const summary = await buildDocsSite({});
  console.log(JSON.stringify(summary));
}

function resolveArg(arg) {
  const abs = arg.startsWith('/') ? arg : join(process.cwd(), arg);
  return normalize(abs);
}
