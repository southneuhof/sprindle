import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

function run(root: string, command = 'check.mjs', preload?: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), '--experimental-strip-types', join(import.meta.dirname, '../../tooling', command), root], { cwd: root })
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
  for (const dependency of ['typescript', 'esbuild', 'jsonc-parser', 'hono', 'zod', 'drizzle-orm', 'chokidar']) symlinkSync(join(import.meta.dirname, '../../node_modules', dependency), join(installed, 'node_modules', dependency), 'dir')
  mkdirSync(join(root, 'node_modules', '@types'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '../../node_modules/@types/node'), join(root, 'node_modules', '@types/node'), 'dir')
  const typescript = JSON.parse(readFileSync(join(import.meta.dirname, '../../node_modules/typescript/package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> }
  const nativeCompiler = Object.keys(typescript.optionalDependencies ?? {}).find((name) => name.endsWith(`${process.platform}-${process.arch}`))
  if (nativeCompiler) {
    const source = resolve(import.meta.dirname, '../../../../node_modules/.pnpm/node_modules', nativeCompiler)
    if (existsSync(source)) { mkdirSync(dirname(join(installed, 'node_modules', nativeCompiler)), { recursive: true }); symlinkSync(source, join(installed, 'node_modules', nativeCompiler), 'dir') }
  }
  return installed
}

function runInstalled(root: string, installed: string, command: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [join(installed, 'dist-tooling', `${command}.js`), root], { cwd: root })
    let output = ''; child.stdout.on('data', (data) => output += data); child.stderr.on('data', (data) => output += data)
    child.on('close', (code) => resolve({ code, output }))
  })
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const forced = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => { clearTimeout(forced); resolve() })
    child.kill('SIGTERM')
  })
}

function waitForFile(child: ChildProcess, root: string, file: string, output: () => string) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const watcher = watch(root, { recursive: true }, check)
    const timeout = setTimeout(() => finish(new Error(`Timed out while waiting for ${file}.\n${output()}`)), 30_000)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Process exited before ${file} was ready (${code ?? signal}).\n${output()}`))
    function finish(error?: Error) { if (settled) return; settled = true; clearTimeout(timeout); watcher.close(); child.off('exit', onExit); if (error) reject(error); else resolve() }
    function check() { if (existsSync(file)) finish() }
    child.once('exit', onExit)
    check()
  })
}

test('batch command has a cold start, exact source errors, recovery, and concurrent calls', async () => {
  const { root, put } = fixture()
  const file = put('[id]/+server.ts', `export const GET=defineRoute({action:({params})=>params.missing})`)
  const [first, second] = await Promise.all([run(root), run(root)])
  for (const result of [first, second]) { expect(result.code).toBe(1); expect(result.output).toContain(file); expect(result.output).toContain('2339') }
  writeFileSync(file, `import { defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:({params})=>params.id})`)
  const recovered = await run(root); expect(recovered, recovered.output).toMatchObject({ code: 0 })
}, 120_000)

test('published build command writes a loadable static artifact', async () => {
  const { root } = fixture()
  mkdirSync(join(root, 'routes', 'health'))
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const GET=()=>({ok:true})`)
  const result = await run(root, 'build.mjs')
  expect(result.code).toBe(0)
  expect(result.output).toContain(join(root, '.sprindle', 'routes.mjs'))
  const manifest = await import(`${pathToFileURL(join(root, '.sprindle', 'routes.mjs')).href}?command`)
  expect(await manifest.default[0].handlers.GET()).toEqual({ ok: true })
}, 120_000)

test('separate builds publish immutable source versions while a reader stays active', async () => {
  const { root } = fixture()
  mkdirSync(join(root, 'routes', 'health'))
  const route = join(root, 'routes', 'health', '+server.ts')
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  writeFileSync(route, "import {defineRoute} from '@southneuhof/sprindle';export const GET=defineRoute({action:()=>({version:1 as const})})")
  expect((await run(root, 'build.mjs')).code).toBe(0)
  const sourcePointer = join(root, '.sprindle', 'routes.ts')
  const sourceVersion = (readFileSync(sourcePointer, 'utf8').match(/\.\/source\/([a-f0-9]{64})\//) ?? [])[1]
  expect(sourceVersion).toBeDefined()
  const sourceFailures: string[] = []
  const reader = setInterval(() => {
    try {
      const pointer = readFileSync(sourcePointer, 'utf8')
      const version = pointer.match(/\.\/source\/([a-f0-9]{64})\//)?.[1]
      if (!version || !existsSync(join(root, '.sprindle', 'source', version, 'routes.ts'))) sourceFailures.push(pointer)
    } catch (error) { sourceFailures.push(String(error)) }
  }, 2)
  writeFileSync(route, "import {defineRoute} from '@southneuhof/sprindle';export const GET=defineRoute({action:()=>({version:2 as const})})")
  const results = await Promise.all([run(root, 'build.mjs'), run(root, 'build.mjs')])
  clearInterval(reader)
  expect(results.every((result) => result.code === 0), results.map((result) => result.output).join('\n')).toBe(true)
  expect(sourceFailures).toEqual([])
  const nextSourceVersion = (readFileSync(sourcePointer, 'utf8').match(/\.\/source\/([a-f0-9]{64})\//) ?? [])[1]
  expect(nextSourceVersion).not.toBe(sourceVersion)
  expect(existsSync(join(root, '.sprindle', 'source', sourceVersion!, 'routes.ts'))).toBe(true)
  const runtimeBefore = readFileSync(join(root, '.sprindle', 'routes.mjs'), 'utf8')
  const sourceBefore = readFileSync(sourcePointer, 'utf8')
  writeFileSync(route, 'export const GET = (')
  const failed = await run(root, 'build.mjs')
  expect(failed.code).toBe(1)
  expect(readFileSync(join(root, '.sprindle', 'routes.mjs'), 'utf8')).toBe(runtimeBefore)
  expect(readFileSync(sourcePointer, 'utf8')).toBe(sourceBefore)
}, 120_000)

test('installed package builds source with normal Node and keeps semantic checks available', async () => {
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
  const typescriptLink = join(installed, 'node_modules', 'typescript')
  const typescriptSource = join(import.meta.dirname, '../../node_modules/typescript')
  unlinkSync(typescriptLink)
  writeFileSync(route, "import { defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:()=>({changed:true})})")
  const withoutCompiler = await runInstalled(root, installed, 'build')
  expect(withoutCompiler, withoutCompiler.output).toMatchObject({ code: 0 })
  const runtime = await import(pathToFileURL(join(root, '.sprindle', 'routes.mjs')).href + '?without-compiler')
  expect(await runtime.default[0].handlers.GET.config.action({})).toEqual({ changed: true })
  expect(existsSync(join(root, '.sprindle', 'routes.ts'))).toBe(true)
  symlinkSync(typescriptSource, typescriptLink, 'dir')
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true, types: ['node'] }, files: ['consumer.ts'] }))
  writeFileSync(join(root, 'consumer.ts'), "import type {RouteContract} from './.sprindle/routes';type Entry=Extract<RouteContract,{path:'/health';method:'get'}>['definition'];type Output=NonNullable<Entry extends {readonly output?:infer O}?O:never>;const value:Output={changed:true}")
  const consumer = spawnSync(process.execPath, [join(installed, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
  expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0)
  writeFileSync(join(root, 'consumer.ts'), "import type {RouteContract} from './.sprindle/routes';type Entry=Extract<RouteContract,{path:'/health';method:'get'}>['definition'];type Output=NonNullable<Entry extends {readonly output?:infer O}?O:never>;const wrong:Output=1")
  const invalidConsumer = spawnSync(process.execPath, [join(installed, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
  expect(invalidConsumer.status).not.toBe(0)
  expect(invalidConsumer.stdout + invalidConsumer.stderr).toContain('TS2322')
  expect(readFileSync(join(installed, 'dist-tooling', 'check.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  rmSync(join(root, 'routes'), { recursive: true, force: true })
  mkdirSync(join(root, 'routes'))
  mkdirSync(join(root, 'routes', 'health'))
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const GET=()=>({ok:true})`)
  rmSync(join(root, 'consumer.ts'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, include: ['routes/**/*.ts'] }))
  rmSync(join(root, '.sprindle'), { recursive: true, force: true })
  const dev = spawn(process.execPath, [join(installed, 'dist-tooling/dev.js'), root], { cwd: root })
  let devOutput = ''; dev.stdout?.on('data', (data) => devOutput += data); dev.stderr?.on('data', (data) => devOutput += data)
  try {
    await waitForFile(dev, root, join(root, '.sprindle/routes.mjs'), () => devOutput)
    expect(existsSync(join(root, '.sprindle/routes.mjs'))).toBe(true)
  } finally { await stop(dev) }
  const server = spawn(process.execPath, [join(installed, 'dist-tooling/language-server.js')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  let response = '', serverError = ''
  server.stderr.on('data', (data) => serverError += data)
  try {
    const initialized = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Language server initialization timed out.\nstdout:\n${response}\nstderr:\n${serverError}`)), 30_000)
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Language server exited before initialization (${code ?? signal}).\nstdout:\n${response}\nstderr:\n${serverError}`))
      const onData = (data: Buffer) => { response += data; if (response.includes('"id":1')) finish() }
      function finish(error?: Error) { clearTimeout(timeout); server.off('exit', onExit); server.stdout.off('data', onData); if (error) reject(error); else resolve() }
      server.once('exit', onExit)
      server.stdout.on('data', onData)
    })
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: pathToFileURL(root).href, initializationOptions: { routesDirectory: 'routes' } } }))
    server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); server.stdin.write(body)
    await initialized
    expect(response).toContain('"id":1')
  } finally { await stop(server) }
}, 120_000)
