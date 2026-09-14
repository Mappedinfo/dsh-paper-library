'use strict';

// This view projects one native Harness conversation. It never calls a model
// directly and retains only a bounded recent transcript while the tab is visible.
window.PaperLibraryChat = {
  create({ api, toast, getPaper, getContext, getAnnotations, navigate, changed, savedFeedback, getLibrary }) {
    const $ = id => document.getElementById(id);
    const chat = { available: false, paperId: null, sessionId: null, visible: false, ticket: 0, notes: [], selection: null, busy: false, timer: null, historyLoading: false, failed: null, ensure: null };
    const drafts = new Map();
    const pending = new Map();
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const nonce = () => window.crypto.randomUUID();
    const preference = () => `paper-library:${getLibrary()}:auto-paper-conversation`;
    const status = (text, error = false) => { $('paper-chat-status').textContent = text; $('paper-chat-status').classList.toggle('error', error); };
    const isCurrent = (id, ticket) => id === chat.paperId && ticket === chat.ticket;
    function controls() {
      const unavailable = !chat.available || !chat.sessionId;
      for (const id of ['paper-chat-open', 'paper-chat-draft', 'paper-chat-send', 'paper-chat-auto']) $(id).disabled = unavailable || chat.busy;
      $('annotation-chat-actions').hidden = !chat.available;
      $('legacy-feedback-controls').hidden = chat.available;
    }
    function remember(publish = true) {
      if (!chat.paperId) return;
      drafts.delete(chat.paperId);
      drafts.set(chat.paperId, $('paper-chat-input').value.slice(0, 12000));
      while (drafts.size > 12) drafts.delete(drafts.keys().next().value);
      if (publish) return changed();
    }
    function contextLabel() {
      const text = chat.selection ? `已引用第 ${chat.selection.page} 页的选中文本` : chat.notes.length ? `已引用 ${chat.notes.length} 条已保存批注` : '';
      $('paper-chat-context-label').textContent = text;
      $('paper-chat-context').hidden = !text;
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
      return { id: chat.paperId, question, annotation_ids: [...chat.notes], ...(chat.selection ? { selection: { ...chat.selection } } : {}) };
    }
    async function send(automatic = false, explicitArgs = null) {
      if (chat.busy) {
        if (automatic) toast('批注已保存，尚未发送。上一条消息正在提交；请稍后在这条批注上点击「在论文对话中讨论」后发送。', true);
        return;
      }
      if (!chat.available || !chat.paperId) return;
      const question = $('paper-chat-input').value.trim();
      if (!explicitArgs && !question && !chat.notes.length && !chat.selection) { toast('先写下问题，或引用一条批注。'); return; }
      const args = explicitArgs || requestArgs(question || '请结合引用内容回应我的阅读批注，并指出值得核验的问题。');
      const fingerprint = JSON.stringify(args);
      const requestId = chat.failed?.fingerprint === fingerprint ? chat.failed.requestId : nonce();
      const id = chat.paperId, ticket = chat.ticket, draft = $('paper-chat-input').value;
      chat.busy = true; controls(); status(automatic ? '批注已保存，正在发送到论文对话…' : '正在发送到论文对话…');
      try {
        if (!await ensure(id) || !isCurrent(id, ticket)) return;
        await api('chat_send', { ...args, request_id: requestId });
        if (!isCurrent(id, ticket)) return;
        chat.failed = null;
        if (!automatic && $('paper-chat-input').value === draft) { $('paper-chat-input').value = ''; chat.notes = []; chat.selection = null; contextLabel(); remember(); }
        status('消息已交给 DSH；可在这里或主对话继续。'); await history();
      } catch (error) {
        if (isCurrent(id, ticket)) { chat.failed = { fingerprint, requestId }; status(`${error.message} 再次发送相同内容会沿用本次请求标识。`, true); }
      } finally { if (isCurrent(id, ticket)) { chat.busy = false; controls(); schedule(); } }
    }
    async function openMain(draft = false) {
      const id = chat.paperId, ticket = chat.ticket;
      try {
        const sessionId = await ensure(id); if (!sessionId || !isCurrent(id, ticket)) return;
        let text;
        if (draft) {
          const result = await api('chat_context', requestArgs($('paper-chat-input').value.trim() || '请结合引用内容回应我的阅读问题。'));
          if (!isCurrent(id, ticket)) return;
          text = result.text;
        }
        if (remember() === false) throw new Error('阅读草稿超过暂存上限，请先保存批注或缩短文字，再打开主对话。');
        await bridge(draft ? 'draft' : 'open', { sessionId, ...(text ? { text } : {}) });
        if (draft) toast('已追加到论文主对话的输入框，尚未发送。');
      } catch (error) { status(error.message, true); }
    }
    async function paperOpened(item) {
      // The outer reader has already selected the new paper. Keep the previous
      // draft locally without publishing it under the new paper's identity.
      remember(false); stopTimer();
      chat.paperId = item.id; chat.sessionId = null; ++chat.ticket; chat.notes = []; chat.selection = null; chat.busy = false; chat.failed = null;
      chat.historyKey = undefined;
      $('paper-chat-input').value = drafts.get(item.id) || ''; $('paper-chat-messages').replaceChildren(); contextLabel(); controls();
      try { $('paper-chat-auto').checked = localStorage.getItem(preference()) === 'true'; } catch { $('paper-chat-auto').checked = false; }
      if (!chat.available) { status('请从 DSH 右侧的文献库打开，便可为每篇论文建立对话。'); return; }
      status('正在准备这篇论文的 DSH 对话…');
      try { await ensure(item.id); if (chat.visible) await history(); } catch (error) { if (chat.paperId === item.id) status(error.message, true); }
    }
    function useNotes(notes) {
      chat.notes = notes.filter(note => !note.ai_generated && note.kind !== 'ai-feedback').slice(0, 40).map(note => note.id);
      chat.selection = null; contextLabel(); navigate('conversation'); $('paper-chat-input').focus();
    }
    $('paper-chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
    $('paper-chat-input').addEventListener('input', remember);
    $('paper-chat-open').addEventListener('click', () => openMain());
    $('paper-chat-draft').addEventListener('click', () => openMain(true));
    $('paper-chat-refresh').addEventListener('click', history);
    $('paper-chat-clear-context').addEventListener('click', () => { chat.notes = []; chat.selection = null; contextLabel(); remember(); });
    $('discuss-all-notes').addEventListener('click', () => useNotes(getAnnotations()));
    $('draft-all-notes').addEventListener('click', () => { useNotes(getAnnotations()); void openMain(true); });
    $('paper-chat-auto').addEventListener('change', () => {
      try { localStorage.setItem(preference(), String($('paper-chat-auto').checked)); } catch { toast('本次选择已生效，但浏览器未允许保存偏好。'); }
      if ($('paper-chat-auto').checked) toast('已开启。新保存的批注会发送到这篇论文的 DSH 对话并使用模型额度。');
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopTimer(); else if (chat.visible) void history(); });
    controls();
    return {
      setAvailable(value) { chat.available = Boolean(value); controls(); },
      available: () => chat.available,
      paperOpened,
      visible(value) { chat.visible = value; if (value) void history(); else stopTimer(); },
      useAnnotation: note => useNotes([note]),
      useSelection(selection) { if (!selection) return; chat.notes = []; chat.selection = { page: selection.page, text: selection.text.slice(0, 8000) }; contextLabel(); navigate('conversation'); $('paper-chat-input').focus(); },
      async savedAnnotation(id, annotationId, draftToMain = false) {
        if (id !== chat.paperId || !chat.available || !annotationId) return;
        if (draftToMain) { chat.notes = [annotationId]; chat.selection = null; contextLabel(); await openMain(true); }
        else if ($('paper-chat-auto').checked) await send(true, { id, question: '请回应我刚保存的这条阅读批注，并指出需要核验的内容。', annotation_ids: [annotationId] });
      },
      draft: () => $('paper-chat-input').value.slice(0, 12000),
      context: () => ({ annotationIds: [...chat.notes], ...(chat.selection ? { selection: { ...chat.selection } } : {}) }),
      restoreContext(value) {
        chat.notes = Array.isArray(value?.annotationIds) ? value.annotationIds.filter(id => typeof id === 'string').slice(0, 40) : [];
        chat.selection = value?.selection && Number.isInteger(value.selection.page) && value.selection.page > 0 && typeof value.selection.text === 'string' ? { page: value.selection.page, text: value.selection.text.slice(0, 8000) } : null;
        contextLabel();
      },
      restoreDraft(text) { $('paper-chat-input').value = typeof text === 'string' ? text.slice(0, 12000) : ''; remember(); },
      dispose() { stopTimer(); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('阅读面板已关闭。')); } pending.clear(); },
    };
  },
};
