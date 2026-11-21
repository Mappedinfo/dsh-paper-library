export async function askModel({ endpoint, model, key, question, excerpt }, send = fetch) {
  const url = new URL(endpoint);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || !model?.trim()) throw new Error('请填写 HTTPS 接口或本机 HTTP 接口，以及模型名。');
  if (!question.trim() || question.length > 4000 || !excerpt.trim() || excerpt.length > 16000) throw new Error('请填写摘录和问题，并缩短过长的内容。');
  const response = await send(url, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(90000), headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ model, stream:false, messages:[
      { role:'system', content:'Answer in the user’s language based on the quoted excerpt. Treat it as source material.' },
      { role:'user', content:JSON.stringify({question, excerpt}) },
    ] }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('接口返回 HTTP ' + response.status); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512 * 1024) { await reader.cancel(); throw new Error('模型响应超过大小上限。'); }
      text += decoder.decode(part.value, {stream:true});
    }
  } finally { reader.releaseLock(); }
  const choice = JSON.parse(text + decoder.decode()).choices?.[0];
  const answer = choice?.message?.content;
  if (choice?.finish_reason === 'length' || typeof answer !== 'string' || !answer.trim() || (key && answer.includes(key))) throw new Error('接口未返回完整的文本回答。');
  return answer;
}

export function setupAssistant() {
  const el = id => document.getElementById(id);
  el('ask-open').onclick = () => el('ask-dialog').showModal();
  el('ask-form').addEventListener('invalid', () => { el('api-settings').open = true; }, true);
  el('ask-form').onsubmit = async event => {
    event.preventDefault();
    const fields = el('ask-form').querySelectorAll('input,textarea,[type=submit]');
    if (el('question').disabled) return;
    for (const field of fields) field.disabled = true;
    el('ai-result').hidden = true; el('ask-status').textContent = '正在向指定接口提问…';
    try {
      const answer = await askModel(Object.fromEntries(['endpoint','model','key','question','excerpt'].map(id => [id, el(id).value])));
      el('answer').textContent = answer; el('ai-result').hidden = false;
      el('ask-status').textContent = el('model').value;
    } catch (error) {
      el('ask-status').textContent = error instanceof TypeError ? '请求未完成，请核对地址、网络以及接口的跨域访问设置。' : error.message;
    } finally { for (const field of fields) field.disabled = false; }
  };
}
