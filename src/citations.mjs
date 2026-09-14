import { readFile } from 'node:fs/promises';

let engines;
async function load() {
  if (!engines) engines = Promise.all([
    import('citeproc'), import('@citation-js/core'), import('@citation-js/plugin-bibtex'),
    readFile(new URL('../vendor/csl/apa.csl', import.meta.url), 'utf8'),
    readFile(new URL('../vendor/csl/locales-en-US.xml', import.meta.url), 'utf8'),
  ]).then(([csl, core, , style, locale]) => {
    const plugins = core.plugins || core.default.plugins;
    // Citation.js otherwise invents author/year/title labels and can collapse
    // unrelated entries. Labels are validated below and remain user-authoritative.
    const config = plugins.config.get('@bibtex');
    config.format.useIdAsLabel = true;
    config.format.checkLabel = false;
    return { CSL: csl.default, Cite: core.Cite || core.default.Cite || core.default, style, locale };
  });
  return engines;
}

function cleanItem(item, index) {
  const { pdf, page_count, tags, path, library, ...csl } = item;
  const key=String(item.citekey || item.id || `ref${index + 1}`);
  return { ...csl, id:key, 'citation-key':key, type: item.type || 'article-journal' };
}

export async function parseBibtex(text) {
  const { Cite } = await load();
  if (text.length > 16 * 1024 * 1024) throw new Error('BibTeX 文件超过 16 MB；请分批导入。');
  return new Cite(text, { forceType: '@biblatex/text' }).data.map(item => ({ ...item, citekey: String(item['citation-key'] || item.id) }));
}

// Citation output can contain source-supplied markup. Only a small formatting
// vocabulary survives into the HTML clipboard; no attributes or active content.
export function safeCitationHtml(html) {
  return html.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (whole, tag) => {
      tag = tag.toLowerCase();
      if (!['div', 'span', 'i', 'em', 'b', 'strong', 'sup', 'sub', 'br'].includes(tag)) return '';
      return `<${whole.startsWith('</') ? '/' : ''}${tag}>`;
    });
}

export async function cite(items, format = 'apa') {
  if (!Array.isArray(items) || !items.length || items.length > 500) throw new Error('请选择 1–500 篇文献。');
  const data = items.map(cleanItem);
  if (new Set(data.map(i => i.id)).size !== data.length) throw new Error('引用键重复，请先编辑为唯一引用键。');
  if (format === 'csl-json') return { text: JSON.stringify(data, null, 2), filename: 'references.json', mime: 'application/json' };
  const { CSL, Cite, style, locale } = await load();
  if (format === 'biblatex') {
    for(const item of data) if(!/^[^\s,{}\\%#"'=()]+$/u.test(item.id)) throw new Error(`引用键含 BibLaTeX 不支持的字符，请先编辑：${item.id}`);
    const text = new Cite(data).format('biblatex', { format: 'text' });
    return { text, filename: 'references.bib', mime: 'application/x-bibtex' };
  }
  if (format !== 'apa') throw new Error('不支持的引用格式。');
  const records = Object.fromEntries(data.map(item => [item.id, item]));
  const engine = new CSL.Engine({ retrieveLocale: () => locale, retrieveItem: id => records[id] }, style, 'en-US');
  engine.updateItems(data.map(item => item.id));
  engine.setOutputFormat('text');
  const text = engine.makeBibliography()[1].map(s => s.trim()).join('\n\n');
  engine.setOutputFormat('html');
  const html = safeCitationHtml(engine.makeBibliography()[1].join(''));
  return { text, html, filename: 'references-apa.txt', mime: 'text/plain;charset=utf-8' };
}
