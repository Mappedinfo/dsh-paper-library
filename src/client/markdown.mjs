import { marked } from 'marked';
import DOMPurify from 'dompurify';

// 只渲染文本格式，不加载模型生成的远程图片或执行 HTML。
export function renderMarkdown(host, text) {
  const html = marked.parse(String(text), { gfm: true, breaks: true, async: false });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p','br','strong','em','del','blockquote','ul','ol','li','pre','code','h1','h2','h3','h4','h5','h6','hr','table','thead','tbody','tr','th','td','a'],
    ALLOWED_ATTR: ['href','title','start'],
    ALLOW_DATA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll('a')) {
    if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  host.replaceChildren(fragment);
}
window.PaperMarkdown = { render: renderMarkdown };
