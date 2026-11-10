/** Catalog-only aggregation. Citation/export APIs keep their original scope. */
const sorts = new Set(['title', 'author', 'year', 'journal', 'publisher', 'modified', 'created', 'citekey', 'kind', 'jcr', 'ranking']);
const asciiFold = value => value.replace(/[A-Z]/g, char => char.toLowerCase());
const binaryCompare = (left, right) => Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
const sqlNoCase = value => asciiFold(String(value));
// Python persists UTC timestamps via datetime.isoformat(): six fractional
// digits when nonzero and +00:00. JS emits three digits and Z; normalize the
// latter to the same form so binary ordering preserves sub-millisecond order.
function slideTimestamp(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^(.*?)(?:\.(\d{1,6}))?Z$/, (_, prefix, fraction = '') => {
    const micros = fraction.padEnd(6, '0');
    return `${prefix}${micros && /[1-9]/.test(micros) ? `.${micros}` : ''}+00:00`;
  });
}

function valueFor(item, sort) {
  if ((sort === 'created' || sort === 'modified') && item.resource_kind === 'slides') return slideTimestamp(item[sort]);
  if (sort === 'kind') return item.resource_kind || 'paper';
  if (sort === 'author') return item.author?.[0]?.family ?? item.author?.[0]?.literal ?? null;
  if (sort === 'year') return item.issued?.['date-parts']?.[0]?.[0] ?? null;
  if (sort === 'journal') return item['container-title'] ?? null;
  if (sort === 'publisher') return item.publisher ?? null;
  if (sort === 'jcr') {
    const rows = (item.journal_rankings || []).filter(row => row.system === 'JCR');
    if (!rows.length) return null;
    const year = Math.max(...rows.map(row => Number(row.year)));
    return rows.filter(row => Number(row.year) === year).map(row => row.quartile).filter(value => value != null).sort().at(-1) ?? null;
  }
  if (sort === 'ranking') {
    const rows = item.journal_rankings || [];
    const system = rows.map(row => row.system).sort(binaryCompare)[0];
    if (!system) return null;
    const group = rows.filter(row => row.system === system);
    const year = Math.max(...group.map(row => row.year));
    const grade = group.filter(row => row.year === year).map(row => row.grade === 'A*' ? '0' : row.quartile || row.grade)
      .filter(Boolean).sort(binaryCompare).at(-1);
    return grade ? `${system}:${grade}` : null;
  }
  return item[sort] ?? null;
}
function compare(left, right, sort, order) {
  const a = valueFor(left, sort), b = valueFor(right, sort);
  if (a == null || b == null) {
    if (a == null && b != null) return 1;
    if (a != null && b == null) return -1;
  } else {
    const nocase = ['title', 'author', 'journal', 'publisher', 'citekey'].includes(sort);
    const result = typeof a === 'number' && typeof b === 'number' ? a - b : binaryCompare(nocase ? sqlNoCase(a) : a, nocase ? sqlNoCase(b) : b);
    if (result) return order === 'desc' ? -result : result;
  }
  return binaryCompare(left.id, right.id);
}
function slideResource(project) {
  return { id: project.id, resource_kind: 'slides', type: 'slides', title: project.title, slide_count: project.slide_count,
    created: project.created_at ?? null, modified: project.updated_at ?? null, archived: false, pdf: false };
}

/** Fetch at most one page plus the bounded slide count around the requested offset. */
export async function catalogResources(input, { resourceList, slidesList }) {
  const kind = input.kind ?? 'all', query = input.query ?? '', archived = input.archived ?? false;
  const sort = input.sort || 'modified', order = input.order || (['modified', 'created', 'year'].includes(sort) ? 'desc' : 'asc');
  const offset = input.offset ?? 0, limit = input.limit ?? 40;
  if (!['all', 'paper', 'dataset', 'slides'].includes(kind)) throw new Error('不支持的目录类型。');
  if (typeof query !== 'string' || query.length > 500) throw new Error('检索词必须是 500 字以内的文本。');
  if (typeof archived !== 'boolean' || !sorts.has(sort) || !['asc', 'desc'].includes(order)) throw new Error('目录筛选或排序无效。');
  if (input.favorite !== undefined && typeof input.favorite !== 'boolean' || input.tag !== undefined && (typeof input.tag !== 'string' || input.tag.length > 200)) throw new Error('收藏或标签筛选无效。');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('目录分页超出范围。');
  const params = { ...input, action: 'resource_list', kind, query, archived, sort, order };
  // Slides do not belong to reading projects or the paper/dataset recycle bin.
  // Avoid touching their metadata entirely when they cannot occur in the result.
  const paperScope = input.favorite === true || Boolean(input.tag?.trim());
  if (kind === 'slides' && (archived || input.project || paperScope)) {
    return { items: [], total: 0, offset, limit, truncated: false, next_offset: null, kind, archived, counts: {}, sort, order, search_mode: 'slides-title' };
  }
  if (kind === 'paper' || kind === 'dataset' || archived || input.project || paperScope) {
    const { active_count: _partialActiveCount, ...result } = await resourceList({ ...params, offset, limit });
    return result;
  }
  let catalog;
  try { catalog = await slidesList(); }
  catch (error) {
    if (error instanceof Error) error.message = `无法读取完整演示文稿目录：${error.message} 可切换“文献”或“数据集”类型继续使用。`;
    throw error;
  }
  const allSlides = catalog.projects.map(slideResource);
  const needle = query.trim().toLowerCase();
  const matching = archived || input.project ? [] : allSlides.filter(item => !needle || item.title.toLowerCase().includes(needle));
  const slideCount = { total: allSlides.length, active: allSlides.length, archived: 0 };
  if (kind === 'slides') {
    matching.sort((a, b) => compare(a, b, sort, order));
    const items = matching.slice(offset, offset + limit), total = matching.length;
    return { items, total, offset, limit, truncated: offset + items.length < total,
      next_offset: offset + items.length < total ? offset + items.length : null, kind, archived, counts: { slides: slideCount }, sort, order, search_mode: 'slides-title' };
  }
  if (kind !== 'all' || !matching.length) {
    const base = await resourceList({ ...params, offset, limit });
    return { ...base, counts: { ...base.counts, slides: slideCount }, active_count: base.active_count + allSlides.length };
  }
  const start = Math.max(0, offset - matching.length), needed = offset + limit - start;
  const fetched = []; let cursor = start, total = null, first;
  while (fetched.length < needed) {
    const part = await resourceList({ ...params, offset: cursor, limit: Math.min(200, needed - fetched.length) });
    if (!first) { first = part; total = part.total; }
    else if (part.total !== total) throw new Error('目录在读取期间发生变化，请刷新后重试。');
    fetched.push(...part.items); cursor += part.items.length;
    if (!part.items.length || cursor >= total) break;
  }
  matching.sort((a, b) => compare(a, b, sort, order));
  const merged = []; let i = 0, j = 0;
  while (i < fetched.length || j < matching.length) {
    if (i >= fetched.length) merged.push(matching[j++]);
    else if (j >= matching.length || compare(fetched[i], matching[j], sort, order) <= 0) merged.push(fetched[i++]);
    else merged.push(matching[j++]);
  }
  const items = merged.slice(offset - start, offset - start + limit), combinedTotal = total + matching.length;
  return { ...first, items, total: combinedTotal, offset, limit, truncated: offset + items.length < combinedTotal,
    next_offset: offset + items.length < combinedTotal ? offset + items.length : null,
    counts: { ...first.counts, slides: slideCount }, active_count: first.active_count + allSlides.length };
}
