import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../vendor/csl/', import.meta.url));
await mkdir(root, { recursive: true });
const resources = [
  ['apa.csl', 'https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl'],
  ['locales-en-US.xml', 'https://raw.githubusercontent.com/citation-style-language/locales/master/locales-en-US.xml'],
];
const manifest = { retrieved: new Date().toISOString(), resources: [] };
for (const [name, url] of resources) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`CSL fetch failed: ${response.status} ${name}`);
  const body = await response.text();
  if (!body.includes('<?xml') || body.length < 2000) throw new Error(`Invalid CSL asset ${name}`);
  await writeFile(`${root}/${name}`, body);
  manifest.resources.push({ name, url, sha256: createHash('sha256').update(body).digest('hex') });
}
await writeFile(`${root}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('Official APA style and English locale saved with SHA-256 provenance.');
