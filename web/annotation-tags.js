'use strict';

window.PaperAnnotationTags = {
  create({ api, el, onSaved }) {
    const maxTags = 32, maxLength = 60;
    const normalize = value => value.normalize('NFKC').trim().replace(/^#+/, '').trim().replace(/\s+/g, ' ');
    const key = tag => tag.toLowerCase();
    const button = (label, action, type = 'button', className = 'button subtle') => {
      const node = el('button', className, label);
      node.type = type;
      if (action) node.addEventListener('click', action);
      return node;
    };

    const dialog = el('dialog', 'paper-tag-editor annotation-tag-editor'), heading = el('header');
    const title = el('h2', '', '批注标签'), identity = el('p', 'small muted'), form = el('form');
    const close = button('×', () => dialog.close(), 'button', 'icon-button');
    const fields = el('fieldset'), list = el('div', 'paper-tag-sources');
    const field = el('label', 'field', '输入标签'), entry = el('div', 'annotation-tag-input');
    const input = el('input'), suggestions = el('div', 'paper-tag-sources'), suggestionStatus = el('p', 'small muted');
    const error = el('p', 'inline-error'), save = button('保存标签', null, 'submit', 'button primary');
    let editor, timer, request;

    title.id = 'annotation-tag-editor-title';
    dialog.setAttribute('aria-labelledby', title.id);
    close.setAttribute('aria-label', '关闭批注标签');
    input.type = 'text';
    input.maxLength = maxLength;
    input.autocomplete = 'off';
    input.placeholder = '输入新标签或选择已有标签';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', '此批注的标签');
    suggestions.setAttribute('role', 'group');
    suggestions.setAttribute('aria-label', '已有标签建议');
    suggestionStatus.setAttribute('role', 'status');
    error.setAttribute('role', 'alert');
    field.append(input);
    entry.append(field, button('添加', () => addTag(input.value)));
    fields.append(list, entry, suggestions, suggestionStatus);
    heading.append(title, close);
    form.append(fields, error, save);
    dialog.append(heading, identity, form);
    document.body.append(dialog);

    function renderDraft() {
      list.replaceChildren();
      for (const tag of editor.tags) {
        const remove = button(`#${tag} ×`, () => {
          editor.tags = editor.tags.filter(value => value !== tag);
          error.textContent = '';
          renderDraft();
          scheduleSuggestions();
          input.focus();
        }, 'button', 'paper-tag-chip');
        remove.setAttribute('aria-label', `移除标签 ${tag}`);
        list.append(remove);
      }
    }

    function addTag(raw) {
      const tag = normalize(raw);
      if (!tag || [...tag].length > maxLength) {
        error.textContent = `请输入 1–${maxLength} 个字符的标签。`;
        return false;
      }
      if (!editor.tags.some(value => key(value) === key(tag))) {
        if (editor.tags.length >= maxTags) {
          error.textContent = `一条批注最多可添加 ${maxTags} 个标签。`;
          return false;
        }
        editor.tags.push(tag);
        renderDraft();
      }
      input.value = '';
      error.textContent = '';
      scheduleSuggestions();
      input.focus();
      return true;
    }

    function cancelSuggestions() {
      clearTimeout(timer);
      request?.abort();
      request = null;
    }

    function scheduleSuggestions(delay = 160) {
      cancelSuggestions();
      suggestions.replaceChildren();
      suggestionStatus.textContent = '';
      const query = normalize(input.value);
      timer = setTimeout(async () => {
        const current = new AbortController();
        request = current;
        try {
          const result = await api('annotation_tag_suggestions', { query }, { signal: current.signal });
          if (request !== current || !dialog.open) return;
          const existing = new Set(editor.tags.map(key));
          for (const tag of result.tags.filter(value => !existing.has(key(value)))) {
            suggestions.append(button(`#${tag}`, () => addTag(tag), 'button', 'paper-tag-chip'));
          }
        } catch (failure) {
          if (request === current && dialog.open) suggestionStatus.textContent = `已有标签读取失败：${failure.message}`;
        }
      }, delay);
    }

    function paintBusy(busy) {
      editor.busy = busy;
      fields.disabled = save.disabled = close.disabled = busy;
      save.textContent = busy ? '保存中…' : '保存标签';
    }

    function mergeDraft(latest) {
      const previous = new Set(editor.expected.map(key));
      const draft = new Set(editor.tags.map(key));
      const merged = latest.filter(tag => !previous.has(key(tag)) || draft.has(key(tag)));
      const included = new Set(merged.map(key));
      merged.push(...editor.tags.filter(tag => !previous.has(key(tag)) && !included.has(key(tag))));
      editor.tags = merged;
      editor.expected = latest;
      renderDraft();
      scheduleSuggestions();
    }

    input.addEventListener('input', () => scheduleSuggestions());
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (input.value.trim()) addTag(input.value);
    });
    dialog.addEventListener('cancel', event => { if (editor?.busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      cancelSuggestions();
      editor = null;
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!editor || editor.busy || (input.value.trim() && !addTag(input.value))) return;
      if (editor.tags.length > maxTags) {
        error.textContent = `请将标签减少到 ${maxTags} 个以内再保存。`;
        return;
      }
      const current = editor;
      paintBusy(true);
      cancelSuggestions();
      error.textContent = '';
      try {
        await api('annotation_tags_update', { id: current.id, annotation_id: current.annotationId, page: current.page,
          tags: current.tags, expected_tags: current.expected });
      } catch (failure) {
        if (editor === current && dialog.open) {
          paintBusy(false);
          if (failure.code === 'STATE_CONFLICT' && Array.isArray(failure.current?.tags)) {
            mergeDraft(failure.current.tags);
            error.textContent = '已合并另一窗口保存的标签，请核对后再次保存。';
          } else {
            error.textContent = failure.message;
          }
        }
        return;
      }
      if (editor === current && dialog.open) dialog.close();
      onSaved(current.id);
    });

    function open(note, id) {
      if (dialog.open) return;
      const existing = note.tags || [];
      editor = { id, annotationId: note.id, page: note.page, tags: [...existing], expected: [...existing] };
      identity.textContent = `第 ${note.page} 页`;
      input.value = '';
      error.textContent = '';
      paintBusy(false);
      renderDraft();
      dialog.showModal();
      input.focus();
      scheduleSuggestions(0);
    }

    const layouts = new WeakMap();
    const observer = typeof ResizeObserver === 'function' ?
      new ResizeObserver(entries => entries.forEach(({ target }) => layouts.get(target)?.())) : null;

    return {
      editButton(note, id) {
        const edit = button('标签', () => open(note, id));
        edit.setAttribute('aria-haspopup', 'dialog');
        return edit;
      },
      beforeRender() { observer?.disconnect(); },
      strip(note) {
        if (!note.tags?.length) return null;
        const row = el('div', 'annotation-tag-strip'), chips = el('div', 'annotation-tag-list');
        let expanded = false;
        const toggle = button('展开', () => { expanded = !expanded; layout(); });
        function layout() {
          row.classList.toggle('is-expanded', expanded);
          toggle.textContent = expanded ? '收起' : '展开';
          toggle.setAttribute('aria-label', expanded ? '收起批注标签' : '展开批注标签');
          toggle.setAttribute('aria-expanded', String(expanded));
          if (expanded) toggle.hidden = false;
          else if (observer) {
            toggle.hidden = true;
            toggle.hidden = chips.scrollHeight <= chips.clientHeight &&
              [...chips.children].every(chip => chip.scrollWidth <= chip.clientWidth);
          }
        }
        for (const tag of note.tags) {
          const chip = el('span', 'annotation-tag-chip', `#${tag}`);
          chip.title = `#${tag}`;
          chips.append(chip);
        }
        chips.setAttribute('role', 'group');
        chips.setAttribute('aria-label', '批注标签');
        row.append(chips, toggle);
        toggle.setAttribute('aria-label', '展开批注标签');
        toggle.setAttribute('aria-expanded', 'false');
        if (observer) {
          layouts.set(row, layout);
          observer.observe(row);
        }
        return row;
      },
    };
  },
};
