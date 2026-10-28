import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

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
console.log('Built lazy Paper Library client module. Host entry remains native ESM.')
