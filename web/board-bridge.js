/* Conversation bridge for the literature whiteboard.
 *
 * The board lives in an iframe pane, so it cannot touch the DSH composer itself: it asks the
 * host client plugin to place a reference chip by postMessage and waits for the answer. Only
 * identity travels here — the board id, the frozen snapshot id and a title. The material the
 * model would receive stays in the host's own snapshot store, which is what keeps an edited
 * board from silently rewriting already-sent references.
 *
 * The module is a factory with no dependency of its own beyond the `document` it is handed, so
 * the panel test can drive it through the same fake DOM the rest of the panel uses.
 */
(function () {
  'use strict';

  const CONVERSATION_ACTION = 'paper-library:conversation-action';
  const CONVERSATION_RESULT = 'paper-library:conversation-result';
  /** How long the host may take before the chip is declared missing. The board itself is never
   *  touched by a failure here, so the reader only has to retry the reference. */
  const BRIDGE_TIMEOUT = 20000;
  const OUTSIDE_HOST = '请从 DSH 的文献库面板打开画板，才能把画板引用放进对话。';

  /**
   * @param {object} options
   * @param {Document} options.doc          the board's own document (its `defaultView` is the iframe window)
   * @param {() => object} options.api      the panel's action bridge, for `board_snapshot`
   * @param {() => object} options.capabilities  live capabilities (`conversation` decides whether the chip exists)
   * @param {() => string|null} options.boardId  the open board, or null before a record has loaded
   * @param {() => boolean} options.live    false once the panel is torn down
   * @param {() => object} options.board    the board being shown (its title labels the chip)
   * @param {() => boolean} options.conflict  true while a stale write is unresolved
   * @param {() => Promise<unknown>} options.flush  settle the debounced save before freezing
   * @param {() => string|null} options.sessionId  the DSH conversation to place the chip in
   * @param {(message: string, error?: boolean) => void} options.toast
   */
  function create(options) {
    const { doc } = options;
    const pending = new Map();
    let sequence = 0;

    /** Ask the host client plugin to do one thing with the composer, and await its answer. */
    function request(action, payload) {
      const view = doc.defaultView;
      if (!view?.parent || view.parent === view) return Promise.reject(new Error(OUTSIDE_HOST));
      const requestId = `board-${Date.now().toString(36)}-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('主对话暂未响应，画板内容仍在。请刷新 DSH 后重试。'));
        }, BRIDGE_TIMEOUT);
        pending.set(requestId, { resolve, reject, timer });
        view.parent.postMessage({ type: CONVERSATION_ACTION, version: 1, requestId, action, ...payload }, view.location.origin);
      });
    }

    /** Only the parent frame of this exact document may answer a pending request. */
    function onResult(event) {
      const view = doc.defaultView;
      if (!view?.parent || event.source !== view.parent || event.origin !== view.location.origin) return;
      if (event.data?.type !== CONVERSATION_RESULT || event.data.version !== 1) return;
      const waiting = pending.get(event.data.requestId);
      if (!waiting) return;
      pending.delete(event.data.requestId);
      clearTimeout(waiting.timer);
      if (event.data.ok) waiting.resolve(event.data);
      else waiting.reject(new Error(event.data.error || '主对话操作未完成。'));
    }

    /** Freeze what the reader sees, then ask the host to place its chip in the draft. */
    async function send() {
      const boardId = options.boardId();
      if (!boardId || !options.capabilities().conversation) return false;
      const view = doc.defaultView;
      // Outside DSH there is no composer at all; say that before blaming the session.
      if (!view?.parent || view.parent === view) { options.toast(OUTSIDE_HOST, true); return false; }
      const sessionId = options.sessionId();
      if (!sessionId) { options.toast('当前 DSH 会话尚未就绪，请稍后在 DSH 面板中重试。', true); return false; }
      try {
        await options.flush();
        // A conflict means the stored board is not what the reader sees: freezing now would send
        // material they did not choose, so the conflict has to be resolved first.
        if (options.conflict()) { options.toast('画板已在别处修改，请先处理冲突再放入对话。', true); return false; }
        const frozen = await options.api()('board_snapshot', { id: boardId });
        if (!options.live()) return false;
        await request('board_draft', { sessionId, board_id: boardId, snapshot_id: frozen.snapshot_id, title: frozen.board_title ?? options.board().title });
        options.toast('已把画板引用放进主输入框；编辑后可发送，未发送前不会调用模型。');
        return true;
      } catch (error) {
        options.toast(error.message || '放入对话失败', true);
        return false;
      }
    }

    /** Start listening for the host's answers. */
    function listen() {
      doc.defaultView?.addEventListener?.('message', onResult);
    }

    /** Stop listening and fail anything still in flight, so a closed panel leaves no timers. */
    function dispose() {
      for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('画板已关闭')); }
      pending.clear();
      doc.defaultView?.removeEventListener?.('message', onResult);
    }

    return {
      CONVERSATION_ACTION,
      CONVERSATION_RESULT,
      request,
      onResult,
      send,
      listen,
      dispose,
      pendingCount: () => pending.size,
    };
  }

  window.PaperBoardBridge = Object.freeze({ create, CONVERSATION_ACTION, CONVERSATION_RESULT, OUTSIDE_HOST });
})();
