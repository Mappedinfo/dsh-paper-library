'use strict';
window.PaperAnnotationStyle = (() => {
  const colors = [['#ffdb66','金黄'],['#ed9c51','橙色'],['#df718b','玫瑰'],['#c85454','朱红'],['#569976','绿色'],['#49a5ad','青色'],['#447dc4','蓝色'],['#9274bd','紫色'],['#687382','灰色']];
  const previousStyles = new Map();
  const commits = new WeakMap();
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};

  document.addEventListener('click', event => {
    if (!event.target.closest?.('.pdr-sheet, #pdf-page')) return;
    const menu = document.querySelector('.annotation-style-menu[open]');
    if (menu) void commits.get(menu)?.();
  }, true);

  function palette(value,onChange){
    const group=node('div',null,'annotation-color-presets');group.setAttribute('role','group');group.setAttribute('aria-label','常用批注颜色');
    for(const [color,name]of colors){const b=node('button',null,'annotation-color-swatch');b.type='button';b.style.setProperty('--swatch',color);b.title=name;b.setAttribute('aria-label',name);b.dataset.color=color;b.addEventListener('click',()=>{set(color);onChange(color);});group.append(b);}
    function set(color){for(const b of group.children)b.setAttribute('aria-pressed',String(b.dataset.color===color.toLowerCase()));}
    set(value);return {element:group,set};
  }
  function colorValue(note) {
    const rgb = note.native_style?.color_rgb ?? note.color?.stroke;
    if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(Number.isFinite)) return colors[0][0];
    return '#' + rgb.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('');
  }

  function editor({note,paperId,api,onSaved,isCurrent = () => true}){
    if(!note.style_version||note.handwriting||!['underline','strikeout','square','ink','highlight','note'].includes(note.type))return null;
    const detail=node('details',null,'annotation-style-menu'),summary=node('summary','样式','button subtle'),panel=node('div',null,'annotation-style-panel');
    summary.setAttribute('aria-label','修改这条 PDF 批注的颜色与线型');detail.append(summary,panel);
    const key = JSON.stringify([paperId, note.id]);
    const supportsLine=['underline','strikeout','square','ink'].includes(note.type);
    const styleOf = item => ({color:colorValue(item), lineStyle:supportsLine ? item.line_style || 'solid' : null});
    let currentStyle = styleOf(note);
    let version = note.style_version;
    let saving = false;
    const input=node('input');input.type='color';input.value=currentStyle.color;input.setAttribute('aria-label','自定义批注颜色');
    const presets=palette(input.value,color=>{input.value=color;draftChanged();});
    input.addEventListener('input',()=>{presets.set(input.value);draftChanged();});
    const label=node('label','自定义颜色');label.append(input);panel.append(presets.element,label);
    const line=node('select');line.setAttribute('aria-label','批注线型');
    if(supportsLine){for(const [value,text]of [['solid','实线'],['dashed','虚线'],['dotted','点线']]){const option=node('option',text);option.value=value;line.append(option);}line.value=currentStyle.lineStyle;const row=node('label','线型');row.append(line);panel.append(row);}
    line.addEventListener('change',draftChanged);
    const actions = node('div', null, 'annotation-style-actions');
    const save=node('button','保存样式','button'), undo=node('button','恢复上一次样式','button subtle');
    const status=node('p',null,'small');status.setAttribute('role','status');
    save.type = undo.type = 'button';
    actions.append(save, undo);panel.append(actions,status);

    const hasDraft = () => input.value !== currentStyle.color || (supportsLine && line.value !== currentStyle.lineStyle);
    function previous() {
      const entry = previousStyles.get(key);
      return entry?.version === version ? entry.style : null;
    }
    function sync() {
      const dirty = hasDraft();
      save.disabled = saving || !dirty;
      undo.disabled = saving || (!dirty && !previous());
      undo.title = dirty ? '撤回尚未保存的调整' : '恢复上一次保存前的样式';
      input.disabled = line.disabled = saving;
      for (const swatch of presets.element.children) swatch.disabled = saving;
    }
    function draftChanged() {
      status.textContent = '';
      sync();
    }
    function showStyle(style) {
      input.value = style.color;
      presets.set(style.color);
      if (supportsLine) line.value = style.lineStyle;
    }
    function placePanel() {
      const rect = summary.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - bounds.height - 8))}px`;
    }
    async function write(style, restoring = false) {
      if (saving || !isCurrent()) return;
      saving = true;
      status.textContent = restoring ? '正在恢复…' : '正在保存…';
      sync();
      let annotation;
      try {
        const result = await api('annotation_style', {
          id:paperId, annotation_id:note.id, color:style.color, expected_version:version,
          ...(supportsLine && style.lineStyle !== currentStyle.lineStyle ? {line_style:style.lineStyle} : {}),
        });
        annotation = result.annotation;
        previousStyles.delete(key);
        if (!restoring) {
          previousStyles.set(key, {style:currentStyle, version:annotation.style_version});
          if (previousStyles.size > 200) previousStyles.delete(previousStyles.keys().next().value);
        }
        currentStyle = styleOf(annotation);
        version = annotation.style_version;
        showStyle(currentStyle);
        status.textContent = '';
        detail.open = false;
      } catch (error) {
        status.textContent = error.message;
        detail.open = true;
        placePanel();
      } finally {
        saving = false;
        sync();
      }
      if (annotation) await onSaved(annotation);
    }
    function commit() {
      if (hasDraft()) return write({color:input.value, lineStyle:supportsLine ? line.value : null});
      detail.open = false;
    }
    save.addEventListener('click', commit);
    undo.addEventListener('click', () => {
      if (hasDraft()) { showStyle(currentStyle); draftChanged(); return; }
      const style = previous();
      if (style) void write(style, true);
    });
    commits.set(detail, commit);
    detail.addEventListener('toggle', () => {
      if (!detail.open) return;
      for (const menu of document.querySelectorAll('.annotation-style-menu[open]')) if (menu !== detail) menu.open = false;
      sync();
      placePanel();
    });
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();detail.open=false;summary.focus();}});
    sync();
    return detail;
  }
  return {palette,editor};
})();
