import { compileDocument } from './latex-compile.js';

self.addEventListener('message', async ({ data }) => {
  try {
    const { MetaPost } = await import('./tex-engine/dist/index.js');
    const result = await compileDocument(data, { MetaPost, fontBytes: async () => {
      const response = await fetch(new URL('./tex-engine/NotoSansSC-Regular.otf', import.meta.url));
      if (!response.ok) throw new Error('未能载入随工作台提供的中文字体。');
      return new Uint8Array(await response.arrayBuffer());
    }, bibStyle: async name => {
      const response = await fetch(new URL('./tex-engine/bibstyles/' + name + '.bst', import.meta.url));
      if (!response.ok) throw new Error('无法读取参考文献样式。');
      return response.text();
    } });
    self.postMessage(result, [result.pdf.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error.message || error).slice(0, 500), log: error.log || '' });
  }
});
