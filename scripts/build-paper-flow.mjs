import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const local = path => fileURLToPath(new URL(`../${path}`, import.meta.url))
export async function buildPaperFlow() {
  await mkdir(local('lib/'), { recursive: true })
  await build({
    entryPoints: [local('src/paper-flow/main.tsx')], outfile: local('lib/paper-flow-editor.js'),
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    legalComments: 'inline', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'paper-flow-inline-styles', setup(builder) {
      builder.onResolve({ filter: /\.css\?inline$/ }, args => ({ path: resolve(dirname(args.importer), args.path.replace(/\?inline$/, '')), namespace: 'paper-flow-css' }))
      builder.onLoad({ filter: /./, namespace: 'paper-flow-css' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
    } }],
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPaperFlow()
