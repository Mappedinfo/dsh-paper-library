import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);let JSDOM;
try{({JSDOM}=require(process.env.JSDOM_MODULE||'jsdom'));}catch{}
test('chat Markdown renders structure while excluding executable HTML and remote media',{skip:!JSDOM},async()=>{
  const bundled=await build({entryPoints:['src/client/markdown.mjs'],bundle:true,write:false,format:'iife',platform:'browser'});
  const dom=new JSDOM('<div id="body"></div>',{runScripts:'outside-only',url:'http://synthetic.invalid/'}),{window}=dom;
  window.eval(bundled.outputFiles[0].text);const host=window.document.getElementById('body');
  window.PaperMarkdown.render(host,'## Heading\n\n**批注类型判断**：释义。\n\n> Source\n\n- One\n- Two\n\n```js\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[Good](https://example.org) [Bad](javascript:alert(1))\n\n<img src="https://example.org/tracker" onerror="alert(1)"><script>alert(1)</script><iframe src="https://example.org"></iframe>');
  assert.equal(host.querySelector('strong').textContent,'批注类型判断');assert.equal(host.querySelectorAll('li').length,2);assert.ok(host.querySelector('blockquote'));assert.ok(host.querySelector('pre code'));assert.ok(host.querySelector('table'));
  assert.equal(host.querySelectorAll('script,img,iframe,[onerror]').length,0);assert.equal(host.querySelector('a').getAttribute('rel'),'noopener noreferrer');assert.equal(host.querySelectorAll('a[href^="javascript:"]').length,0);
  dom.window.close();
});
