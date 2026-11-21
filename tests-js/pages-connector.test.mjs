import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const project = fileURLToPath(new URL('..', import.meta.url));
const artifact = process.env.PAGES_ARTIFACT && resolve(process.env.PAGES_ARTIFACT);
const connector = join(artifact || join(project, 'site'), 'library');
const html = await readFile(join(connector, 'index.html'), 'utf8');
const script = await readFile(join(connector, 'connect.js'), 'utf8');

test('Pages waits for the user and navigates to the selected local PDF or LaTeX workspace', () => {
  const dom = new JSDOM(html);
  const { document, SubmitEvent, Event } = dom.window;
  const opened = [];
  vm.runInNewContext(script, { document, window: { location: { assign: url => opened.push(url) } } });
  const address = document.getElementById('address');
  const form = document.getElementById('connect');
  const submit = (input, tab) => {
    address.value = input;
    address.dispatchEvent(new Event('input'));
    const submitter = form.querySelector(`button[value="${tab}"]`);
    assert.ok(submitter, tab);
    form.dispatchEvent(new SubmitEvent('submit', { submitter, cancelable: true }));
  };

  assert.equal(address.value, '');
  assert.deepEqual(opened, []);
  for (const input of ['', 'https://example.org:7890', 'http://10.0.0.1:43122', 'http://localhost:0',
    'http://localhost:65536', 'http://127.0.0.1:43122/api', 'http://localhost:43122/?key=example']) {
    submit(input, 'pdf');
    assert.ok(address.validationMessage, input);
  }
  assert.deepEqual(opened, []);
  submit('http://127.0.0.1:43122', 'pdf');
  submit('http://localhost:43200/library/', 'latex');
  assert.equal(address.validationMessage, '');
  assert.deepEqual(opened, ['http://127.0.0.1:43122/library/#pdf', 'http://localhost:43200/library/#latex']);
  dom.window.close();
});

test('the built connector contains only the declared page assets and ships the project license', { skip: !artifact }, async () => {
  assert.deepEqual((await readdir(connector)).sort(), ['connect.js', 'index.html', 'library.css']);
  await assert.rejects(stat(join(artifact, 'library-local')), { code: 'ENOENT' });
  assert.equal(await readFile(join(artifact, 'licenses/project-MIT.txt'), 'utf8'), await readFile(join(project, 'LICENSE'), 'utf8'));
  const dom = new JSDOM(html);
  const { document } = dom.window;
  assert.match(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /connect-src 'none'/);
  assert.equal(document.querySelector('meta[name="referrer"]').content, 'no-referrer');
  for (const link of document.querySelectorAll('link[href], script[src]')) {
    const path = link.getAttribute('href') ?? link.getAttribute('src');
    assert.match(path, /^\.\/[\w.-]+$/);
    assert.ok((await stat(join(connector, path))).isFile());
  }
  assert.doesNotMatch(await readFile(join(connector, 'library.css'), 'utf8'), /@import|@font-face|url\(/i);
  dom.window.close();
});
