import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { compileRouteManifest, watchRouteManifest } from './manifest'

const roots: string[] = []
function fixture(source = `export const GET = () => 'healthy'`) { const root = mkdtempSync(join(tmpdir(), 'sprindle-manifest-')); roots.push(root); mkdirSync(join(root, 'routes', 'health'), { recursive: true }); writeFileSync(join(root, 'tsconfig.json'), '{}'); writeFileSync(join(root, 'routes', 'health', '+server.ts'), source); return root }
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

test('skips declarations when disabled', async () => {
  const root = fixture()
  const target = await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true, { declarations: false })
  const manifest = await import(`${pathToFileURL(target).href}?skipped`)
  expect(manifest.default).toHaveLength(1)
  expect(existsSync(target.replace(/\.mjs$/, '.d.ts'))).toBe(false)
  await compileRouteManifest(root)
  expect(existsSync(target.replace(/\.mjs$/, '.d.ts'))).toBe(true)
})

test('watch recovers after an invalid source tree is fixed', { timeout: 120_000 }, async () => {
  const root = fixture(); const errors: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => errors.push(error))
  const invalid = join(root, 'routes', 'bad route', '+server.ts'); mkdirSync(dirname(invalid), { recursive: true }); writeFileSync(invalid, 'export const GET = 1')
  for (let attempt = 0; attempt < 40 && !errors.some(Boolean); attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  rmSync(dirname(invalid), { recursive: true }); writeFileSync(join(root, 'routes', 'health', '+server.ts'), 'export const GET = 1')
  const errorCount = errors.length
  for (let attempt = 0; attempt < 40 && (errors.length === errorCount || errors.at(-1)); attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  await watcher.close()
  expect(errors.some(Boolean)).toBe(true); expect(errors.at(-1)).toBeUndefined()
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

function dependencyFixture(files: Record<string, string>) {
  const root = fixture()
  for (const [file, source] of Object.entries(files)) {
    const target = join(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source)
  }
  return root
}

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
})

test('a cycle failure preserves output and watch mode recovers after removal', { timeout: 120_000 }, async () => {
  const root = dependencyFixture({ 'shared.ts': `export const value='ok'`, 'routes/health/+server.ts': `import {value} from '../../shared';export const GET=()=>value` })
  const target = await compileRouteManifest(root); const declaration = target.replace(/\.mjs$/, '.d.ts')
  const before = [readFileSync(target, 'utf8'), readFileSync(declaration, 'utf8')]
  writeFileSync(join(root, 'shared.ts'), `import {GET} from './routes/health/+server';export const value=GET`)
  await expect(compileRouteManifest(root)).rejects.toThrow(/Static local import cycle/)
  expect([readFileSync(target, 'utf8'), readFileSync(declaration, 'utf8')]).toEqual(before)
  const results: (Error | undefined)[] = []; const watcher = await watchRouteManifest(root, 'routes', (error) => results.push(error))
  try {
    writeFileSync(join(root, 'shared.ts'), `export const value='fixed'`)
    for (let attempt = 0; attempt < 80 && results.at(-1); attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(results.some(Boolean)).toBe(true); expect(results.at(-1)).toBeUndefined()
  } finally { await watcher.close() }
})

test('watch recovers when an external cycle is fixed by an external edit', { timeout: 120_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'sprindle-external-watch-')); roots.push(base)
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
    for (let attempt = 0; attempt < 80 && (results.length === count || results.at(-1)); attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(results.length).toBeGreaterThan(count)
    expect(results.at(-1)).toBeUndefined()
  } finally { await watcher.close() }
})

test('bundled scope and resource helpers execute after route source is removed', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprindle-resource-manifest-')); roots.push(root)
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
  expect(JSON.parse(run.stdout)).toEqual({ status: 200, body: { data: [{ id: 'one' }], page: 1, limit: 20, total: 1 } })
})

test('emits a self-contained contextual consumer contract through moves and deletion', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(process.cwd(), 'node_modules', '.sprindle-consumer-')); roots.push(root)
  const routesImport = '@southneuhof/sprindle'
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  mkdirSync(join(root, 'routes', 'items', 'nested', 'list'), { recursive: true })
  mkdirSync(join(root, 'routes', 'items', 'create'), { recursive: true })
  mkdirSync(join(root, 'routes', 'items', 'nested', 'summary'), { recursive: true })
  mkdirSync(join(root, 'routes', 'items', 'nested', 'generic'), { recursive: true })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib', 'result.ts'), `export interface AliasResult { alias: 'resolved' }`)
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { '@lib/*': ['./lib/*'] } }, include: ['routes/**/*.ts', 'lib/**/*.ts', 'consumer.ts'] }))
  writeFileSync(join(root, 'routes', 'items', '+scope.ts'), `import {defineScope} from ${JSON.stringify(routesImport)};import {z} from 'zod/v4';const create=z.object({age:z.string().transform(Number)});const select=z.object({id:z.string(),age:z.number()});export default defineScope({context:()=>({tenant:{id:'tenant'}}),entity:{name:'items',schemas:{create,update:create.partial(),select},source:{} as never}})`)
  writeFileSync(join(root, 'routes', 'items', 'nested', '+scope.ts'), `import {defineScope} from ${JSON.stringify(routesImport)};export default defineScope({context:()=>({actor:{id:42}})})`)
  writeFileSync(join(root, 'routes', 'items', 'nested', 'list', '+server.ts'), `import {list} from ${JSON.stringify(routesImport)};export const GET=list({})`)
  writeFileSync(join(root, 'routes', 'items', 'create', '+server.ts'), `import {create} from ${JSON.stringify(routesImport)};export const POST=create({run:({state})=>({id:'one',age:state.input.age})})`)
  writeFileSync(join(root, 'routes', 'items', 'nested', 'summary', 'handler.ts'), `import {defineRoute} from ${JSON.stringify(routesImport)};interface Payload<T>{value:T};type Result<T>={payload:Payload<T>};const result=<T>(value:T):Result<T>=>({payload:{value}});export const handler=defineRoute({action:({context})=>result(context.actor.id)})`)
  writeFileSync(join(root, 'routes', 'items', 'nested', 'summary', 'GET-helper.ts'), `export const note='GET helper'`)
  writeFileSync(join(root, 'routes', 'items', 'nested', 'summary', '+server.ts'), `// GET returns the summary; the string "GET" is not an export binding.\nimport './GET-helper'\nexport {handler as GET} from './handler'`)
  writeFileSync(join(root, 'routes', 'items', 'nested', 'generic', '+server.ts'), `import {defineRoute} from ${JSON.stringify(routesImport)};import type {AliasResult} from '@lib/result';interface Payload<T>{item:T};type Result<T>={result:Payload<T>;aliasResult:AliasResult};const result=<T>(item:T):Result<T>=>({result:{item},aliasResult:{alias:'resolved'}});export const GET=defineRoute({action:({context})=>result(context.tenant.id)})`)
  const moved = join(root, 'routes', 'items', 'temporary'); mkdirSync(moved); writeFileSync(join(moved, '+server.ts'), `import {defineRoute} from ${JSON.stringify(routesImport)};export const GET=defineRoute({action:()=>({temporary:true})})`)
  await compileRouteManifest(root)
  renameSync(moved, join(root, 'routes', 'items', 'moved'))
  await compileRouteManifest(root)
  let declaration = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  expect(declaration).toContain('path: "/items/moved"')
  expect(declaration).not.toContain('path: "/items/temporary"')
  rmSync(join(root, 'routes', 'items', 'moved'), { recursive: true })
  await compileRouteManifest(root)
  declaration = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  expect(declaration).not.toContain('temporary')
  rmSync(join(root, 'routes'), { recursive: true })
  rmSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'consumer.ts'), `import type {RouteContract} from './.sprindle/routes';type Entry<P,M>=Extract<RouteContract,{path:P;method:M}>['definition'];type Output<T>=NonNullable<T extends {readonly output?:infer O}?O:never>;type Input<T>=NonNullable<T extends {readonly input?:infer I}?I:never>;type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;type Expect<T extends true>=T;type _list=Expect<Equal<Output<Entry<'/items/nested/list','get'>>,{data:{id:string;age:number}[];page:number;limit:number;total:number}>>;type _create=Expect<Equal<Input<Entry<'/items/create','post'>>,{age:string}>>;type _custom=Expect<Equal<Output<Entry<'/items/nested/summary','get'>>,{payload:{value:number}}>>;type _generic=Expect<Equal<Output<Entry<'/items/nested/generic','get'>>,{result:{item:string};aliasResult:{alias:'resolved'}}>>;type Paths=RouteContract['path'];// @ts-expect-error transformed input accepts a string, not a number\nconst wrongInput:Input<Entry<'/items/create','post'>>={age:42};// @ts-expect-error moved route was deleted\nconst deleted:Paths='/items/moved';`)
  const checked = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'tsc'), ['-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
  expect(checked.status, checked.stdout + checked.stderr + '\n' + declaration).toBe(0)
})

test.each([true, false])('emits a portable contract for sibling source type-only edits in bundle=%s mode', { timeout: 120_000 }, async (bundle) => {
  const workspace = mkdtempSync(join(process.cwd(), 'node_modules', '.sprindle-sibling-source-')); roots.push(workspace)
  const root = join(workspace, 'api')
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  mkdirSync(join(root, 'routes', 'health'), { recursive: true })
  mkdirSync(join(workspace, 'shared'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { '@shared/*': ['../shared/*'] } }, include: ['routes/**/*.ts', 'consumer.ts'] }))
  const resultSource = `import type {Detail} from './detail';import type {Brand} from './brand.d.ts';export interface Result { detail: Detail;brand:Brand };export const result:Result={detail:{code:1},brand:{brand:'local'}}`
  const writeSources = (brand: string) => {
    mkdirSync(join(root, 'routes', 'health'), { recursive: true }); mkdirSync(join(workspace, 'shared'), { recursive: true })
    writeFileSync(join(workspace, 'shared', 'brand.d.ts'), `export interface Brand { brand: ${brand} }`)
    writeFileSync(join(workspace, 'shared', 'detail.ts'), `export interface Detail { code: number }`)
    writeFileSync(join(workspace, 'shared', 'result.ts'), resultSource)
    writeFileSync(join(root, 'routes', '+scope.ts'), `import {defineScope} from '@southneuhof/sprindle';export default defineScope({context:()=>({tenant:{id:'tenant'}})})`)
    writeFileSync(join(root, 'routes', 'health', '+server.ts'), `import {defineRoute} from '@southneuhof/sprindle';import {result} from '../../../shared/result';import type {Detail} from '@shared/detail';export const GET=defineRoute({action:({context})=>({tenantId:context.tenant.id,result,alias:result.detail as Detail})})`)
  }
  const runtimeFiles = [join(workspace, 'shared', 'result.ts'), join(root, 'routes', '+scope.ts'), join(root, 'routes', 'health', '+server.ts')]
  const checkConsumer = (brand: string, wrongBrand: string) => {
    writeFileSync(join(root, 'consumer.ts'), `import type {RouteContract} from './.sprindle/routes';type D=Extract<RouteContract,{path:'/health';method:'get'}>['definition'];type O=NonNullable<D extends {readonly output?:infer V}?V:never>;const ok:O={tenantId:'tenant',result:{detail:{code:1},brand:{brand:${brand}}},alias:{code:1}};// @ts-expect-error sibling named type is preserved\nconst wrong:O={tenantId:'tenant',result:{detail:{code:1},brand:{brand:${wrongBrand}}},alias:{code:1}};`)
    const checked = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'tsc'), ['-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
    expect(checked.status, checked.stdout + checked.stderr + readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')).toBe(0)
  }
  writeSources('string')
  await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', bundle)
  const firstDeclaration = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  const runtimeBeforeTypeEdit = runtimeFiles.map((file) => readFileSync(file, 'utf8'))
  rmSync(join(root, 'routes'), { recursive: true })
  rmSync(join(workspace, 'shared'), { recursive: true })
  checkConsumer(`'old'`, 'false')
  rmSync(join(root, 'consumer.ts'))
  writeSources('string')
  writeFileSync(join(workspace, 'shared', 'brand.d.ts'), `export interface Brand { brand: 'local' }`)
  expect(runtimeFiles.map((file) => readFileSync(file, 'utf8'))).toEqual(runtimeBeforeTypeEdit)
  await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', bundle)
  const secondDeclaration = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  expect(secondDeclaration).not.toBe(firstDeclaration)
  const runtimeFile = join(root, '.sprindle', 'routes.mjs')
  const beforeFailure = [readFileSync(runtimeFile, 'utf8'), secondDeclaration]
  writeFileSync(join(workspace, 'shared', 'result.ts'), `import type {Detail} from './detail';import type {Brand} from './brand.d.ts';export interface Result { detail: Detail;brand:Brand };export const result:Result={detail:{code:false},brand:{brand:'local'}}`)
  await expect(compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', bundle)).rejects.toThrow(/TypeScript declaration emit failed/)
  expect([readFileSync(runtimeFile, 'utf8'), readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')]).toEqual(beforeFailure)
  writeFileSync(join(workspace, 'shared', 'result.ts'), resultSource)
  await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', bundle)
  rmSync(join(root, 'routes'), { recursive: true }); rmSync(join(workspace, 'shared'), { recursive: true })
  checkConsumer(`'local'`, `'old'`)
})

test('versions type-only changes and preserves output string literals that resemble aliases', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(process.cwd(), 'node_modules', '.sprindle-type-version-')); roots.push(root)
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(join(import.meta.dirname, '..', '..'), join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  mkdirSync(join(root, 'routes', 'health'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { '@lib/*': ['./lib/*'] } }, include: ['routes/**/*.ts', 'lib/**/*.ts', 'consumer.ts'] }))
  writeFileSync(join(root, 'lib', 'types.ts'), `export type Payload={id:string}`)
  writeFileSync(join(root, 'routes', 'health', '+server.ts'), `import {defineRoute} from '@southneuhof/sprindle';import type {Payload} from '@lib/types';export const GET=defineRoute({action:():Payload&{tag:'@lib/health'}=>({key:'u',tag:'@lib/health'} as unknown as Payload&{tag:'@lib/health'})})`)
  await compileRouteManifest(root)
  const first = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  writeFileSync(join(root, 'lib', 'types.ts'), `export type Payload={key:string;extra?:number}`)
  await compileRouteManifest(root)
  const second = readFileSync(join(root, '.sprindle', 'routes.d.ts'), 'utf8')
  expect(second).not.toBe(first)
  rmSync(join(root, 'routes'), { recursive: true }); rmSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'consumer.ts'), `import type {RouteContract} from './.sprindle/routes';type D=Extract<RouteContract,{path:'/health';method:'get'}>['definition'];type O=NonNullable<D extends {readonly output?:infer V}?V:never>;const ok:O={key:'u',extra:1,tag:'@lib/health'};// @ts-expect-error old field is absent\nconst old:O={id:'u',tag:'@lib/health'};// @ts-expect-error the output literal is unchanged\nconst wrong:O={key:'u',tag:'../../lib/health'};`)
  const checked = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'tsc'), ['-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
  expect(checked.status, checked.stdout + checked.stderr + second).toBe(0)
})
