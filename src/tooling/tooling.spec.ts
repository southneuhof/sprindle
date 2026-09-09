import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'

const projects: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sprindle-tooling-test-')); projects.push(root)
  mkdirSync(join(root, 'routes'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, include: ['routes/**/*.ts'] }))
  const put = (name: string, source: string) => { const file = join(root, 'routes', name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `import { defineRoute } from '@southneuhof/sprindle';${source}`); return file }
  return { root, put }
}
afterEach(() => projects.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function run(root: string, command = 'check.mjs') {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '../../tooling', command), root], { cwd: root })
    let output = ''; child.stdout.on('data', (data) => output += data); child.stderr.on('data', (data) => output += data)
    child.on('close', (code) => resolve({ code, output }))
  })
}

function installTooling(root: string) {
  const installed = join(root, 'node_modules/@southneuhof/sprindle')
  mkdirSync(installed, { recursive: true })
  const packageRoot = join(import.meta.dirname, '../..')
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', root], { cwd: packageRoot, encoding: 'utf8' })
  if (packed.status) throw new Error(packed.stderr || packed.stdout)
  const archive = join(root, readdirSync(root).find((file) => file.endsWith('.tgz'))!)
  const extracted = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', installed], { encoding: 'utf8' })
  if (extracted.status) throw new Error(extracted.stderr)
  mkdirSync(join(installed, 'node_modules'), { recursive: true })
  for (const dependency of ['typescript', 'esbuild', 'jsonc-parser', 'hono', 'zod', 'drizzle-orm']) symlinkSync(join(import.meta.dirname, '../../node_modules', dependency), join(installed, 'node_modules', dependency), 'dir')
  return installed
}

function runInstalled(root: string, installed: string, command: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [join(installed, 'dist-tooling', `${command}.js`), root], { cwd: root })
    let output = ''; child.stdout.on('data', (data) => output += data); child.stderr.on('data', (data) => output += data)
    child.on('close', (code) => resolve({ code, output }))
  })
}

test('batch command has a cold start, exact source errors, recovery, and concurrent calls', async () => {
  const { root, put } = fixture()
  const file = put('[id]/+server.ts', `export const GET=defineRoute({action:({params})=>params.missing})`)
  const [first, second] = await Promise.all([run(root), run(root)])
  for (const result of [first, second]) { expect(result.code).toBe(1); expect(result.output).toContain(file); expect(result.output).toContain('2339') }
  writeFileSync(file, `import { defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:({params})=>params.id})`)
  const recovered = await run(root); expect(recovered, recovered.output).toMatchObject({ code: 0 })
}, 20_000)

test('published build command writes a loadable static artifact', async () => {
  const { root } = fixture()
  mkdirSync(join(root, 'routes', 'health'))
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const GET=()=>({ok:true})`)
  const result = await run(root, 'build.mjs')
  expect(result.code).toBe(0)
  expect(result.output).toContain(join(root, '.sprindle', 'routes.mjs'))
  const manifest = await import(`${pathToFileURL(join(root, '.sprindle', 'routes.mjs')).href}?command`)
  expect(await manifest.default[0].handlers.GET()).toEqual({ ok: true })
})

test('separate builds publish immutable declarations while a reader stays active', async () => {
  const { root } = fixture()
  mkdirSync(join(root, 'routes', 'health'))
  const route = join(root, 'routes', 'health', '+server.ts')
  writeFileSync(route, `export const GET=()=>({version:1 as const})`)
  expect((await run(root, 'build.mjs')).code).toBe(0)
  writeFileSync(route, `export const GET=()=>({version:2 as const})`)
  const readerErrors: string[] = []
  const reader = setInterval(() => {
    try {
      const source = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
      const match = source.match(/\.\/contracts\/([^/]+)\/routes\/health\/\+server/)
      if (!match || !existsSync(join(root, '.sprindle', 'contracts', match[1], 'routes', 'health', '+server.d.ts'))) readerErrors.push(source)
    } catch (error) { readerErrors.push(String(error)) }
  }, 2)
  const results = await Promise.all([run(root, 'build.mjs'), run(root, 'build.mjs')])
  clearInterval(reader)
  expect(results.every((result) => result.code === 0), results.map((result) => result.output).join('\n')).toBe(true)
  expect(readerErrors).toEqual([])
  const runtimeBefore = readFileSync(join(root, '.sprindle', 'routes.mjs'), 'utf8')
  const typesBefore = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  writeFileSync(route, `export const GET = (`)
  const failed = await run(root, 'build.mjs')
  expect(failed.code).toBe(1)
  expect(readFileSync(join(root, '.sprindle', 'routes.mjs'), 'utf8')).toBe(runtimeBefore)
  expect(readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')).toBe(typesBefore)
  expect(readdirSync(root).filter((name) => name.startsWith('.sprindle-contract'))).toEqual([])
}, 20_000)

test('installed package commands run with normal Node from node_modules', async () => {
  const { root } = fixture()
  const installed = installTooling(root)
  writeFileSync(join(root, 'routes', '+scope.ts'), `import { defineScope, unauthorized } from '@southneuhof/sprindle';export default defineScope({context:()=>({user:{id:'u'}}),authorize:()=>{throw unauthorized()}})`)
  mkdirSync(join(root, 'routes', 'health'))
  const route = join(root, 'routes', 'health', '+server.ts')
  writeFileSync(route, `import { defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:({context})=>context.missing})`)
  const invalid = await runInstalled(root, installed, 'check'); expect(invalid.code).toBe(1); expect(invalid.output).toContain('2339')
  writeFileSync(route, `import { defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:({context})=>context.user.id})`)
  expect((await runInstalled(root, installed, 'check')).code).toBe(0)
  const build = await runInstalled(root, installed, 'build'); expect(build, build.output).toMatchObject({ code: 0 })
  const runtimeBefore = readFileSync(join(root, '.sprindle', 'routes.mjs'), 'utf8')
  const typesBefore = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  const typescriptLink = join(installed, 'node_modules', 'typescript')
  unlinkSync(typescriptLink)
  mkdirSync(typescriptLink)
  const typescriptSource = join(import.meta.dirname, '../../node_modules/typescript')
  for (const item of readdirSync(typescriptSource, { withFileTypes: true })) if (item.name !== 'bin') {
    if (item.name === 'package.json') writeFileSync(join(typescriptLink, item.name), readFileSync(join(typescriptSource, item.name)))
    else symlinkSync(join(typescriptSource, item.name), join(typescriptLink, item.name), item.isDirectory() ? 'dir' : 'file')
  }
  writeFileSync(route, `import { defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:()=>({changed:true})})`)
  const missingCompiler = await runInstalled(root, installed, 'build')
  expect(missingCompiler.code).toBe(1)
  expect(missingCompiler.output).toContain('TypeScript compiler dependency is missing')
  expect(readFileSync(join(root, '.sprindle', 'routes.mjs'), 'utf8')).toBe(runtimeBefore)
  expect(readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')).toBe(typesBefore)
  rmSync(typescriptLink, { recursive: true })
  symlinkSync(typescriptSource, typescriptLink, 'dir')
  rmSync(join(root, 'routes'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, files: ['consumer.ts'] }))
  writeFileSync(join(root, 'consumer.ts'), `import type {RouteContract} from './.sprindle/routes';type Entry=Extract<RouteContract,{path:'/health';method:'get'}>['definition'];type Output=NonNullable<Entry extends {readonly output?:infer O}?O:never>;const value:Output='u';// @ts-expect-error custom output is a string\nconst wrong:Output=1;`)
  const consumer = spawnSync(process.execPath, [join(installed, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
  expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0)
  expect(readFileSync(join(installed, 'dist-tooling', 'check.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  if (process.platform === 'darwin') expect(createRequire(join(installed, 'resolve.cjs')).resolve(`@typescript/typescript-darwin-${process.arch}/package.json`)).toContain('@typescript')
  mkdirSync(join(root, 'routes'))
  mkdirSync(join(root, 'routes', 'health'))
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const GET=()=>({ok:true})`)
  rmSync(join(root, 'consumer.ts'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, include: ['routes/**/*.ts'] }))
  rmSync(join(root, '.sprindle'), { recursive: true, force: true })
  const dev = spawn(process.execPath, [join(installed, 'dist-tooling/dev.js'), root], { cwd: root })
  for (let attempt = 0; attempt < 200 && !existsSync(join(root, '.sprindle/routes.mjs')); attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(existsSync(join(root, '.sprindle/routes.mjs'))).toBe(true); dev.kill('SIGTERM'); await new Promise((resolve) => dev.once('exit', resolve))
  const server = spawn(process.execPath, [join(installed, 'dist-tooling/language-server.js')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: pathToFileURL(root).href, initializationOptions: { routesDirectory: 'routes' } } }))
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); server.stdin.write(body)
  let response = ''; server.stdout.on('data', (data) => response += data)
  for (let attempt = 0; attempt < 40 && !response.includes('"id":1'); attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(response).toContain('"id":1'); server.kill('SIGTERM'); await new Promise((resolve) => server.once('exit', resolve))
}, 30_000)
