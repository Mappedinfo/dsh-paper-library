import { api } from './client.js';
import { mountPdf } from './pdf.js';
import { mountLatex } from './latex.js';

const find = id => document.getElementById(id);
const mounted = new Set();
const panels = { pdf: mountPdf, latex: mountLatex };
async function showPanel() {
  const view = location.hash === '#latex' ? 'latex' : 'pdf';
  for (const link of document.querySelectorAll('[data-view]')) {
    const active = link.dataset.view === view;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
    find(link.dataset.view + '-panel').hidden = !active;
  }
  if (mounted.has(view)) return;
  mounted.add(view);
  try { await panels[view](find(view + '-panel')); }
  catch (error) { mounted.delete(view); showError(error); }
}
function showError(error) {
  find('workspace-error').hidden = false;
  find('error-text').textContent = error.message;
}

const dialog = find('assistant-dialog');
find('assistant-open').addEventListener('click', () => dialog.showModal());
find('assistant-close').addEventListener('click', () => dialog.close());
find('assistant-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type=submit]');
  if (button.disabled) return;
  button.disabled = true;
  find('answer-block').hidden = true;
  find('ask-status').textContent = '等待模型回答…';
  try {
    const { answer, model } = await api('/api/pages/ask', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: find('question').value, excerpt: find('excerpt').value }) });
    find('answer-text').textContent = answer;
    find('answer-block').hidden = false;
    find('ask-status').textContent = model;
  } catch (error) { find('ask-status').textContent = error.message; }
  finally { button.disabled = false; }
});

async function connect() {
  find('retry').disabled = true;
  try {
    const connection = await api('/api/pages/connection');
    find('workspace-error').hidden = true;
    find('library-name').textContent = connection.name;
    find('library-name').title = connection.library;
    find('model-detail').textContent = connection.api
      ? '发送目标 ' + connection.api.endpoint + ' · ' + connection.api.model + '。请粘贴要提交的内容。'
      : '模型 API 已关闭。要使用片段问答，请在本机启动命令中填写 --api-url 和 --api-model。需要密钥时，用 --api-key-env 指定环境变量名。';
    find('assistant-form').hidden = !connection.api;
    window.addEventListener('hashchange', showPanel);
    await showPanel();
  } catch (error) { showError(error); }
  finally { find('retry').disabled = false; }
}
find('retry').addEventListener('click', connect);
await connect();
