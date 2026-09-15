'use strict';

// This view projects one native Harness conversation. It never calls a model
// directly and retains only a bounded recent transcript while the tab is visible.
window.PaperLibraryChat = {
  create({ api, toast, getPaper, getContext, getAnnotations, navigate, navigateReference, changed, savedFeedback, getLibrary, persistence }) {
    const $ = id => document.getElementById(id);
    const chat = { available: false, paperId: null, sessionId: null, visible: false, ticket: 0, notes: [], catalog: [], catalogReady: false, catalogTotal: 0, catalogTruncated: false, catalogPromise: null, offset: 0, selection: null, busy: false, timer: null, historyLoading: false, failed: null, ensure: null, suggestions: new Set(), draftLoading:false, storedDraft:false };
    const drafts = new Map();
    const pending = new Map();
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const nonce = () => window.crypto.randomUUID();
    const MAX_REFS = 1000, DRAFT_BYTES = 262144, PAGE_SIZE = 20;
    const isUserNote = note => !note.ai_generated && note.kind !== 'ai-feedback' && note.type !== 'ai_feedback';
    const status = (text, error = false) => { $('paper-chat-status').textContent = text; $('paper-chat-status').classList.toggle('error', error); };
    const isCurrent = (id, ticket) => id === chat.paperId && ticket === chat.ticket;
    function controls() {
      const unavailable = !chat.available || !chat.sessionId || chat.draftLoading;
      $('paper-chat-input').disabled=chat.draftLoading;
      for (const id of ['paper-chat-open', 'paper-chat-draft', 'paper-chat-send', 'paper-chat-auto']) $(id).disabled = unavailable || chat.busy;
      for (const id of ['paper-chat-new', 'paper-chat-choose', 'paper-chat-all']) $(id).disabled = unavailable || !getPaper()?.pdf;
      if (chat.catalogTruncated || chat.catalog.some(note => note.identity_reliable === false && note.identity_source === 'duplicate-pdf-nm')) $('paper-chat-all').disabled = true;
      $('annotation-chat-actions').hidden = !chat.available;
      $('legacy-feedback-controls').hidden = chat.available;
    }
    function remember(publish = true) {
      if (!chat.paperId || chat.draftLoading) return;
      const value={ draft: $('paper-chat-input').value, annotationRefs: chat.notes.map(ref => ({ ...ref })), selection: chat.selection, failed: chat.failed };
      if(window.PaperLibraryLocalState.byteLength(value)>DRAFT_BYTES){status('本篇草稿超过保存上限，内容仍保留在当前页面。请缩小选择后再切换论文。',true);return false;}
      drafts.delete(chat.paperId);
      drafts.set(chat.paperId,value);
      const paperId=chat.paperId,ticket=chat.ticket;
      if(persistence)void persistence.put(`chat:${paperId}`,value).then(()=>{if(isCurrent(paperId,ticket))chat.storedDraft=true;}).catch(error=>{if(isCurrent(paperId,ticket))status(`对话草稿尚未保存到本地服务：${error.message}`,true);});
      while (drafts.size > 12) drafts.delete(drafts.keys().next().value);
      while(window.PaperLibraryLocalState.byteLength([...drafts])>DRAFT_BYTES&&drafts.size>1)drafts.delete(drafts.keys().next().value);
      if (publish) return changed();
    }
    function contextLabel() {
      const text = [chat.notes.length ? `批注 ${chat.notes.length} 条` : '', chat.selection ? `第 ${chat.selection.page} 页选文` : ''].filter(Boolean).join(' ＋ ');
      $('paper-chat-context-label').textContent = `${text} · 查看/调整`;
      $('paper-chat-context').hidden = !text;
      const selected = new Map(chat.notes.map(ref => [ref.id, ref.version]));
      const changedRefs = chat.catalogReady ? chat.notes.filter(ref => !chat.catalog.some(note => note.id === ref.id && note.version === ref.version)) : [];
      const sourceCharacters = chat.catalog.filter(note => selected.has(note.id)).reduce((sum, note) => sum + (Number(note.source_characters) || 0), 0) + (chat.selection?.text.length || 0);
      $('paper-chat-coverage').textContent = changedRefs.length ? `${changedRefs.length} 条已选批注已更新或删除。请在「本次已选」中核对后发送。` : text ? `已选 ${chat.notes.length} / ${chat.catalogReady ? `${chat.catalogTotal}${chat.catalogTruncated ? '+' : ''}` : '…'} 条用户批注${sourceCharacters ? ` · 原文与评论 ${sourceCharacters.toLocaleString()} 字符` : ''}。发送前核对完整引用长度。` : '可直接追问，也可添加批注；保存与选择不会发送消息。';
      const pendingCount = chat.catalog.filter(note => note.status !== 'sent').length;
      $('paper-chat-new').textContent = `新增与更新 ${pendingCount}${chat.catalogTruncated ? '+' : ''}`;
      $('paper-chat-all').textContent = `全部 ${chat.catalogReady ? chat.catalogTotal : '…'}`;
      const suggestions = chat.catalog.filter(note => chat.suggestions.has(note.id) && selected.get(note.id) !== note.version);
      $('paper-chat-new-suggestion').hidden = suggestions.length === 0;
      $('paper-chat-new-suggestion-label').textContent = `又新增或更新 ${suggestions.length} 条，当前选择保持不变。`;
      if (!$('paper-reference-drawer').hidden) renderCatalog();
    }
    function validRefs(value) {
      if (!Array.isArray(value) || value.length > MAX_REFS) return [];
      return value.filter(ref => ref && typeof ref.id === 'string' && ref.id.length <= 160 && typeof ref.version === 'string' && ref.version.length <= 160).map(ref => ({ id: ref.id, version: ref.version }));
    }
    async function catalog(force = false) {
      if (!chat.available || !chat.paperId || !getPaper()?.pdf) return [];
      if (chat.catalogReady && !force) return chat.catalog;
      const id = chat.paperId, ticket = chat.ticket;
      if (chat.catalogPromise) {
        if (!force) return chat.catalogPromise;
        // A save may finish while an earlier read still represents the old PDF.
        // Wait for that read, then explicitly request the post-save catalog.
        try { await chat.catalogPromise; } catch { /* The requested refresh can recover. */ }
        return isCurrent(id, ticket) ? catalog(true) : [];
      }
      const promise = (async () => {
        $('paper-reference-read-status').textContent = '正在读取这篇论文的批注…';
        const result = await api('chat_catalog', { id });
        if (!isCurrent(id, ticket)) return [];
        const annotations = (result.annotations || []).filter(isUserNote);
        if (annotations.length > MAX_REFS) throw new Error('批注目录超过界面读取上限，请缩小文献范围。');
        chat.catalog = annotations; chat.catalogReady = true;
        chat.catalogTotal = result.total ?? chat.catalog.length; chat.catalogTruncated = Boolean(result.truncated);
        contextLabel(); controls();
        return chat.catalog;
      })();
      chat.catalogPromise = promise;
      try { return await promise; }
      catch (error) { if (isCurrent(id, ticket)) { $('paper-reference-read-status').textContent = error.message; status(error.message, true); } throw error; }
      finally { if (chat.catalogPromise === promise) chat.catalogPromise = null; }
    }
    function setReferences(notes) {
      if (notes.some(note => note.identity_reliable === false && note.identity_source === 'duplicate-pdf-nm')) { toast('存在重复批注标识，无法可靠确定引用内容。请先修复 PDF 中的重复标识，或选择其他批注。', true); return false; }
      const merged = new Map(chat.notes.map(ref => [ref.id, ref]));
      for (const note of notes) if (note?.id && note.version && isUserNote(note)) merged.set(note.id, { id: note.id, version: note.version });
      if (merged.size > MAX_REFS) { toast(`本次最多暂存 ${MAX_REFS} 条引用，请缩小选择。`, true); return false; }
      chat.notes = [...merged.values()]; contextLabel(); remember(); return true;
    }
    function removeReference(id) { chat.notes = chat.notes.filter(ref => ref.id !== id); contextLabel(); remember(); }
    function renderCatalog() {
      const focusedId = document.activeElement?.dataset?.referenceId, renderedBoxes = new Map();
      const selected = new Map(chat.notes.map(ref => [ref.id, ref]));
      const query = $('paper-reference-search').value.trim().toLocaleLowerCase(), page = Number($('paper-reference-page').value), scope = $('paper-reference-scope').value;
      const rows = [...chat.catalog];
      if (scope === 'selected') for (const ref of chat.notes) if (!rows.some(note => note.id === ref.id)) rows.push({ ...ref, missing: true });
      const filtered = rows.filter(note => (scope !== 'pending' || note.status !== 'sent') && (scope !== 'selected' || selected.has(note.id)) && (!page || note.page === page) && (!query || `${note.id} ${note.text || ''} ${note.comment || ''}`.toLocaleLowerCase().includes(query)));
      chat.offset = Math.min(chat.offset, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1) * PAGE_SIZE);
      const fragment = document.createDocumentFragment();
      for (const note of filtered.slice(chat.offset, chat.offset + PAGE_SIZE)) {
        const card = element('article', 'paper-reference-row'), label = element('label', 'paper-reference-check'), box = element('input'); box.type = 'checkbox'; box.checked = selected.has(note.id);
        if (box.dataset) box.dataset.referenceId = note.id;
        renderedBoxes.set(note.id, box);
        box.disabled = note.identity_reliable === false && note.identity_source === 'duplicate-pdf-nm' && !box.checked;
        box.addEventListener('change', () => box.checked ? setReferences([note]) : removeReference(note.id));
        const details = element('span', 'paper-reference-detail');
        const outdated = selected.has(note.id) && selected.get(note.id).version !== note.version;
        details.append(element('strong', '', `${note.missing ? '原批注已删除或当前目录未包含' : `第 ${note.page} 页`} · ${note.missing ? '请移除引用' : outdated ? '内容已更新' : note.status === 'sent' ? '已发送' : note.status === 'updated' ? '发送后已更新' : '未发送'}`));
        details.append(element('small', 'muted', note.id));
        if (note.identity_source === 'duplicate-pdf-nm') details.append(element('p', 'error', '重复批注标识 · 不能可靠引用，请先修复 PDF。'));
        else if (note.identity_reliable === false) details.append(element('p', 'muted', '此批注使用位置标识；外部阅读器重写 PDF 后可能需要重新选择。'));
        if (note.text) details.append(element('blockquote', '', note.text));
        if (note.comment) details.append(element('p', '', note.comment));
        label.append(box, details); card.append(label);
        if (outdated) {
          const adopt = element('button', 'button subtle', '采用当前版本'); adopt.type = 'button'; adopt.addEventListener('click', () => setReferences([note])); card.append(adopt);
        }
        fragment.append(card);
      }
      if (!filtered.length) fragment.append(element('p', 'paper-chat-empty', chat.catalogReady ? '没有符合条件的批注。选择其他范围或清除筛选。' : '正在读取批注…'));
      $('paper-reference-list').replaceChildren(fragment);
      if (focusedId) renderedBoxes.get(focusedId)?.focus();
      $('paper-reference-page-label').textContent = filtered.length ? `${chat.offset + 1}–${Math.min(chat.offset + PAGE_SIZE, filtered.length)} / ${filtered.length}` : '0 条';
      $('paper-reference-prev').disabled = chat.offset === 0; $('paper-reference-next').disabled = chat.offset + PAGE_SIZE >= filtered.length;
      const ambiguous = chat.catalog.filter(note => note.identity_source === 'duplicate-pdf-nm').length;
      $('paper-reference-read-status').textContent = (chat.catalogTruncated ? `当前目录仅包含 ${chat.catalog.length} 条，尚未完整读取；「全部」不可用。可选择已显示条目。` : `共 ${chat.catalogTotal} 条用户批注。列表显示摘要，发送时读取完整内容。`) + (ambiguous ? ` ${ambiguous} 条使用重复标识，无法选择。` : '');
      $('paper-reference-selection').hidden = !chat.selection;
      $('paper-reference-selection-label').textContent = chat.selection ? `临时选文 · 第 ${chat.selection.page} 页\n${chat.selection.text}` : '';
    }
    async function openDrawer(scope = 'all') {
      $('paper-reference-drawer').hidden = false; $('paper-chat-context-label').setAttribute?.('aria-expanded', 'true');
      $('paper-reference-scope').value = scope; chat.offset = 0; renderCatalog();
      try { await catalog(); renderCatalog(); } catch { /* Visible status provides recovery. */ }
    }
    function closeDrawer() { $('paper-reference-drawer').hidden = true; $('paper-chat-context-label').setAttribute?.('aria-expanded', 'false'); }
    async function addAll() {
      const id = chat.paperId, ticket = chat.ticket;
      try { const notes = await catalog(); if (!isCurrent(id, ticket)) return false; if (chat.catalogTruncated) throw new Error('批注目录尚未完整读取，不能把其中一部分称为全部。请手动选择已显示条目。'); return setReferences(notes); }
      catch (error) { status(error.message, true); return false; }
    }
    function stopTimer() { clearTimeout(chat.timer); chat.timer = null; }
    function schedule() {
      stopTimer();
      if (chat.visible && chat.available && document.visibilityState !== 'hidden') chat.timer = setTimeout(() => history(), 4000);
    }
    function bridge(action, payload = {}) {
      if (window.parent === window) return Promise.reject(new Error('请从 DSH 的文献库面板打开主对话。'));
      const requestId = nonce();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('主对话暂未响应，草稿已保留。请刷新 DSH 后重试。')); }, 20000);
        pending.set(requestId, { resolve, reject, timer });
        window.parent.postMessage({ type: 'paper-library:conversation-action', version: 1, requestId, action, ...payload }, window.location.origin);
      });
    }
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== 'paper-library:conversation-result' || event.data.version !== 1) return;
      const request = pending.get(event.data.requestId);
      if (!request) { if (event.data.relay && !event.data.ok) toast(event.data.error || '主对话操作未完成，阅读草稿已保留。', true); return; }
      pending.delete(event.data.requestId); clearTimeout(request.timer);
      if (event.data.ok) request.resolve(event.data); else request.reject(new Error(event.data.error || '主对话操作未完成。'));
    });
    async function ensure(id = chat.paperId) {
      if (!chat.available || !id) return null;
      if (chat.sessionId && id === chat.paperId) return chat.sessionId;
      if (chat.ensure?.id === id) return chat.ensure.promise;
      const ticket = chat.ticket;
      const promise = (async () => {
        const context = getContext();
        const result = await api('chat_ensure', { id, ...(context?.sessionId ? { source_session_id: context.sessionId } : {}) });
        if (!isCurrent(id, ticket)) return null;
        chat.sessionId = result.sessionId; controls();
        status(result.created ? '已建立这篇论文的 DSH 对话，尚未调用模型。' : '继续这篇论文已有的 DSH 对话。');
        if (result.created && window.parent !== window) bridge('refresh').catch(() => {});
        return result.sessionId;
      })();
      chat.ensure = { id, promise };
      try { return await promise; } finally { if (chat.ensure?.promise === promise) chat.ensure = null; }
    }
    function renderHistory(result) {
      if (result.annotation_usage && result.usage_revision !== chat.usageRevision) {
        for (const note of chat.catalog) {
          const used = Object.hasOwn(result.annotation_usage, note.id) ? result.annotation_usage[note.id] : undefined;
          note.status = used === note.version ? 'sent' : used ? 'updated' : 'new';
        }
        chat.usageRevision = result.usage_revision; contextLabel();
      }
      const historyKey = JSON.stringify(result.messages || []);
      if (historyKey !== chat.historyKey) {
      const list = $('paper-chat-messages');
      const previousTop = list.scrollTop || 0;
      const followLatest = chat.historyKey === undefined || (list.scrollHeight || 0) - previousTop - (list.clientHeight || 0) < 80;
      const fragment = document.createDocumentFragment();
      let remaining = 48000;
      for (const message of (result.messages || []).slice(-20)) {
        if (!['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || remaining <= 0) continue;
        const text = message.text.slice(0, Math.min(6000, remaining)); remaining -= text.length;
        const card = element('article', `paper-chat-message ${message.role}`);
        card.append(element('header', '', message.role === 'user' ? '你' : 'DSH · AI 回复'), element('p', '', text));
        for (const reference of (message.references || []).slice(0, 8)) {
          if (!reference.snapshot_id) continue;
          const referencePaper = reference.paperId || chat.paperId;
          const wrapper = element('div', 'paper-chat-history-reference'), button = element('button', 'button subtle', `查看当次引用 · ${reference.count || 0} 条批注`), body = element('div', 'paper-chat-reference-preview');
          button.type = 'button'; body.hidden = true; let loading = false;
          button.addEventListener('click', async () => {
            if (loading) return;
            if (!body.hidden) { body.hidden = true; body.replaceChildren(); button.textContent = `查看当次引用 · ${reference.count || 0} 条批注`; return; }
            loading = true; button.disabled = true;
            try {
              const result = await api('chat_reference', { id: referencePaper, snapshot_id: reference.snapshot_id });
              body.replaceChildren(element('p', '', result.text));
              const pages = [...new Set((result.annotation_refs || []).map(ref => ref.page).filter(page => Number.isInteger(page) && page > 0))];
              for (const page of (pages.length ? pages : reference.pages || []).slice(0, 30)) {
                const link = element('button', 'button subtle', `返回第 ${page} 页`); link.type = 'button';
                link.addEventListener('click', () => navigateReference?.(referencePaper, page)); body.append(link);
              }
              body.hidden = false; button.textContent = '收起当次引用';
            } catch (error) { toast(error.message, true); }
            finally { loading = false; button.disabled = false; }
          });
          wrapper.append(button, body); card.append(wrapper);
        }
        if (message.truncated || text.length < message.text.length) card.append(element('small', 'muted', '较长消息可在主对话中完整阅读。'));
        if (message.role === 'assistant' && message.id && getPaper()?.pdf && !message.partial && !message.interrupted) {
          const button = element('button', 'button subtle', '保存这条回复到 PDF'); button.type = 'button';
          button.addEventListener('click', async () => {
            const id = chat.paperId; button.disabled = true;
            try { await api('chat_save_feedback', { id, message_id: message.id }); toast('AI 回复已保存到 PDF'); await savedFeedback(id); }
            catch (error) { toast(error.message, true); } finally { button.disabled = false; }
          });
          card.append(button);
        }
        fragment.append(card);
      }
      if (!fragment.childNodes.length) fragment.append(element('p', 'paper-chat-empty', '对话已经准备好。引用一条批注，或直接写下关于这篇论文的问题。'));
      list.replaceChildren(fragment);
      list.scrollTop = followLatest ? list.scrollHeight : previousTop;
      chat.historyKey = historyKey;
      }
      $('paper-chat-history-note').textContent = result.hasMore ? '这里只显示最近的消息，完整历史保留在 DSH 主对话。' : '';
      const model = result.model;
      $('paper-chat-model').textContent = model?.provider && (model.model || model.id) ? `论文对话模型 · ${model.provider} / ${model.model || model.id}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}` : '模型由这篇论文的 DSH 对话管理，可在主页面切换。';
      if (result.running) status('DSH 正在回复。工具执行、权限确认和停止操作可在主对话中处理。');
      else if (result.error) status(result.error, true);
      else if (result.outcome && !['completed', 'complete', 'success', 'stop'].includes(result.outcome)) status('这轮回复已停止或未完成，请打开主对话查看原因并继续。', true);
      else if (!chat.busy && !chat.failed) status('与 DSH 主对话同步。');
    }
    async function history() {
      if (!chat.available || !chat.paperId || chat.historyLoading) return;
      const id = chat.paperId, ticket = chat.ticket; chat.historyLoading = true;
      try {
        if (!await ensure(id) || !isCurrent(id, ticket)) return;
        const result = await api('chat_history', { id });
        if (isCurrent(id, ticket)) renderHistory(result);
      } catch (error) { if (isCurrent(id, ticket)) status(error.message, true); }
      finally { chat.historyLoading = false; schedule(); }
    }
    function requestArgs(question) {
      return { id: chat.paperId, question, annotation_refs: chat.notes.map(ref => ({ ...ref })), ...(chat.selection ? { selection: { ...chat.selection } } : {}) };
    }
    async function send(automatic = false, explicitArgs = null) {
      if (chat.busy) {
        if (automatic) toast('批注已保存，尚未发送。上一条消息正在提交；请稍后点击「加入本次引用」后发送。', true);
        return;
      }
      if (!chat.available || !chat.paperId) return;
      const question = $('paper-chat-input').value.trim();
      if (!explicitArgs && !question && !chat.notes.length && !chat.selection) { toast('先写下问题，或引用一条批注。'); return; }
      const args = explicitArgs || requestArgs(question || '请结合引用内容回应我的阅读批注，并指出值得核验的问题。');
      const fingerprint = JSON.stringify(args);
      let submission = chat.failed?.fingerprint === fingerprint ? chat.failed : { fingerprint, requestId: nonce(), snapshotId: null };
      const id = chat.paperId, ticket = chat.ticket, draft = $('paper-chat-input').value;
      chat.busy = true; controls(); status(automatic ? '批注已保存，正在发送到论文对话…' : '正在发送到论文对话…');
      try {
        if (!await ensure(id) || !isCurrent(id, ticket)) return;
        if (!submission.snapshotId) {
          const snapshot = await api('chat_context', args);
          if (!isCurrent(id, ticket)) return;
          submission = { ...submission, snapshotId: snapshot.snapshot_id };
          chat.failed = submission.snapshotId ? submission : null; remember();
        }
        await api('chat_send', { id, snapshot_id: submission.snapshotId, request_id: submission.requestId });
        if (!isCurrent(id, ticket)) return;
        chat.failed = null;
        if (!automatic && $('paper-chat-input').value === draft && JSON.stringify(requestArgs(question || '请结合引用内容回应我的阅读批注，并指出值得核验的问题。')) === fingerprint) { $('paper-chat-input').value = ''; chat.notes = []; chat.selection = null; contextLabel(); }
        remember(); status('消息已交给 DSH；引用状态将在会话日志确认后更新。'); await history();
      } catch (error) {
        if (isCurrent(id, ticket)) {
          chat.failed = submission.snapshotId ? submission : null; remember();
          status(`${error.message}${submission.snapshotId ? ' 再次发送相同内容会沿用本次快照和请求标识。' : ' 问题与引用已保留，请调整引用或刷新后重试。'}`, true);
        }
      } finally { if (isCurrent(id, ticket)) { chat.busy = false; controls(); schedule(); } }
    }
    async function openMain(draft = false) {
      const id = chat.paperId, ticket = chat.ticket;
      try {
        const sessionId = await ensure(id); if (!sessionId || !isCurrent(id, ticket)) return;
        let prepared;
        if (draft) {
          const result = await api('chat_context', requestArgs($('paper-chat-input').value.trim() || '请结合引用内容回应我的阅读问题。'));
          if (!isCurrent(id, ticket)) return;
          prepared = result;
        }
        if (remember() === false) throw new Error('阅读草稿超过暂存上限，请先保存批注或缩短文字，再打开主对话。');
        await bridge(draft ? 'draft' : 'open', { sessionId, ...(prepared ? { text: prepared.text, draft_text: prepared.draft_text, reference: prepared.reference, snapshot_id: prepared.snapshot_id } : {}) });
        if (draft) toast('已追加到论文主对话的输入框，尚未发送。');
      } catch (error) { status(error.message, true); }
    }
    async function paperOpened(item) {
      // The outer reader has already selected the new paper. Keep the previous
      // draft locally without publishing it under the new paper's identity.
      remember(false); stopTimer();
      chat.paperId = item.id; chat.sessionId = null; ++chat.ticket; chat.catalog = []; chat.catalogReady = false; chat.catalogTotal = 0; chat.catalogTruncated = false; chat.catalogPromise = null; chat.offset = 0; chat.usageRevision = null; chat.suggestions = new Set(); chat.busy = false;
      const ticket=chat.ticket;let previous=drafts.get(item.id),preferences=null;
      chat.storedDraft=false;chat.draftLoading=Boolean(persistence);controls();
      if(persistence){
        chat.notes=[];chat.selection=null;chat.failed=null;$('paper-chat-input').value='';$('paper-chat-messages').replaceChildren();contextLabel();status('正在读取这篇论文的对话草稿…');
        try{[previous,preferences]=await Promise.all([persistence.get(`chat:${item.id}`),persistence.get('preferences')]);if(!isCurrent(item.id,ticket))return;chat.storedDraft=previous!==null;}
        catch(error){if(isCurrent(item.id,ticket)){chat.storedDraft=true;status(`暂时无法读取对话草稿：${error.message}。请点击刷新重试。`,true);}return;}
      }
      if(previous&&(!Array.isArray(previous.annotationRefs)||typeof previous.draft!=='string'||previous.draft.length>12000)){status('保存的对话草稿格式无效，请先导出并检查本地状态。',true);return;}
      chat.draftLoading=false;
      chat.notes = validRefs(previous?.annotationRefs); chat.selection = previous?.selection || null; chat.failed = previous?.failed || null;
      chat.historyKey = undefined;
      $('paper-chat-input').value = previous?.draft || ''; $('paper-chat-messages').replaceChildren(); closeDrawer(); contextLabel(); controls();
      $('paper-chat-auto').checked = preferences?.['auto-paper-conversation']===true||preferences?.['auto-paper-conversation']==='true';
      if (!chat.available) { status('请从 DSH 右侧的文献库打开，便可为每篇论文建立对话。'); return; }
      status('正在准备这篇论文的 DSH 对话…');
      try { await ensure(item.id); if (chat.paperId !== item.id) return; await catalog(); if (chat.visible) await history(); } catch (error) { if (chat.paperId === item.id) status(error.message, true); }
    }
    async function useNote(note) {
      if (!isUserNote(note)) return;
      if (chat.notes.some(ref => ref.id === note.id)) { removeReference(note.id); toast('已从本次引用移除'); return; }
      const id = chat.paperId, ticket = chat.ticket;
      try {
        const notes = await catalog(); const current = notes.find(value => value.id === note.id);
        if (!isCurrent(id, ticket)) return;
        if (!current) throw new Error('当前引用目录未找到这条批注，请刷新批注后重试。');
        if (setReferences([current])) toast(`已加入本次引用 · 共 ${chat.notes.length} 条`);
      } catch (error) { toast(error.message, true); }
    }
    $('paper-chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
    $('paper-chat-input').addEventListener('input', remember);
    $('paper-chat-open').addEventListener('click', () => openMain());
    $('paper-chat-draft').addEventListener('click', () => openMain(true));
    $('paper-chat-refresh').addEventListener('click', async () => { try { if(chat.draftLoading){await paperOpened(getPaper());return;}await catalog(true); await history(); } catch { /* status shown */ } });
    $('paper-chat-clear-context').addEventListener('click', () => { chat.notes = []; chat.selection = null; contextLabel(); remember(); });
    $('discuss-all-notes').addEventListener('click', () => { navigate('conversation'); void openDrawer(); });
    $('draft-all-notes').addEventListener('click', async () => { if (await addAll()) await openMain(true); });
    $('paper-chat-all').addEventListener('click', addAll);
    $('paper-chat-new').addEventListener('click', async () => { const id = chat.paperId, ticket = chat.ticket; try { const notes = await catalog(); if (!isCurrent(id, ticket)) return; setReferences(notes.filter(note => note.status !== 'sent')); await openDrawer('pending'); } catch { /* status shown */ } });
    $('paper-chat-add-new').addEventListener('click', () => { setReferences(chat.catalog.filter(note => chat.suggestions.has(note.id))); chat.suggestions.clear(); contextLabel(); });
    $('paper-chat-choose').addEventListener('click', () => openDrawer());
    $('paper-chat-context-label').addEventListener('click', () => openDrawer('selected'));
    $('paper-reference-close').addEventListener('click', closeDrawer);
    $('paper-reference-clear-selection').addEventListener('click', () => { chat.selection = null; contextLabel(); remember(); });
    for (const id of ['paper-reference-search', 'paper-reference-page', 'paper-reference-scope']) $(id).addEventListener(id === 'paper-reference-scope' ? 'change' : 'input', () => { chat.offset = 0; renderCatalog(); });
    $('paper-reference-prev').addEventListener('click', () => { chat.offset = Math.max(0, chat.offset - PAGE_SIZE); renderCatalog(); });
    $('paper-reference-next').addEventListener('click', () => { chat.offset += PAGE_SIZE; renderCatalog(); });
    $('paper-chat-auto').addEventListener('change', () => {
      if(persistence)void persistence.patch('preferences',{'auto-paper-conversation':$('paper-chat-auto').checked}).catch(error=>toast(`自动发送偏好尚未保存：${error.message}`,true));
      if ($('paper-chat-auto').checked) toast('已开启。新保存的批注会发送到这篇论文的 DSH 对话并使用模型额度。');
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopTimer(); else if (chat.visible) void history(); });
    controls();
    return {
      setAvailable(value) { chat.available = Boolean(value); controls(); },
      available: () => chat.available,
      paperOpened,
      hasStoredDraft:()=>chat.storedDraft,
      visible(value) { chat.visible = value; if (value) void history(); else stopTimer(); },
      useAnnotation: useNote,
      hasAnnotation: id => chat.notes.some(ref => ref.id === id),
      async annotationsChanged(id) { if (id === chat.paperId && chat.available) { try { await catalog(true); } catch { /* status shown */ } } },
      useSelection(selection) { if (!selection) return; if (selection.text.length > 8000) { toast('选文超过 8,000 字符，请缩小选择；尚未添加引用。', true); return; } chat.selection = { page: selection.page, text: selection.text }; contextLabel(); remember(); navigate('conversation'); $('paper-chat-input').focus(); },
      async savedAnnotation(id, annotationId, draftToMain = false) {
        if (id !== chat.paperId || !chat.available || !annotationId) return;
        chat.suggestions.add(annotationId);
        try {
          const notes = await catalog(true); if (id !== chat.paperId) return;
          const note = notes.find(value => value.id === annotationId);
          if (!note) throw new Error('批注已保存，引用目录暂未找到该条目。请刷新后重试。');
          contextLabel();
          if (draftToMain) { setReferences([note]); await openMain(true); }
          else if ($('paper-chat-auto').checked) await send(true, { id, question: '请回应我刚保存的这条阅读批注，并指出需要核验的内容。', annotation_refs: [{ id: note.id, version: note.version }] });
        } catch (error) { status(error.message, true); }
      },
      draft: () => $('paper-chat-input').value.slice(0, 12000),
      context: () => ({ annotationRefs: chat.notes.map(ref => ({ ...ref })), ...(chat.selection ? { selection: { ...chat.selection } } : {}) }),
      restoreContext(value) {
        chat.notes = validRefs(value?.annotationRefs);
        chat.selection = value?.selection && Number.isInteger(value.selection.page) && value.selection.page > 0 && typeof value.selection.text === 'string' ? { page: value.selection.page, text: value.selection.text.slice(0, 8000) } : null;
        contextLabel(); remember();
      },
      restoreDraft(text) { $('paper-chat-input').value = typeof text === 'string' ? text.slice(0, 12000) : ''; remember(); },
      async saveDraft() {
        if (!chat.paperId || chat.draftLoading) throw new Error('论文对话草稿尚未恢复。');
        if (persistence) await persistence.put(`chat:${chat.paperId}`, { draft:$('paper-chat-input').value, annotationRefs:chat.notes.map(ref=>({...ref})), selection:chat.selection, failed:chat.failed });
      },
      dispose() { remember(false);stopTimer(); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('阅读面板已关闭。')); } pending.clear(); },
    };
  },
};
