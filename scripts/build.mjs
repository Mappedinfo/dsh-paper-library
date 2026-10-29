import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { buildSlides } from './build-slides.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageId = '@mappedinfo/dsh-paper-library'
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await build({
  entryPoints: [new URL('../src/client/index.mjs', import.meta.url).pathname],
  outfile: new URL('../lib/client.js', import.meta.url).pathname,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  external: ['react'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
await build({
  entryPoints: [new URL('../src/client/latex-editor.mjs', import.meta.url).pathname],
  outfile: new URL('../lib/latex-editor.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
})
await build({
  entryPoints: [new URL('../src/client/latex-spelling-entry.mjs', import.meta.url).pathname],
  outfile: new URL('../lib/latex-spelling.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  loader: { '.aff': 'text', '.dic': 'text' },
  alias: Object.fromEntries(['aff', 'dic'].map(extension => [`dictionary-en/index.${extension}`, join(dirname(fileURLToPath(import.meta.resolve('dictionary-en'))), `index.${extension}`)])),
})
await buildSlides()
console.log('Built Paper Library client, LaTeX editor and PlainDeck slides. Host entry remains native ESM.')
