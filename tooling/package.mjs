import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = new URL('../', import.meta.url).pathname
const output = join(root, 'dist-tooling')
const types = join(root, 'dist-types')
const declarations = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.json'), '--emitDeclarationOnly', '--declaration', '--noEmit', 'false', '--composite', 'false', '--incremental', 'false', '--outDir', types, '--singleThreaded'], { encoding: 'utf8' })
if (declarations.status) throw new Error(declarations.stderr || declarations.stdout)
const entries = {
  build: join(root, 'tooling/build.mjs'),
  check: join(root, 'tooling/check.mjs'),
  dev: join(root, 'tooling/dev.mjs'),
  'language-server': join(root, 'tooling/language-server.mjs'),
  index: join(root, 'src/tooling/index.ts'),
}
await build({ entryPoints: entries, outdir: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, external: ['typescript/unstable/sync', 'esbuild', 'jsonc-parser'] })
for (const name of ['build', 'check', 'dev', 'language-server']) chmodSync(join(output, `${name}.js`), 0o755)
