import { build } from 'esbuild'
import { cpSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const editor = fileURLToPath(new URL('.', import.meta.url))
const packageBuild = spawnSync('node', [fileURLToPath(new URL('../tooling/package.mjs', import.meta.url))], { encoding: 'utf8' })
if (packageBuild.status) throw new Error(packageBuild.stderr || packageBuild.stdout)
rmSync(fileURLToPath(new URL('./dist', import.meta.url)), { recursive: true, force: true })
rmSync(fileURLToPath(new URL('./node_modules', import.meta.url)), { recursive: true, force: true })

await build({
  entryPoints: [fileURLToPath(new URL('../src/tooling/language-server.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/language-server.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['typescript/unstable/sync', '@babel/parser', 'jsonc-parser'],
})
mkdirSync(`${editor}/node_modules/@babel`, { recursive: true })
cpSync(realpathSync(fileURLToPath(new URL('../node_modules/typescript', import.meta.url))), `${editor}/node_modules/typescript`, { recursive: true })
const platform = `@typescript+typescript-${process.platform}-${process.arch}`
const store = fileURLToPath(new URL('../../../node_modules/.pnpm', import.meta.url))
const native = readdirSync(store).find((entry) => entry.startsWith(`${platform}@`))
if (!native) throw new Error(`Missing ${platform.replace('+', '/')}`)
mkdirSync(`${editor}/node_modules/@typescript`, { recursive: true })
cpSync(`${store}/${native}/node_modules/@typescript/typescript-${process.platform}-${process.arch}`, `${editor}/node_modules/@typescript/typescript-${process.platform}-${process.arch}`, { recursive: true })
cpSync(realpathSync(fileURLToPath(new URL('../node_modules/@babel/parser', import.meta.url))), `${editor}/node_modules/@babel/parser`, { recursive: true })
for (const dependency of ['hono', 'zod', 'jsonc-parser']) cpSync(realpathSync(fileURLToPath(new URL(`../node_modules/${dependency}`, import.meta.url))), `${editor}/node_modules/${dependency}`, { recursive: true })
mkdirSync(`${editor}/routes`, { recursive: true })
cpSync(fileURLToPath(new URL('../src/routes/definition.ts', import.meta.url)), `${editor}/routes/definition.ts`)
cpSync(fileURLToPath(new URL('../dist-types', import.meta.url)), `${editor}/dist-types`, { recursive: true })
mkdirSync(`${editor}/node_modules/@southneuhof/sprindle`, { recursive: true })
cpSync(fileURLToPath(new URL('../dist-types', import.meta.url)), `${editor}/node_modules/@southneuhof/sprindle/dist-types`, { recursive: true })
cpSync(fileURLToPath(new URL('../package.json', import.meta.url)), `${editor}/node_modules/@southneuhof/sprindle/package.json`)
