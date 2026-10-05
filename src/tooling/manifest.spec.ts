import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, expect, test, vi } from 'vitest'
import { Hono } from 'hono'
import { build } from 'esbuild'
import { compileRouteManifest, watchRouteManifest } from './manifest'
import { installSprindle } from '../hono/index.ts'

const filesystemFailure = vi.hoisted(() => ({ failOwnerWrite: false }))

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>()
  return { ...actual, build: vi.fn(actual.build) }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const seen: unknown[] = []
  ;(globalThis as Record<string, unknown>).__manifestLinkKinds = seen
  const symlinkSync = ((target: string, path: string, type?: unknown) => {
    seen.push(type)
    return actual.symlinkSync(target, path, (type === 'junction' ? 'dir' : type) as 'dir')
  }) as typeof actual.symlinkSync
  return { ...actual, symlinkSync }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (filesystemFailure.failOwnerWrite && String(args[0]).replaceAll('\\', '/').endsWith('/generation.lock/owner.json')) {
        filesystemFailure.failOwnerWrite = false
        throw Object.assign(new Error('owner record write failed'), { code: 'EIO' })
      }
      return actual.writeFile(...args)
    },
  }
})

const roots: string[] = []
function fixture(source = `export const GET = () => 'healthy'`) { const root = mkdtempSync(join(process.cwd(), 'node_modules', '.sprindle-manifest-')); roots.push(root); mkdirSync(join(root, 'routes', 'health'), { recursive: true }); writeFileSync(join(root, 'tsconfig.json'), '{}'); writeFileSync(join(root, 'routes', 'health', '+server.ts'), source); return root }
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

test('writes one atomic artifact with file, helper, and extended config inputs', { timeout: 120_000 }, async () => {
  const root = fixture()
  writeFileSync(join(root, 'config.base.json'), '{"compilerOptions":{"strict":true}}')
  writeFileSync(join(root, 'tsconfig.json'), '{"extends":"./config.base.json"}')
  const [first, second] = await Promise.all([compileRouteManifest(root), compileRouteManifest(root)])
  expect(first).toBe(second)
  const before = await import(`${pathToFileURL(first).href}?before`)
  expect(before.default[0]).toMatchObject({ sourcePath: 'routes/health/+server.ts', httpPath: '/health', methods: ['GET'] })
  writeFileSync(join(root, 'helper.ts'), `export const value='changed'`)
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `import { value } from '../../helper'; export const POST=()=>value`)
  await compileRouteManifest(root); const after = await import(`${pathToFileURL(first).href}?after`); expect(after.hash).not.toBe(before.hash)
  writeFileSync(join(root, 'config.base.json'), '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}')
  await compileRouteManifest(root); const configured = await import(`${pathToFileURL(first).href}?configured`); expect(configured.hash).not.toBe(after.hash)
  expect(await import('node:fs/promises').then(({ readFile }) => readFile(first, 'utf8'))).not.toMatch(/typescript\/unstable|@babel\/parser/)
  rmSync(join(root, 'routes'), { recursive: true })
  rmSync(join(root, 'helper.ts'))
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', `const m=await import(${JSON.stringify(pathToFileURL(first).href)});process.stdout.write(m.default[0].handlers.POST())`], { encoding: 'utf8' })
  expect(run.stderr).toBe(''); expect(run.stdout).toBe('changed')
})

test('reclaims stale generation ownership while separate generators wait', { timeout: 120_000 }, async () => {
  const root = fixture()
  const lock = join(root, '.sprindle', 'generation.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'stale-owner' }))
  const barrier = join(root, 'start-generators')
  const runner = join(root, 'compile.mts')
  const manifest = pathToFileURL(join(import.meta.dirname, 'manifest.ts')).href
  writeFileSync(runner, `import {existsSync} from 'node:fs';import {compileRouteManifest} from ${JSON.stringify(manifest)};process.stdout.write('ready\\n');while(!existsSync(process.argv[3]!))await new Promise(done=>setTimeout(done,10));await compileRouteManifest(process.argv[2]!, 'routes', '.sprindle/routes.mjs', true)`)
  const tsx = join(import.meta.dirname, '../../../../apps/api/node_modules/.bin/tsx')
  const children = [spawn(tsx, [runner, root, barrier], { cwd: root }), spawn(tsx, [runner, root, barrier], { cwd: root })]
  const results = children.map((child) => new Promise<{ code: number | null; output: string }>((resolve) => {
    let output = ''
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { output += data.toString() })
    child.once('close', (code) => resolve({ code, output }))
  }))
  let ready = 0
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Concurrent route generators did not reach the start barrier.')), 30_000)
    for (const child of children) {
      let announced = false
      let output = ''
      child.stdout.on('data', (data) => {
        output += data.toString()
        if (!announced && output.includes('ready')) {
          announced = true
          ready++
          if (ready === children.length) { clearTimeout(timeout); resolve() }
        }
      })
      child.once('close', (code) => { if (!announced) { clearTimeout(timeout); reject(new Error(`Generator exited before the barrier (${code ?? 'signal'}).`)) } })
    }
  })
  try {
    await readyPromise
    writeFileSync(barrier, 'start')
    const completed = await Promise.all(results)
    expect(completed.map(({ code }) => code)).toEqual([0, 0])
    expect(completed.map(({ output }) => output).join('')).toBe('ready\nready\n')
    expect(existsSync(lock)).toBe(false)
    const target = join(root, '.sprindle/routes.mjs')
    const generated = await import(`${pathToFileURL(target).href}?stale-lock`)
    expect(generated.default).toHaveLength(1)
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.all(results)
  }
})

test('removes a new generation directory when its owner record cannot be written', async () => {
  const root = fixture()
  const lock = join(root, '.sprindle', 'generation.lock')
  filesystemFailure.failOwnerWrite = true
  await expect(compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)).rejects.toThrow('owner record write failed')
  expect(existsSync(lock)).toBe(false)
  await expect(compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)).resolves.toBe(join(root, '.sprindle/routes.mjs'))
})

test('removes obsolete declaration pointers without pruning their old versions', async () => {
  const root = fixture()
  const oldVersion = join(root, '.sprindle', 'contracts', 'old')
  mkdirSync(oldVersion, { recursive: true })
  writeFileSync(join(oldVersion, 'route.d.ts'), 'export type Old = true')
  writeFileSync(join(root, '.sprindle', 'routes.d.ts'), 'export type RouteContract = never')
  writeFileSync(join(root, '.sprindle', ['routes', 'declarations.json'].join('.')), '{}')
  const target = await compileRouteManifest(root, 'routes', '.sprindle-dev/routes.mjs')
  const manifest = await import(pathToFileURL(target).href + '?retired-contract')
  expect(await manifest.default[0].handlers.GET()).toBe('healthy')
  expect(existsSync(join(root, '.sprindle', 'routes.ts'))).toBe(true)
  expect(existsSync(join(root, '.sprindle', 'routes.d.ts'))).toBe(false)
  expect(existsSync(join(root, '.sprindle', ['routes', 'declarations.json'].join('.')))).toBe(false)
  expect(readFileSync(join(oldVersion, 'route.d.ts'), 'utf8')).toBe('export type Old = true')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  const customTarget = await compileRouteManifest(root, 'routes', 'custom.js', true)
  expect(customTarget).toBe(join(root, 'custom.js'))
  expect(existsSync(customTarget)).toBe(true)
  const custom = await import(`${pathToFileURL(customTarget).href}?custom-runtime-output`)
  expect(await custom.default[0].handlers.GET()).toBe('healthy')
  const customSourceTarget = await compileRouteManifest(root, 'routes', 'custom-source.js', false)
  expect(existsSync(customSourceTarget)).toBe(true)
  const customSource = runTsxFixture(root, 'custom-source.mts', `const custom=await import(${JSON.stringify(`${pathToFileURL(customSourceTarget).href}?custom-source-runtime-output`)});process.stdout.write(await custom.default[0].handlers.GET())`)
  expect(customSource.status, customSource.stdout + customSource.stderr).toBe(0)
  expect(customSource.stdout).toBe('healthy')
})

test('watcher startup compiles exactly once', { timeout: 120_000 }, async () => {
  const root = fixture(); const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  await watcher.close()
  expect(callbacks).toHaveLength(1)
})

test('watch ignores edits outside routes and inputs', { timeout: 120_000 }, async () => {
  const root = fixture(); const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  try {
    const start = callbacks.length
    expect(watcher.hasInput(join(root, 'routes/health/+server.ts'))).toBe(true)
    expect(watcher.hasInput(join(root, 'routes/.sprindle-dev/generated.ts'))).toBe(false)
    expect(watcher.hasInput(join(root, 'notes.txt'))).toBe(false)
    writeFileSync(join(root, 'notes.txt'), 'unrelated')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    const tool = join(root, 'scripts', 'tool.ts')
    writeFileSync(tool, `export const tool = 1`)
    expect(watcher.hasInput(tool)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(callbacks).toHaveLength(start)
    writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const POST = () => 'changed'`)
    await vi.waitFor(() => { expect(callbacks).toHaveLength(start + 1); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('watch follows new dependency directories after import', { timeout: 120_000 }, async () => {
  const root = fixture(); const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  try {
    const helper = join(root, 'helper.ts')
    const route = join(root, 'routes', 'health', '+server.ts')
    expect(watcher.hasInput(helper)).toBe(false)
    expect(watcher.hasInput(route)).toBe(true)
    writeFileSync(helper, `export const value = 'one'`)
    writeFileSync(route, `import { value } from '../../helper'; export const POST = () => value`)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThanOrEqual(2); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    expect(watcher.hasInput(helper)).toBe(true)
    const imported = callbacks.length
    writeFileSync(join(root, 'helper.ts'), `export const value = 'two'`)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(imported); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    const beforeDelete = callbacks.length
    rmSync(helper)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(beforeDelete); expect(callbacks.at(-1)).toBeInstanceOf(Error) }, { timeout: 30_000 })
    expect(watcher.hasInput(helper)).toBe(true)
    const beforeRestore = callbacks.length
    writeFileSync(helper, `export const value = 'three'`)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(beforeRestore); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    expect(watcher.hasInput(helper)).toBe(true)
    const shared = join(root, 'shared-real')
    const linked = join(root, 'shared')
    const realHelper = join(shared, 'helper.ts')
    const linkedHelper = join(linked, 'helper.ts')
    mkdirSync(shared)
    symlinkSync(shared, linked, 'dir')
    writeFileSync(realHelper, `export const value = 'linked-one'`)
    const beforeLink = callbacks.length
    writeFileSync(route, `import { value } from '../../shared/helper'; export const POST = () => value`)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(beforeLink); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    expect(watcher.hasInput(realHelper)).toBe(true)
    expect(watcher.hasInput(linkedHelper)).toBe(true)
    const beforeLinkedChange = callbacks.length
    writeFileSync(realHelper, `export const value = 'linked-two'`)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(beforeLinkedChange); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('watch recovers after an invalid source tree is fixed', { timeout: 120_000 }, async () => {
  const root = fixture(); const errors: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => errors.push(error))
  const invalid = join(root, 'routes', 'bad route', '+server.ts'); mkdirSync(dirname(invalid), { recursive: true }); writeFileSync(invalid, 'export const GET = 1')
  await vi.waitFor(() => expect(errors.some(Boolean)).toBe(true), { timeout: 30_000 })
  rmSync(dirname(invalid), { recursive: true }); writeFileSync(join(root, 'routes', 'health', '+server.ts'), 'export const GET = 1')
  const errorCount = errors.length
  await vi.waitFor(() => { expect(errors.length).toBeGreaterThan(errorCount); expect(errors.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  await watcher.close()
})

test('watch close cancels a pending edit without reopening handles', { timeout: 120_000 }, async () => {
  const root = fixture(); const results: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => results.push(error))
  const count = results.length
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const POST = () => 'changed'`)
  await watcher.close()
  await new Promise((resolve) => setTimeout(resolve, 75))
  expect(results).toHaveLength(count)
})

test('watch fires on new route directory add', { timeout: 120_000 }, async () => {
  // A new route directory must start a compile.
  const root = fixture(); const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  try {
    const start = callbacks.length
    const added = join(root, 'routes', 'added', '+server.ts'); mkdirSync(dirname(added), { recursive: true }); writeFileSync(added, `export const GET = () => 'added'`)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(start); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('watch fires on route directory rename', { timeout: 120_000 }, async () => {
  // A renamed route directory must start a compile.
  const root = fixture(); const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  try {
    const added = join(root, 'routes', 'added', '+server.ts'); mkdirSync(dirname(added), { recursive: true }); writeFileSync(added, `export const GET = () => 'added'`)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(1); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    const moved = callbacks.length
    renameSync(join(root, 'routes', 'added'), join(root, 'routes', 'moved'))
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(moved); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('watch fires on route file delete', { timeout: 120_000 }, async () => {
  // A deleted route file must start a compile.
  const root = fixture(); const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  try {
    const start = callbacks.length
    const route = join(root, 'routes', 'health', '+server.ts')
    rmSync(route)
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(start) }, { timeout: 30_000 })
    writeFileSync(route, `export const GET = () => 'healthy'`)
    await vi.waitFor(() => { expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('watch ignores tooling and dependency output writes', { timeout: 120_000 }, async () => {
  // Tooling output writes must not start a compile.
  const root = fixture(); const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  try {
    const start = callbacks.length
    for (const file of [join(root, 'node_modules', 'pkg', 'index.js'), join(root, '.git', 'index'), join(root, 'dist', 'out.js'), join(root, '.sprindle', 'routes.mjs')]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'ignored') }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(callbacks).toHaveLength(start)
    writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const POST = () => 'changed'`)
    await vi.waitFor(() => { expect(callbacks).toHaveLength(start + 1); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

function dependencyFixture(files: Record<string, string>) {
  const root = fixture()
  for (const [file, source] of Object.entries(files)) {
    const target = join(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source)
  }
  return root
}

function runTsxFixture(root: string, filename: string, source: string) {
  const runner = join(root, filename)
  writeFileSync(runner, source)
  return spawnSync(join(import.meta.dirname, '..', '..', '..', '..', 'apps', 'api', 'node_modules', '.bin', 'tsx'), [runner], { cwd: root, encoding: 'utf8' })
}

test.each([true, false])('tracks JSON, dynamic import, and require inputs through runtime recovery in bundle=%s mode', { timeout: 120_000 }, async (bundle) => {
  const root = fixture(`declare const require:(specifier:string)=>{value:string};import payload from '../../payload.json';import {defineRoute} from '@southneuhof/sprindle';export const GET=defineRoute({action:async()=>({json:payload.value,dynamic:(await import(\`../../external\`)).value,required:require('../../required').value})})`)
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { resolveJsonModule: true } }))
  const json = join(root, 'payload.json')
  const dynamic = join(root, 'external.ts')
  const required = join(root, 'required.ts')
  writeFileSync(json, JSON.stringify({ value: 'json-one' }))
  writeFileSync(dynamic, `export const value='dynamic-one'`)
  writeFileSync(required, `export const value='require-one'`)
  const output = bundle ? '.sprindle/routes.mjs' : '.sprindle/routes-source.mjs'
  const target = await compileRouteManifest(root, 'routes', output, bundle)
  let load = 0
  const request = async () => {
    if (!bundle) {
      const runner = runTsxFixture(root, 'source-request.mts', `import {Hono} from 'hono';import {installSprindle} from '@southneuhof/sprindle/hono';const module=await import(${JSON.stringify(`${pathToFileURL(target).href}?version=${load++}`)});const response=await installSprindle(new Hono(),module.default).request('/health');process.stdout.write(JSON.stringify({status:response.status,body:response.status>=500?await response.text():await response.json()}))`)
      expect(runner.status, runner.stdout + runner.stderr).toBe(0)
      return JSON.parse(runner.stdout)
    }
    const module = await import(`${pathToFileURL(target).href}?version=${load++}`)
    const response = await installSprindle(new Hono(), module.default).request('/health')
    return { status: response.status, body: response.status >= 500 ? await response.text() : await response.json() }
  }
  const initial = await request()
  expect(initial).toEqual({ status: 200, body: { json: 'json-one', dynamic: 'dynamic-one', required: 'require-one' } })
  const results: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => results.push(error), output, bundle)
  try {
    expect(watcher.hasInput(json)).toBe(true)
    expect(watcher.hasInput(dynamic)).toBe(true)
    expect(watcher.hasInput(required)).toBe(true)
    let before = results.length
    writeFileSync(dynamic, `export const value='dynamic-two'`)
    await vi.waitFor(() => { expect(results.length).toBeGreaterThan(before); expect(results.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    expect(await request()).toEqual({ status: 200, body: { json: 'json-one', dynamic: 'dynamic-two', required: 'require-one' } })
    before = results.length
    writeFileSync(dynamic, `export const value: = 'invalid'`)
    await vi.waitFor(() => { expect(results.length).toBeGreaterThan(before); expect(results.at(-1)).toBeInstanceOf(Error) }, { timeout: 30_000 })
    expect(await request()).toEqual(bundle
      ? { status: 200, body: { json: 'json-one', dynamic: 'dynamic-two', required: 'require-one' } }
      : { status: 500, body: 'Internal Server Error' })
    before = results.length
    writeFileSync(dynamic, `export const value='dynamic-three'`)
    await vi.waitFor(() => { expect(results.length).toBeGreaterThan(before); expect(results.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    expect(await request()).toEqual({ status: 200, body: { json: 'json-one', dynamic: 'dynamic-three', required: 'require-one' } })
    before = results.length
    writeFileSync(json, JSON.stringify({ value: 'json-two' }))
    await vi.waitFor(() => { expect(results.length).toBeGreaterThan(before); expect(results.at(-1)).toBeUndefined() }, { timeout: 30_000 })
    expect(await request()).toEqual({ status: 200, body: { json: 'json-two', dynamic: 'dynamic-three', required: 'require-one' } })
  } finally { await watcher.close() }
})

test.each([true, false])('keeps CommonJS require cycles as runtime dependencies in bundle=%s mode', { timeout: 120_000 }, async (bundle) => {
  const root = dependencyFixture({
    'routes/health/+server.ts': `import value from '../../lib/a.cjs';import {defineRoute} from '@southneuhof/sprindle';export const GET=defineRoute({action:()=>({value:value.other})})`,
    'lib/a.cjs': `exports.value='a';const b=require('./b.cjs');exports.other=b.value;`,
    'lib/b.cjs': `exports.value='b';const a=require('./a.cjs');exports.other=a.value;`,
  })
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  const target = await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', bundle)
  const results: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => results.push(error), '.sprindle/routes.mjs', bundle)
  try {
    expect(watcher.hasInput(join(root, 'lib', 'a.cjs'))).toBe(true)
    expect(watcher.hasInput(join(root, 'lib', 'b.cjs'))).toBe(true)
    if (bundle) {
      const module = await import(`${pathToFileURL(target).href}?version=${Date.now()}`)
      const response = await installSprindle(new Hono(), module.default).request('/health')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ value: 'b' })
    } else {
      const runtime = runTsxFixture(root, 'source-cycle.mts', `import {Hono} from 'hono';import {installSprindle} from '@southneuhof/sprindle/hono';const module=await import(${JSON.stringify(pathToFileURL(target).href)});const response=await installSprindle(new Hono(),module.default).request('/health');process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}))`)
      expect(runtime.status, runtime.stdout + runtime.stderr).toBe(0)
      expect(JSON.parse(runtime.stdout)).toEqual({ status: 200, body: { value: 'b' } })
    }
    expect(results.every((result) => result === undefined)).toBe(true)
  } finally { await watcher.close() }
})

test('keeps lexically bound require calls local in source runtime mode', { timeout: 120_000 }, async () => {
  const root = fixture(`import {defineRoute} from '@southneuhof/sprindle';function fromParameter(require:(specifier:string)=>string){return require('./parameter')}function fromFunction(){function require(specifier:string){return specifier}return require('./function')}const fromBlock=(()=>{const {require}={require:(specifier:string)=>specifier};return require('./block')})();const require=(specifier:string)=>specifier;export const GET=defineRoute({action:()=>({parameter:fromParameter(value=>value),function:fromFunction(),block:fromBlock,local:require('./local')})})`)
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  const target = await compileRouteManifest(root, 'routes', '.sprindle/routes-source.mjs', false)
  const runtime = runTsxFixture(root, 'local-require.mts', `import {Hono} from 'hono';import {installSprindle} from '@southneuhof/sprindle/hono';const module=await import(${JSON.stringify(pathToFileURL(target).href)});const response=await installSprindle(new Hono(),module.default).request('/health');process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}))`)
  expect(runtime.status, runtime.stdout + runtime.stderr).toBe(0)
  expect(JSON.parse(runtime.stdout)).toEqual({ status: 200, body: { parameter: './parameter', function: './function', block: './block', local: './local' } })
})

test('initializes source-mode require before authored top-level CommonJS loads', { timeout: 120_000 }, async () => {
  const root = fixture(`import {defineRoute} from '@southneuhof/sprindle';declare const require:(specifier:string)=>{value:string};const payload=require('../../payload.cjs');export const GET=defineRoute({action:()=>payload})`)
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  writeFileSync(join(root, 'payload.cjs'), `module.exports={value:'top-level'}`)
  const target = await compileRouteManifest(root, 'routes', '.sprindle/routes-source.mjs', false)
  const runtime = runTsxFixture(root, 'top-level-require.mts', `import {Hono} from 'hono';import {installSprindle} from '@southneuhof/sprindle/hono';const module=await import(${JSON.stringify(pathToFileURL(target).href)});const response=await installSprindle(new Hono(),module.default).request('/health');process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}))`)
  expect(runtime.status, runtime.stdout + runtime.stderr).toBe(0)
  expect(JSON.parse(runtime.stdout)).toEqual({ status: 200, body: { value: 'top-level' } })
})

test.each([true, false])('rejects a static local cycle in bundle=%s mode', async (bundle) => {
  const root = dependencyFixture({
    'routes/health/+scope.ts': `import {defineScope} from '@southneuhof/sprindle';import {getAuth} from '../../auth';export default defineScope({identity:()=>getAuth()})`,
    'routes/health/+server.ts': `export const GET=()=>null`,
    'auth.ts': `import {defineDomainPart} from '@southneuhof/sprindle/model';import {getDb} from './db';import {accounts,sessions,verifications} from './auth.entity';export const authDomain=defineDomainPart({tables:{accounts,sessions,verifications},entities:[]});export const getAuth=()=>getDb()`,
    'auth.entity.ts': `export const accounts={};export const sessions={};export const verifications={}`,
    'db.ts': `import {domains} from './domains';export const getDb=()=>domains`,
    'domains.ts': `import {authDomain} from './auth';export const domains=[authDomain]`,
  })
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  await expect(compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', bundle)).rejects.toThrow(/auth\.ts -> db\.ts -> domains\.ts -> auth\.ts/)
})

test('rejects self-imports but accepts shared and type-only dependencies', async () => {
  const self = dependencyFixture({ 'routes/health/+server.ts': `import './+server';export const GET=()=>null` })
  await expect(compileRouteManifest(self)).rejects.toThrow(/\+server\.ts -> routes\/health\/\+server\.ts/)
  const valid = dependencyFixture({
    'shared.ts': `export type Value=string;export const value='ok'`,
    'left.ts': `import type {Right} from './right';import {value} from './shared';export type Left={right?:Right};export const left=value`,
    'right.ts': `import type {Left} from './left';import {value} from './shared';export type Right={left?:Left};export const right=value`,
    'routes/health/+server.ts': `import {left} from '../../left';import {right} from '../../right';export const GET=()=>left+right`,
  })
  await expect(compileRouteManifest(valid)).resolves.toBe(join(valid, '.sprindle/routes.mjs'))
  const dynamic = dependencyFixture({
    'shared.ts': `export const value=async()=> (await import('./routes/health/+server')).GET()`,
    'routes/health/+server.ts': `export const GET=async()=> (await import('../../shared')).value()`,
  })
  await expect(compileRouteManifest(dynamic, 'routes', '.sprindle/routes.mjs', true)).resolves.toBe(join(dynamic, '.sprindle/routes.mjs'))
})

test('a cycle failure preserves output and watch mode recovers after removal', { timeout: 120_000 }, async () => {
  const root = dependencyFixture({ 'shared.ts': `export const value='ok'`, 'routes/health/+server.ts': `import {value} from '../../shared';export const GET=()=>value` })
  const target = await compileRouteManifest(root)
  const sourcePointer = join(root, '.sprindle', 'routes.ts')
  const before = [readFileSync(target, 'utf8'), readFileSync(sourcePointer, 'utf8')]
  writeFileSync(join(root, 'shared.ts'), `import {GET} from './routes/health/+server';export const value=GET`)
  await expect(compileRouteManifest(root)).rejects.toThrow(/Static local import cycle/)
  expect([readFileSync(target, 'utf8'), readFileSync(sourcePointer, 'utf8')]).toEqual(before)
  const results: (Error | undefined)[] = []; const watcher = await watchRouteManifest(root, 'routes', (error) => results.push(error))
  try {
    writeFileSync(join(root, 'shared.ts'), `export const value='fixed'`)
    await vi.waitFor(() => { expect(results.some(Boolean)).toBe(true); expect(results.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('watch follows an atomic replacement of an external input', { timeout: 120_000 }, async () => {
  const root = fixture()
  writeFileSync(join(root, 'helper.ts'), `export const value = 'one'`)
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `import { value } from '../../helper'; export const GET = () => value`)
  const callbacks: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error))
  try {
    const started = callbacks.length
    writeFileSync(join(root, 'helper.ts.next'), `export const value = 'two'`)
    renameSync(join(root, 'helper.ts.next'), join(root, 'helper.ts'))
    await vi.waitFor(() => { expect(callbacks.length).toBeGreaterThan(started); expect(callbacks.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('watch recovers when an external cycle is fixed by an external edit', { timeout: 120_000 }, async () => {
  const base = mkdtempSync(join(process.cwd(), 'node_modules', '.sprindle-external-watch-')); roots.push(base)
  const root = join(base, 'project')
  mkdirSync(join(root, 'routes', 'health'), { recursive: true })
  mkdirSync(join(base, 'shared'))
  symlinkSync(join(base, 'shared'), join(root, 'shared'), 'dir')
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `import {a} from '../../shared/a';export const GET=()=>a()`)
  writeFileSync(join(base, 'shared', 'a.ts'), `import {b} from './b';export const a=()=>b`)
  writeFileSync(join(base, 'shared', 'b.ts'), `import {a} from './a';export const b=()=>a`)
  const results: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => results.push(error))
  try {
    expect(results.at(-1)).toBeInstanceOf(Error)
    const count = results.length
    writeFileSync(join(base, 'shared', 'b.ts'), `export const b='fixed'`)
    await vi.waitFor(() => { expect(results.length).toBeGreaterThan(count); expect(results.at(-1)).toBeUndefined() }, { timeout: 30_000 })
  } finally { await watcher.close() }
})

test('bundled scope and resource helpers execute after route source is removed', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(process.cwd(), 'node_modules', '.sprindle-resource-manifest-')); roots.push(root)
  const routesImport = '@southneuhof/sprindle'
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  mkdirSync(join(root, 'routes', 'items', 'list'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  writeFileSync(join(root, 'routes', 'items', '+scope.ts'), `import {defineScope} from ${JSON.stringify(routesImport)}; export default defineScope({entity:{name:'items',schemas:{create:{parse:(v:unknown)=>v},update:{parse:(v:unknown)=>v},select:{parse:(v:unknown)=>v}},source:{list:async()=>({data:[{id:'one'}],total:1}),detail:async()=>null,create:async({input}:{input:unknown})=>input,update:async()=>null,delete:async()=>false,materialize:async (input:unknown)=>input}} as never})`)
  writeFileSync(join(root, 'routes', 'items', 'list', '+server.ts'), `import {list} from ${JSON.stringify(routesImport)}; export const GET=list({})`)
  const artifact = await compileRouteManifest(root)
  rmSync(join(root, 'routes'), { recursive: true })
  const honoImport = pathToFileURL(join(import.meta.dirname, '..', 'hono', 'index.ts')).href
  const honoPackage = pathToFileURL(join(import.meta.dirname, '..', '..', 'node_modules', 'hono', 'dist', 'index.js')).href
  const script = `import {Hono} from ${JSON.stringify(honoPackage)};import {installSprindle} from ${JSON.stringify(honoImport)};(async()=>{const manifest=(await import(${JSON.stringify(pathToFileURL(artifact).href)})).default;const response=await installSprindle(new Hono(),manifest).request('/items/list');process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}))})()`
  const run = spawnSync(join(import.meta.dirname, '..', '..', '..', '..', 'apps', 'api', 'node_modules', '.bin', 'tsx'), ['--eval', script], { encoding: 'utf8' })
  expect(run.stderr).toBe('')
  expect(JSON.parse(run.stdout)).toEqual({ status: 200, body: { data: [{ id: 'one' }], page: 1, limit: 10, total: 1 } })
})

test('builds both runtime modes with one bundler pass', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprindle-dual-manifest-')); roots.push(root)
  mkdirSync(join(root, 'routes', 'health'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `export const GET = () => 'healthy'`)
  writeFileSync(join(root, 'config.base.json'), '{"compilerOptions":{"strict":true}}')
  writeFileSync(join(root, 'tsconfig.json'), '{"extends":"./config.base.json"}')
  const bundleTarget = join(root, '.sprindle', 'routes.mjs')
  const sourceTarget = join(root, '.sprindle', 'routes-source.mjs')
  let serial = 0
  const readBoth = async () => {
    serial += 1
    const bundleModule = await import(`${pathToFileURL(bundleTarget).href}?plan011-${serial}-bundle`)
    serial += 1
    const sourceModule = await import(`${pathToFileURL(sourceTarget).href}?plan011-${serial}-source`)
    return { bundleModule, sourceModule }
  }
  const compileBoth = async () => {
    vi.mocked(build).mockClear()
    await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)
    expect(vi.mocked(build)).toHaveBeenCalledTimes(1)
    vi.mocked(build).mockClear()
    await compileRouteManifest(root, 'routes', '.sprindle/routes-source.mjs', false)
    expect(vi.mocked(build)).toHaveBeenCalledTimes(1)
    return readBoth()
  }
  let { bundleModule, sourceModule } = await compileBoth()
  expect(bundleModule.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(sourceModule.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(sourceModule.hash).toBe(bundleModule.hash)
  expect(sourceModule.default[0].httpPath).toBe(bundleModule.default[0].httpPath)
  expect(await sourceModule.default[0].handlers.GET()).toBe(await bundleModule.default[0].handlers.GET())
  const firstHash = bundleModule.hash
  ;({ bundleModule, sourceModule } = await compileBoth())
  expect(bundleModule.hash).toBe(firstHash)
  expect(sourceModule.hash).toBe(firstHash)
  writeFileSync(join(root, 'helper.ts'), `export const value='one'`)
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `import { value } from '../../helper'; export const GET = () => value`)
  ;({ bundleModule, sourceModule } = await compileBoth())
  expect(bundleModule.hash).not.toBe(firstHash)
  expect(sourceModule.hash).toBe(bundleModule.hash)
  expect(await bundleModule.default[0].handlers.GET()).toBe('one')
  const helperHash = bundleModule.hash
  writeFileSync(join(root, 'config.base.json'), '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}')
  ;({ bundleModule, sourceModule } = await compileBoth())
  expect(bundleModule.hash).not.toBe(helperHash)
  expect(sourceModule.hash).toBe(bundleModule.hash)
})

test('plan011 preserves hash collisions and inline map contents', { timeout: 120_000 }, async () => {
  const root = fixture()
  const placeholder = '0'.repeat(64)
  const helperSource = `export const hash = '${placeholder}';\nexport const pendingText = 'pending';\nexport const resembling = 'export const hash = "kept"';\n`
  const routeSource = `import { hash as helperHash, pendingText, resembling } from '../../helper';\nexport const GET = () => ({ helperHash, pendingText, resembling });\n`
  writeFileSync(join(root, 'helper.ts'), helperSource)
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), routeSource)
  const target = await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)
  const manifest = await import(`${pathToFileURL(target).href}?plan011-collision`)
  expect(manifest.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(await manifest.default[0].handlers.GET()).toEqual({ helperHash: placeholder, pendingText: 'pending', resembling: 'export const hash = "kept"' })
  const text = readFileSync(target, 'utf8')
  const match = text.match(/\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\r?\n?$/)
  expect(match?.[1]).toBeDefined()
  const map = JSON.parse(Buffer.from(match![1], 'base64').toString('utf8')) as { version: unknown; mappings: unknown; sources: unknown; sourcesContent: unknown }
  expect(map.version).toBe(3)
  expect(typeof map.mappings).toBe('string')
  expect(Array.isArray(map.sources)).toBe(true)
  expect(Array.isArray(map.sourcesContent)).toBe(true)
  const sources = map.sources as string[]
  const contents = map.sourcesContent as string[]
  expect(sources.length).toBe(contents.length)
  const helperIndex = sources.findIndex((source) => source.endsWith('helper.ts'))
  const routeIndex = sources.findIndex((source) => source.endsWith('+server.ts'))
  const generatedIndex = sources.findIndex((source) => source.endsWith('/routes.ts'))
  expect(helperIndex).toBeGreaterThanOrEqual(0)
  expect(routeIndex).toBeGreaterThanOrEqual(0)
  expect(generatedIndex).toBeGreaterThanOrEqual(0)
  expect(contents[helperIndex]).toBe(helperSource)
  expect(contents[routeIndex]).toBe(routeSource)
  expect(contents[generatedIndex]).toContain(`export const hash=${JSON.stringify(manifest.hash)}`)
  expect(contents[generatedIndex]).not.toContain(`export const hash=${JSON.stringify(placeholder)}`)
})

test('plan011 preserves original stack locations', { timeout: 120_000 }, async () => {
  const source = ['export const GET = () => {', '  throw new Error("plan011-map")', '}'].join('\n')
  const root = fixture(source)
  const target = await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)
  const script = `const manifest = (await import(${JSON.stringify(pathToFileURL(target).href)})).default; manifest[0].handlers.GET();`
  const run = spawnSync(process.execPath, ['--enable-source-maps', '--input-type=module', '--eval', script], { encoding: 'utf8' })
  expect(run.status).not.toBe(0)
  expect(run.stderr).toContain('plan011-map')
  expect(run.stderr).toContain('+server.ts:2:')
})

test.each([true, false])('maps the original column after a longer generated import rewrite in bundle=%s mode', { timeout: 120_000 }, async (bundle) => {
  const createdRoot = mkdtempSync(join(tmpdir(), 'sprindle-map-contract-'))
  roots.push(createdRoot)
  const realRoot = realpathSync(createdRoot)
  const rootAlias = realRoot.startsWith('/private/') ? realRoot.slice('/private'.length) : createdRoot
  const root = existsSync(rootAlias) && realpathSync(rootAlias) === realRoot ? rootAlias : createdRoot
  mkdirSync(join(root, 'routes', 'health'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  mkdirSync(join(root, 'shared'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@shared/*': ['./shared/*'] } } }))
  writeFileSync(join(root, 'shared', 'payload.ts'), `export type Payload={value:string}`)
  const source = `import {defineRoute} from '@southneuhof/sprindle';import type {Payload} from '@shared/payload';export const GET=defineRoute({action:():Payload=>{throw new Error('source-map-column')}})`
  const route = join(root, 'routes', 'health', '+server.ts')
  writeFileSync(route, source)
  const runtime = await compileRouteManifest(root, 'routes', bundle ? '.sprindle/routes.mjs' : '.sprindle-dev/routes.mjs', bundle)
  const runner = join(root, 'run-map.mts')
  writeFileSync(runner, `const manifest=await import(${JSON.stringify(pathToFileURL(runtime).href)});manifest.default[0].handlers.GET.config.action({})`)
  const tsx = join(import.meta.dirname, '../../../../apps/api/node_modules/.bin/tsx')
  const run = spawnSync(tsx, [runner], { cwd: root, encoding: 'utf8' })
  const column = source.indexOf('new Error') + 1
  const mapped = run.stderr.match(/(\/[^\n:]+\/routes\/health\/\+server\.ts):1:(\d+)/)
  expect(run.status).not.toBe(0)
  expect(run.stderr).toContain('source-map-column')
  expect(mapped?.[1]).toBe(realpathSync(route))
  expect(existsSync(mapped?.[1] ?? '')).toBe(true)
  expect(mapped?.[2]).toBe(String(column))
})

test('preserves the published graph when a dependency changes during compilation', { timeout: 120_000 }, async () => {
  const root = fixture()
  const route = join(root, 'routes', 'health', '+server.ts')
  const dependency = join(root, 'helper.ts')
  writeFileSync(dependency, `export const value='before'`)
  writeFileSync(route, `import {value} from '../../helper';export const GET=()=>value`)
  const target = await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)
  const sourcePointer = readFileSync(join(root, '.sprindle', 'routes.ts'), 'utf8')
  const runtime = readFileSync(target, 'utf8')
  const actual = await vi.importActual<typeof import('esbuild')>('esbuild')
  vi.mocked(build).mockClear()
  vi.mocked(build).mockImplementationOnce(async (options: Parameters<typeof actual.build>[0]) => {
    const result = await actual.build(options)
    writeFileSync(dependency, `export const value='after'`)
    return result
  })
  try {
    await expect(compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)).rejects.toThrow(/dependency changed during generation: helper\.ts/)
  } finally { vi.mocked(build).mockClear() }
  expect(readFileSync(target, 'utf8')).toBe(runtime)
  expect(readFileSync(join(root, '.sprindle', 'routes.ts'), 'utf8')).toBe(sourcePointer)
})

test('plan011 preserves published output when finalization fails', { timeout: 120_000 }, async () => {
  const root = fixture()
  const target = await compileRouteManifest(root)
  const sourcePointer = join(root, '.sprindle', 'routes.ts')
  const savedRuntime = readFileSync(target, 'utf8')
  const savedSource = readFileSync(sourcePointer, 'utf8')
  const actual = await vi.importActual<typeof import('esbuild')>('esbuild')
  vi.mocked(build).mockClear()
  vi.mocked(build).mockImplementationOnce(async (options: Parameters<typeof actual.build>[0]) => {
    const result = await actual.build(options)
    const output = result.outputFiles?.[0]
    if (!output) return result
    const stripped = output.text.replace(/\n\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+\r?\n?$/, '')
    expect(stripped).not.toBe(output.text)
    const bytes = new TextEncoder().encode(stripped)
    return {
      ...result,
      outputFiles: [{ path: output.path, contents: bytes, hash: output.hash, get text() { return Buffer.from(bytes).toString('utf8') } }],
    } as typeof result
  })
  try {
    await expect(compileRouteManifest(root)).rejects.toThrow(/Sprindle bundle finalization:/)
  } finally {
    vi.mocked(build).mockClear()
  }
  expect(readFileSync(target, 'utf8')).toBe(savedRuntime)
  expect(readFileSync(sourcePointer, 'utf8')).toBe(savedSource)
  const leftovers = readdirSync(dirname(target)).filter((name) => name.startsWith('routes.mjs.') && name.endsWith('.tmp'))
  expect(leftovers).toEqual([])
})
