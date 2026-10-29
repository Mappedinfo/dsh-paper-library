'use strict';
/** Explicit writing helpers. Insertion stays under the workspace's draft guard. */
window.PaperLatexWritingTools = (() => {
  const MAX_ROWS = 100, MAX_COLUMNS = 30, MAX_CELLS = 2000, MAX_BYTES = 8 * 1024 * 1024;
  const escapeLatex = value => String(value).replace(/[\\{}$&#%_^~\r\n]/g, char => ({ '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#', '%': '\\%', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}', '\r': ' ', '\n': ' ' }[char]));
  function normalize(rows) {
    if (!rows.length || rows.length > MAX_ROWS) throw new Error('表格需要 1–100 行。');
    const columns = Math.max(...rows.map(row => row.length));
    if (!columns || columns > MAX_COLUMNS || rows.length * columns > MAX_CELLS) throw new Error('表格最多 30 列、2000 个单元格。');
    return rows.map(row => Array.from({ length: columns }, (_, index) => { const value = String(row[index] ?? ''); if (value.length > 10000) throw new Error('单元格超过 10000 字符。'); return value; }));
  }
  function markdownRow(line) {
    let value = line.trim(); if (value.startsWith('|')) value = value.slice(1); if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = []; let current = '';
    for (let i = 0; i < value.length; i++) { if (value[i] === '\\' && value[i + 1] === '|') { current += '|'; i++; } else if (value[i] === '|') { cells.push(current.trim()); current = ''; } else current += value[i]; }
    cells.push(current.trim()); return cells;
  }
  function tsvRows(text) {
    const rows = [], row = []; let value = '', quoted = false;
    for (let i = 0; i < text.length; i++) { const char = text[i]; if (char === '"' && (!value || quoted)) { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; } else if (!quoted && (char === '\t' || char === '\n')) { row.push(value); value = ''; if (char === '\n') { rows.push(row.splice(0)); } } else value += char; }
    if (quoted) throw new Error('表格的引号未闭合。'); row.push(value); if (row.some(cell => cell !== '') || !rows.length) rows.push(row); return rows;
  }
  function parseTable(text) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('粘贴文本超过 1 MiB。');
    const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim().split('\n');
    if (!lines[0]) throw new Error('请先粘贴 Markdown 表格或 Excel 单元格。');
    let rows, alignments = [], header = false;
    if (!text.includes('\t') && lines.length > 1 && markdownRow(lines[1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
      const separator = markdownRow(lines[1]); alignments = separator.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'c' : cell.endsWith(':') ? 'r' : 'l');
      rows = [markdownRow(lines[0]), ...lines.slice(2).filter(line => line.trim()).map(markdownRow)]; header = true;
    } else rows = tsvRows(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
    rows = normalize(rows); return { rows, header, alignments: rows[0].map((_, index) => alignments[index] || 'l') };
  }
  function tableLatex({ rows, alignments = [], header = true, caption = '', label = '' }) {
    rows = normalize(rows);
    const lines = ['\\begin{table}[htbp]', '  \\centering'];
    if (caption.trim()) lines.push(`  \\caption{${escapeLatex(caption.trim())}}`);
    if (label.trim()) lines.push(`  \\label{${label.trim().replace(/[^A-Za-z0-9:.-]/g, '-')}}`);
    lines.push(`  \\begin{tabular}{${rows[0].map((_, index) => ['l', 'c', 'r'].includes(alignments[index]) ? alignments[index] : 'l').join('')}}`, '    \\hline');
    rows.forEach((row, index) => { lines.push(`    ${row.map(escapeLatex).join(' & ')} \\\\`); if (index === 0 && header) lines.push('    \\hline'); });
    lines.push('    \\hline', '  \\end{tabular}', '\\end{table}', ''); return lines.join('\n');
  }
  function figureLatex(path = 'figures/example.png') {
    return `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.9\\linewidth]{${path}}\n  \\caption{图片说明}\n  \\label{fig:${path.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9-]/g, '-')}}\n\\end{figure}\n`;
  }
  function create({ root, api, toast = () => {}, getContext, insert, onAssetsChanged = () => {} }) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    const button = (text, action) => { const node = make('button', 'button subtle', text); node.type = 'button'; node.addEventListener('click', action); return node; };
    let disposed = false, busy = false, pending = false, activeKind = null, expected = null, currentXlsx = null, rows = [['列名', '数值'], ['示例', '0']], alignments = ['l', 'r'];
    const dialog = make('dialog', 'latex-writing-dialog'); dialog.id = 'latex-writing-dialog';
    const head = make('div', 'latex-writing-head'), title = make('strong'), close = button('关闭', () => dialog.close()); head.append(title, close);
    const targetLabel = make('p', 'latex-writing-target'); targetLabel.id = 'latex-writing-target';
    const status = make('p', 'latex-writing-status'); status.setAttribute('role', 'status'); status.id = 'latex-writing-status';
    const figurePane = make('section'); figurePane.hidden = true;
    const fileInput = make('input'); fileInput.type = 'file'; fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp'; fileInput.id = 'latex-image-file';
    const figureActions = make('div', 'latex-writing-actions'); figureActions.append(button('插入图片模板', () => deliver(figureLatex())), button('选择图片并插入', () => fileInput.click()));
    figurePane.append(make('p', '', '拖放或粘贴图片到源码区，也可在此选择。图片保存在本项目 figures/，不会覆盖已有文件。导言区需有 \\usepackage{graphicx}。'), figureActions, fileInput); fileInput.hidden = true;
    const tablePane = make('section'); tablePane.hidden = true;
    const paste = make('textarea'); paste.id = 'latex-table-paste'; paste.rows = 4; paste.placeholder = '粘贴 Markdown 表格，或从 Excel 复制的单元格；也可粘贴 / 拖入 .xlsx 文件。'; paste.setAttribute('aria-label', '粘贴表格数据');
    const tableFile = make('input'); tableFile.type = 'file'; tableFile.accept = '.xlsx'; tableFile.hidden = true; tableFile.id = 'latex-table-file';
    const sheet = make('select'); sheet.id = 'latex-table-sheet'; sheet.setAttribute('aria-label', 'XLSX 工作表'); sheet.hidden = true;
    const importActions = make('div', 'latex-writing-actions'); importActions.append(button('解析粘贴内容', () => { try { const result = parseTable(paste.value); rows = result.rows; alignments = result.alignments; header.checked = result.header; sheet.hidden = true; currentXlsx = null; renderGrid(); say('已解析，可直接修改单元格和列对齐。'); } catch (error) { say(error.message, true); } }), button('打开 XLSX', () => tableFile.click()), sheet);
    const headerLabel = make('label'), header = make('input'); header.type = 'checkbox'; header.checked = true; header.id = 'latex-table-header'; headerLabel.append(header, document.createTextNode('首行为表头'));
    const caption = make('input'); caption.id = 'latex-table-caption'; caption.placeholder = '表题（可选）'; caption.setAttribute('aria-label', '表题');
    const label = make('input'); label.id = 'latex-table-label'; label.placeholder = 'tab:example（可选）'; label.setAttribute('aria-label', '表格引用标签');
    const options = make('div', 'latex-writing-options'); options.append(headerLabel, caption, label);
    const grid = make('div', 'latex-table-grid'); grid.id = 'latex-table-grid';
    const gridActions = make('div', 'latex-writing-actions'); gridActions.append(button('添加行', () => { try { rows = normalize([...rows, rows[0].map(() => '')]); renderGrid(); } catch (error) { say(error.message, true); } }), button('添加列', () => { try { rows = normalize(rows.map(row => [...row, ''])); alignments.push('l'); renderGrid(); } catch (error) { say(error.message, true); } }), button('删除末行', () => { if (rows.length > 1) { rows.pop(); renderGrid(); } }), button('删除末列', () => { if (rows[0].length > 1) { rows = rows.map(row => row.slice(0, -1)); alignments.pop(); renderGrid(); } }));
    tablePane.append(paste, importActions, tableFile, options, grid, gridActions, make('small', '', '列角色：文本左对齐、数值右对齐或居中。内容按普通文本转义；公式不会执行，XLSX 只读取已缓存值。'));
    const output = make('textarea'); output.id = 'latex-writing-output'; output.rows = 7; output.readOnly = true; output.setAttribute('aria-label', '生成的 LaTeX');
    const actions = make('div', 'latex-writing-actions'); const discard = button('放弃草稿', () => { if (busy) { say('请等待当前文件处理结束。', true); return; } pending = false; expected = null; dialog.close(); }); const copy = button('复制 LaTeX', async () => { try { await navigator.clipboard.writeText(output.value); say('LaTeX 已复制。'); } catch { output.focus(); output.select(); say('请按 Cmd/Ctrl+C 复制当前内容。'); } });
    const apply = button('插入源码', () => deliver(output.value)); apply.id = 'latex-writing-insert'; actions.append(copy, apply, discard);
    dialog.append(head, targetLabel, status, figurePane, tablePane, output, actions); root.append(dialog);
    function say(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
    function usable() { const value = getContext(); if (!value?.id || !value.path || value.blocked) { toast('请先打开可编辑的 LaTeX 文件，并处理保存冲突。'); return null; } return { ...value }; }
    function open(kind) { if (pending) { targetLabel.textContent = `插入目标：${expected.title || expected.id} / ${expected.path}`; if (!dialog.open) dialog.showModal(); say('上次生成的草稿已保留；可插入、复制或放弃。'); return activeKind === kind; } expected = usable(); if (!expected) return false; pending = true; activeKind = kind; targetLabel.textContent = `插入目标：${expected.title || expected.id} / ${expected.path}`; figurePane.hidden = kind !== 'figure'; tablePane.hidden = kind !== 'table'; title.textContent = kind === 'figure' ? '插入图片' : '编辑表格'; say('生成内容只插入当前源码草稿，沿用自动保存与冲突保护。'); output.value = kind === 'figure' ? figureLatex() : tableLatex({ rows, alignments, header: header.checked, caption: caption.value, label: label.value }); if (!dialog.open) dialog.showModal(); if (kind === 'table') renderGrid(); return true; }
    function deliver(text) { if (!text) return; if (insert(text, expected) !== false) { pending = false; dialog.close(); } else { output.value = text; say('源码或选区已变化，未自动插入。生成内容已保留，可复制后手动插入。', true); } }
    function updateOutput() { output.value = tableLatex({ rows, alignments, header: header.checked, caption: caption.value, label: label.value }); }
    function renderGrid() {
      grid.textContent = ''; const table = make('table'), thead = make('thead'), tr = make('tr');
      rows[0].forEach((_, column) => { const th = make('th'), role = make('select'); role.setAttribute('aria-label', `第 ${column + 1} 列角色与对齐`); [['l', '文本 · 左'], ['r', '数值 · 右'], ['c', '居中']].forEach(([value, text]) => { const option = make('option', '', text); option.value = value; role.append(option); }); role.value = alignments[column] || 'l'; role.addEventListener('change', () => { alignments[column] = role.value; updateOutput(); }); th.append(role); tr.append(th); }); thead.append(tr); table.append(thead);
      const body = make('tbody'); rows.forEach((row, index) => { const tr = make('tr'); row.forEach((value, column) => { const td = make('td'), input = make('input'); input.value = value; input.maxLength = 10000; input.setAttribute('aria-label', `第 ${index + 1} 行第 ${column + 1} 列`); input.addEventListener('input', () => { rows[index][column] = input.value; updateOutput(); }); td.append(input); tr.append(td); }); body.append(tr); }); table.append(body); grid.append(table); updateOutput();
    }
    async function base64(file) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); }
    async function imageBlob(file) {
      if (['image/png', 'image/jpeg'].includes(file.type) || /\.(png|jpe?g)$/i.test(file.name)) return file;
      if (!['image/webp', 'image/gif', 'image/bmp'].includes(file.type)) throw new Error('支持 PNG、JPEG、WebP、GIF、BMP；GIF 导入首帧。');
      const bitmap = await createImageBitmap(file);
      try { if (bitmap.width * bitmap.height > 50_000_000) throw new Error('图片超过 5000 万像素。'); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片转换失败。')), 'image/png')); } finally { bitmap.close(); }
    }
    async function importImage(file, target = expected) {
      if (busy || disposed) return; busy = true;
      try { if (file.size > MAX_BYTES) throw new Error('图片超过 8 MiB。'); say('正在保存图片…'); const blob = await imageBlob(file); if (blob.size > MAX_BYTES) throw new Error('转换后图片超过 8 MiB。'); const result = await api('latex_asset_import', { id: target.id, name: file.name || 'pasted-image.png', data_base64: await base64(blob) }); if (disposed) return; expected = target; const text = figureLatex(result.path); output.value = text; void onAssetsChanged(target.id); say(`图片已保存：${result.path}`); deliver(text); } catch (error) { if (!disposed) say(`图片未插入：${error.message}。当前源码保留。`, true); } finally { busy = false; fileInput.value = ''; }
    }
    async function importXlsx(file, selectedSheet) {
      if (busy || disposed) return; busy = true;
      try { if (file && file.size > MAX_BYTES) throw new Error('XLSX 超过 8 MiB。'); if (selectedSheet && !currentXlsx) throw new Error('工作簿已失效，请重新选择 XLSX 文件。'); say('正在读取 XLSX…'); const data = selectedSheet ? currentXlsx : await base64(file); const result = await api('latex_table_import', { data_base64: data, ...(selectedSheet ? { sheet: selectedSheet } : {}) }); if (disposed) return; currentXlsx = data; rows = normalize(result.rows); alignments = rows[0].map((_, column) => rows.slice(1).every(row => row[column] === '' || /^[-+]?\d+(\.\d+)?%?$/.test(row[column])) ? 'r' : 'l'); header.checked = true; sheet.textContent = ''; result.sheets.forEach(name => { const option = make('option', '', name); option.value = name; sheet.append(option); }); sheet.value = result.sheet; sheet.hidden = result.sheets.length < 2; renderGrid(); say((result.warnings || []).join(' ') || 'XLSX 已导入，请核对后插入。'); } catch (error) { if (!disposed) say(error.message, true); } finally { busy = false; tableFile.value = ''; }
    }
    function transfer(event) {
      const files = Array.from((event.dataTransfer || event.clipboardData)?.files || []);
      const file = files.find(file => /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|xlsx)$/i.test(file.name));
      if (!file) { if (files.length && event.type === 'drop') { event.preventDefault(); toast('此处接收图片或 .xlsx 文件。'); return true; } return false; } if (busy || pending && !dialog.open) { event.preventDefault(); if (!dialog.open) dialog.showModal(); say('请先插入、复制或放弃现有草稿，再导入文件。', true); return true; } const target = usable(); if (!target) { event.preventDefault(); return true; } event.preventDefault();
      const xlsx = /\.xlsx$/i.test(file.name); if (pending && activeKind !== (xlsx ? 'table' : 'figure')) { event.preventDefault(); say('请先处理当前草稿，再切换工具。', true); return true; } if (!pending && !open(xlsx ? 'table' : 'figure')) return true; if (!expected) expected = target;
      if (files.length > 1) say('本次先导入一个文件，其他文件请逐个拖入。');
      if (xlsx) void importXlsx(file); else void importImage(file, expected); return true;
    }
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) void importImage(fileInput.files[0]); });
    tableFile.addEventListener('change', () => { if (tableFile.files[0]) void importXlsx(tableFile.files[0]); });
    sheet.addEventListener('change', () => void importXlsx(null, sheet.value));
    [header, caption, label].forEach(input => input.addEventListener('input', updateOutput));
    tablePane.addEventListener('paste', event => { if (event.clipboardData?.files?.length) transfer(event); });
    paste.addEventListener('paste', event => {
      if (event.clipboardData?.files?.length) return;
      const text = event.clipboardData?.getData('text/plain'); if (!text) return;
      event.preventDefault(); paste.value = text;
      try { const result = parseTable(text); rows = result.rows; alignments = result.alignments; header.checked = result.header; sheet.hidden = true; currentXlsx = null; renderGrid(); say('已粘贴，可直接修改单元格和列对齐。'); } catch (error) { say(error.message, true); }
    });
    dialog.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); }); dialog.addEventListener('drop', transfer);
    dialog.addEventListener('cancel', () => { if (busy) { /* The in-flight result remains available on reopening. */ } });
    return { figure: ({ templateOnly = false } = {}) => { if (templateOnly && !pending) { const target = usable(); if (target) insert(figureLatex(), target); } else open('figure'); }, table: () => open('table'), handleTransfer: transfer, hasDraft: () => pending || busy, dispose() { disposed = true; dialog.remove(); }, testHooks: { parseTable, tableLatex, figureLatex, rows: () => rows } };
  }
  return { create, parseTable, tableLatex, figureLatex };
})();
