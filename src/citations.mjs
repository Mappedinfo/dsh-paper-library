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

const hasValue = value => (typeof value === 'string' || typeof value === 'number') && Boolean(String(value).trim());
const hasNames = names => Array.isArray(names) && names.some(person => [person?.family, person?.given, person?.literal].some(hasValue));

/** Readiness for the copy command. General CSL exports still support APA's
 * missing-information forms for users who deliberately need those. */
export function apaCopyReadiness(item) {
  const type = item.type || 'article-journal';
  const venue = hasValue(item['container-title']);
  const pages = hasValue(item.page) || hasValue(item.number);
  const journal = type === 'article-journal';
  const proceedings = type === 'paper-conference' && venue;
  const early = /^(?:in press|advance online publication)$/i.test(String(item.status || '').trim());
  const missing = [];
  if (!hasValue(item.title) || /^(?:untitled|未命名文献)$/i.test(String(item.title).trim())) missing.push('题名');
  if (!hasNames(item.author) && !(type === 'book' && hasNames(item.editor))) missing.push('作者');
  if (!hasValue(item.issued?.['date-parts']?.[0]?.[0]) && !hasValue(item.issued?.literal) && !/^in press$/i.test(item.status || '')) missing.push('出版年份');
  if ((journal || type === 'chapter') && !venue) missing.push('期刊或出版出处');
  if (type === 'paper-conference' && !venue && !hasValue(item['event-title'])) missing.push('会议或论文集名称');
  if ((journal || proceedings) && !pages && !early) missing.push('页码或文章编号');
  if (['book','chapter'].includes(type) && !hasValue(item.publisher)) missing.push('出版者');
  if (type === 'article' && venue) missing.push('出版类型（期刊或会议论文）');
  if (['article','document','report','thesis','webpage'].includes(type) && ![item.DOI, item.URL, item.publisher, item.archive, item['container-title']].some(hasValue)) missing.push('出版出处或公开链接');
  // Try to find volume, issue and DOI when available, but their absence alone
  // does not prevent copying a reference to a source that omits them.
  const lookup = missing.length > 0 || (journal && !early && (!hasValue(item.volume) || !hasValue(item.issue))) ||
    ((journal || proceedings) && !hasValue(item.DOI)) || item.parse?.field_sources?.author === 'pdf-info-author-literal';
  return { missing, lookup };
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
  const warnings=data.flatMap(item=>{
    const missing=[];
    if(!String(item.title||'').trim())missing.push('标题');
    if(!item.author?.length)missing.push('作者');
    if(!item.issued?.['date-parts']?.[0]?.[0]&&!item.issued?.literal)missing.push('年份');
    if(['article-journal','paper-conference','chapter'].includes(item.type)&&!item['container-title'])missing.push('期刊 / 出处');
    return missing.length?[`${item.id}：缺少${missing.join('、')}`]:[];
  });
  return { text, html, warnings, filename: 'references-apa.txt', mime: 'text/plain;charset=utf-8' };
}
