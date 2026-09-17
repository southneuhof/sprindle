import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'dist-tooling')
const types = join(root, 'dist-types')
const declarations = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--emitDeclarationOnly', '--declaration', '--noEmit', 'false', '--composite', 'false', '--incremental', 'false', '--outDir', types, '--singleThreaded'], { encoding: 'utf8' })
if (declarations.error) throw new Error('TypeScript declaration build could not start.', { cause: declarations.error })
if (declarations.status !== 0) throw new Error(declarations.stderr || declarations.stdout || `TypeScript declaration build failed with ${declarations.signal ?? declarations.status}.`)
const entries = {
  build: join(root, 'tooling/build.mjs'),
  check: join(root, 'tooling/check.mjs'),
  dev: join(root, 'tooling/dev.mjs'),
  'language-server': join(root, 'tooling/language-server.mjs'),
  index: join(root, 'src/tooling/index.ts'),
}
await build({ entryPoints: entries, outdir: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, external: ['typescript/unstable/sync', 'esbuild', 'jsonc-parser', 'chokidar'] })
for (const name of ['build', 'check', 'dev', 'language-server']) chmodSync(join(output, `${name}.js`), 0o755)
