import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const local = path => fileURLToPath(new URL(`../${path}`, import.meta.url))
const alias = {
  'plaindeck/core': local('vendor/plaindeck/packages/plaindeck/src/core/index.ts'),
  'plaindeck/react': local('vendor/plaindeck/packages/plaindeck/src/react/index.tsx'),
  'plaindeck/render': local('vendor/plaindeck/packages/plaindeck/src/render/index.ts'),
}
export async function buildSlides({ coreOnly = false } = {}) {
  await mkdir(local('lib/'), { recursive: true })
  await build({
    entryPoints: [local('src/slides/core-entry.mjs')], outfile: local('lib/plaindeck-core.mjs'),
    bundle: true, format: 'esm', platform: 'node', target: 'node22', minify: true, legalComments: 'inline',
  })
  if (coreOnly) return
  await build({
    entryPoints: [local('src/slides/main.tsx')], outfile: local('lib/slides-editor.js'),
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    legalComments: 'inline', alias, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"./"' },
    plugins: [{ name: 'paper-library-slides-storage', setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)(?:browserStorage|language)$/ }, args => {
        if (!args.importer.startsWith(local('vendor/plaindeck/'))) return
        const target = resolve(dirname(args.importer), args.path)
        if (target === local('vendor/plaindeck/src/storage/browserStorage')) return { path: local('src/slides/storage.ts') }
        if (target === local('vendor/plaindeck/src/core/language')) return { path: local('src/slides/language.ts') }
      })
    } }],
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildSlides({ coreOnly: process.argv.includes('--core') })
