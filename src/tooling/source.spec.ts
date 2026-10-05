import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { compileRouteManifest, watchRouteManifest } from './manifest'

const roots: string[] = []
const repository = resolve(import.meta.dirname, '../../../../')
const framework = resolve(import.meta.dirname, '../..')
const compiler = resolve(repository, 'apps/web/node_modules/typescript/bin/tsc')
const tsx = resolve(repository, 'apps/api/node_modules/.bin/tsx')

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'sprindle-source-contract-'))
  roots.push(workspace)
  const root = join(workspace, 'api')
  mkdirSync(join(root, 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(framework, join(root, 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  symlinkSync(resolve(framework, 'node_modules', '@types'), join(root, 'node_modules', '@types'), 'dir')
  for (const name of ['hono', 'zod']) symlinkSync(resolve(framework, 'node_modules', name), join(root, 'node_modules', name), 'dir')
  mkdirSync(join(root, 'routes', 'tenants', '[tenantId]', 'items', '[itemId]', 'create'), { recursive: true })
  mkdirSync(join(root, 'routes', 'status'), { recursive: true })
  mkdirSync(join(root, 'routes', 'shared'), { recursive: true })
  mkdirSync(join(root, 'globals'))
  mkdirSync(join(root, 'lib'))
  mkdirSync(join(root, 'shared'))
  mkdirSync(join(workspace, 'shared'))
  mkdirSync(join(workspace, 'consumer'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: ['node'], target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', moduleSuffixes: ['.producer', ''], paths: { '@shared/*': ['../shared/*'] } }, include: ['globals/**/*.ts', 'lib/**/*.ts', 'consumer.ts', 'invalid.ts'] }))
  mkdirSync(join(workspace, 'consumer', 'node_modules', '@southneuhof'), { recursive: true })
  symlinkSync(framework, join(workspace, 'consumer', 'node_modules', '@southneuhof', 'sprindle'), 'dir')
  symlinkSync(resolve(framework, 'node_modules', '@types'), join(workspace, 'consumer', 'node_modules', '@types'), 'dir')
  for (const name of ['hono', 'zod']) symlinkSync(resolve(framework, 'node_modules', name), join(workspace, 'consumer', 'node_modules', name), 'dir')
  writeFileSync(join(workspace, 'consumer', 'tsconfig.json'), JSON.stringify({ extends: '../api/tsconfig.json', include: [], files: ['consumer.ts'] }))
  writeFileSync(join(root, 'routes', '+scope.ts'), `import {defineScope} from '@southneuhof/sprindle';export default defineScope({context:()=>({tenant:{id:'root'}}),identity:()=>({kind:'member' as const})})`)
  writeFileSync(join(root, 'routes', 'tenants', '[tenantId]', 'items', '[itemId]', '+scope.ts'), `import {defineScope} from '@southneuhof/sprindle';import {z} from 'zod';const create=z.object({name:z.string(),age:z.string().transform(Number)});const update=create.partial();const select=z.object({id:z.string(),name:z.string(),age:z.number()});const publicSelect=z.object({id:z.string(),label:z.string()});const source={list:async()=>[],detail:async()=>null,create:async()=>null,update:async()=>null,delete:async()=>true,materialize:async()=>({})};export default defineScope({context:({params})=>({tenant:{slug:'child'},item:{id:params.itemId}}),entity:{name:'items',schemas:{create,update,select},source},enrich:{schema:publicSelect,run:record=>({id:record.id,label:record.name})}})`)
  writeFileSync(join(root, 'routes', 'tenants', '[tenantId]', 'items', '[itemId]', 'create', 'handler.ts'), `import {create} from '@southneuhof/sprindle';export const POST=create({run:async args=>{const tenant:string=args.context.tenant.slug;const itemId:string=args.params.itemId;const age:number=args.state.input.age;const identity:'member'=(await args.identity()).kind;return{id:itemId,name:tenant+'-'+identity+'-'+age,age}}})`)
  writeFileSync(join(root, 'routes', 'tenants', '[tenantId]', 'items', '[itemId]', 'create', '+server.ts'), `export {POST} from './handler'`)
  writeFileSync(join(root, 'routes', 'status', 'handler.ts'), `/// <reference path="../../globals/ambient.d.ts" />\nimport {defineRoute} from '@southneuhof/sprindle';import {makeOutput} from '../../lib/outer';import type {Result} from '../../lib/result';import type {Payload} from '@shared/payload';import type {Mode} from '../../lib/choice';type Status={tenant:string;ambient:AmbientDeclaration['ambient'];script:ScriptGlobal['script'];module:ModuleGlobal['module'];augmented:Result['augmented'];revision:Payload['revision'];mode:Mode;ordinary:ReturnType<typeof makeOutput>};export const GET=defineRoute({action:({context}):Status=>({tenant:context.tenant.id,ambient:({ambient:'declaration'} as AmbientDeclaration).ambient,script:({script:'global'} as ScriptGlobal).script,module:({module:'global'} as ModuleGlobal).module,augmented:({value:'base',augmented:'yes'} as Result).augmented,revision:'one' as Payload['revision'],mode:'producer' as Mode,ordinary:makeOutput()})})`)
  writeFileSync(join(root, 'routes', 'status', '+server.ts'), `export {GET} from './handler'`)
  writeFileSync(join(root, 'routes', 'shared', '+server.ts'), `import {defineRoute} from '@southneuhof/sprindle';import {state} from '../../shared/state';export const GET=defineRoute({action:()=>state})`)
  writeFileSync(join(root, 'globals', 'ambient.d.ts'), `interface AmbientDeclaration { ambient:'declaration' }`)
  writeFileSync(join(root, 'globals', 'script-global.ts'), `interface ScriptGlobal { script:'global' }throw new Error('script global executed')`)
  writeFileSync(join(root, 'globals', 'module-global.ts'), `export {};declare global { interface ModuleGlobal { module:'global' } }throw new Error('module global executed')`)
  writeFileSync(join(root, 'globals', 'module-augmentation.ts'), `export {};declare module '../lib/result' { interface Result { augmented:'yes' } }throw new Error('module augmentation executed')`)
  writeFileSync(join(root, 'lib', 'result.ts'), `export interface Result { value:'base' }`)
  writeFileSync(join(root, 'lib', 'outer.ts'), `import {Identity,leafValue} from './leaf';import type {Leaf} from './leaf';export type OrdinaryOutput={identity:Identity;nested:Leaf};export const makeOutput=():OrdinaryOutput=>({identity:new Identity(),nested:{value:leafValue}})`)
  writeFileSync(join(root, 'lib', 'leaf.ts'), `export type Leaf={value:'leaf'};export class Identity{private key=1};export const leafValue='leaf' as const`)
  writeFileSync(join(workspace, 'shared', 'payload.ts'), `export interface Payload { revision:'one' }`)
  writeFileSync(join(root, 'lib', 'choice.producer.ts'), `export type Mode='producer'`)
  writeFileSync(join(root, 'lib', 'choice.consumer.ts'), `export type Mode='consumer'`)
  writeFileSync(join(root, 'shared', 'state.ts'), `export const state={value:'shared' as const}`)
  return { root, payload: join(workspace, 'shared', 'payload.ts') }
}

function typeCheck(root: string, config = 'tsconfig.json') {
  return spawnSync(process.execPath, [compiler, '-p', join(root, config), '--pretty', 'false'], { cwd: root, encoding: 'utf8' })
}

function runTsx(root: string, file: string) {
  return spawnSync(tsx, [file], { cwd: root, encoding: 'utf8' })
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

test('generated route source keeps inferred types live and runs bound modules', { timeout: 120_000 }, async () => {
  const { root, payload } = fixture()
  await compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', true)
  const pointer = readFileSync(join(root, '.sprindle', 'routes.ts'), 'utf8')
  const version = pointer.match(/\.\/source\/([a-f0-9]{64})\//)?.[1]
  expect(version).toBeDefined()
  expect(existsSync(join(root, '.sprindle', 'source', version!, 'routes.ts'))).toBe(true)
  writeFileSync(join(root, 'consumer.ts'), `import type {RouteContract} from './.sprindle/routes';import type {Identity} from './lib/leaf';type Definition<P extends string,M extends string>=Extract<RouteContract,{path:P;method:M}>['definition'];type Input<T>=NonNullable<T extends {readonly input?:infer V}?V:never>;type Output<T>=NonNullable<T extends {readonly output?:infer V}?V:never>;type Create=Definition<'/tenants/:tenantId/items/:itemId/create','post'>;type Status=Output<Definition<'/status','get'>>;type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;type Expect<T extends true>=T;type _paths=Expect<Equal<RouteContract['path'],'/tenants/:tenantId/items/:itemId/create'|'/status'|'/shared'>>;type _methods=Expect<Equal<RouteContract['method'],'get'|'post'>>;type _input=Expect<Equal<Input<Create>,{name:string;age:string}>>;type _output=Expect<Equal<Output<Create>,{data:{id:string;label:string}}>>;type _mode=Expect<Equal<Status['mode'],'producer'>>;type _identity=Expect<Equal<Status['ordinary']['identity'],Identity>>;declare const identity:Identity;const input:Input<Create>={name:'Book',age:'7'};const created:Output<Create>={data:{id:'item',label:'child-member-7'}};const status:Status={tenant:'root',ambient:'declaration',script:'global',module:'global',augmented:'yes',revision:'one',mode:'producer',ordinary:{identity,nested:{value:'leaf'}}};const path:RouteContract['path']='/status';const revision:'one'=status.revision`)
  const external = resolve(root, '..', 'consumer')
  writeFileSync(join(external, 'consumer.ts'), `import {Hono} from 'hono';import {installSprindle} from '@southneuhof/sprindle/hono';import {manifest} from '../api/.sprindle/routes';import type {Identity} from '../api/lib/leaf';import type {RouteContract} from '../api/.sprindle/routes';type Definition<P extends string,M extends string>=Extract<RouteContract,{path:P;method:M}>['definition'];type Input<T>=NonNullable<T extends {readonly input?:infer V}?V:never>;type Output<T>=NonNullable<T extends {readonly output?:infer V}?V:never>;type Create=Definition<'/tenants/:tenantId/items/:itemId/create','post'>;type Status=Output<Definition<'/status','get'>>;type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;type Expect<T extends true>=T;type _input=Expect<Equal<Input<Create>,{name:string;age:string}>>;type _created=Expect<Equal<Output<Create>,{data:{id:string;label:string}}>>;type _status=Expect<Equal<Status,{tenant:string;ambient:'declaration';script:'global';module:'global';augmented:'yes';revision:'one';mode:'producer';ordinary:{identity:Identity;nested:{value:'leaf'}}}>>;declare const status:Status;const app=installSprindle(new Hono(),manifest);const input:Input<Create>={name:'Book',age:'9'};const tenant:string=status.tenant;const ambient:'declaration'=status.ambient;const script:'global'=status.script;const module:'global'=status.module;const augmented:'yes'=status.augmented;const identity:Identity=status.ordinary.identity;const nested:'leaf'=status.ordinary.nested.value`)
  const externalCheck = typeCheck(external)
  expect(externalCheck.status, externalCheck.stdout + externalCheck.stderr).toBe(0)
  const suffixConsumer = join(root, '..', 'consumer-with-different-suffix')
  mkdirSync(suffixConsumer)
  mkdirSync(join(suffixConsumer, 'node_modules'), { recursive: true })
  symlinkSync(resolve(framework, 'node_modules', '@types'), join(suffixConsumer, 'node_modules', '@types'), 'dir')
  writeFileSync(join(suffixConsumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', moduleSuffixes: ['.consumer', ''], types: ['node'] }, files: ['consumer.ts'] }))
  writeFileSync(join(suffixConsumer, 'consumer.ts'), `import type {Identity} from '../api/lib/leaf';import type {RouteContract} from '../api/.sprindle/routes';type Status=Extract<RouteContract,{path:'/status';method:'get'}>['definition'];type Output=NonNullable<Status extends {readonly output?:infer V}?V:never>;type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;type Expect<T extends true>=T;type _mode=Expect<Equal<Output['mode'],'producer'>>;type _identity=Expect<Equal<Output['ordinary']['identity'],Identity>>;type _ambient=Expect<Equal<Output['augmented'],'yes'>>;declare const output:Output;const identity:Identity=output.ordinary.identity;const nested:'leaf'=output.ordinary.nested.value;const mode:'producer'=output.mode`)
  const suffixCheck = typeCheck(suffixConsumer)
  expect(suffixCheck.status, suffixCheck.stdout + suffixCheck.stderr).toBe(0)
  const checked = typeCheck(root)
  expect(checked.status, checked.stdout + checked.stderr).toBe(0)
  writeFileSync(join(root, 'invalid.ts'), `import type {RouteContract} from './.sprindle/routes';type Create=Extract<RouteContract,{path:'/tenants/:tenantId/items/:itemId/create';method:'post'}>['definition'];type Input=NonNullable<Create extends {readonly input?:infer V}?V:never>;type Output=NonNullable<Create extends {readonly output?:infer V}?V:never>;const badInput:Input={name:'Book',age:7};const badOutput:Output={data:{id:'item',label:7}}`)
  const invalid = typeCheck(root)
  expect(invalid.status).not.toBe(0)
  expect(invalid.stdout + invalid.stderr).toContain('TS2322')
  rmSync(join(root, 'invalid.ts'))
  writeFileSync(join(root, 'runtime.mts'), `import {Hono} from 'hono';import {installSprindle} from '@southneuhof/sprindle/hono';const module=await import(${JSON.stringify(pathToFileURL(join(root, '.sprindle/routes.mjs')).href)});const app=installSprindle(new Hono(),module.default);const created=await app.request('/tenants/t/items/i/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Book',age:'7'})});const output=await created.json();if(JSON.stringify(output)!==JSON.stringify({data:{id:'i',label:'child-member-7'}}))throw new Error(JSON.stringify(output));const status=await app.request('/status');if(JSON.stringify(await status.json())!==JSON.stringify({tenant:'root',ambient:'declaration',script:'global',module:'global',augmented:'yes',revision:'one',mode:'producer',ordinary:{identity:{key:1},nested:{value:'leaf'}}}))throw new Error('ambient typing source executed or route type changed')`)
  const runtime = runTsx(root, join(root, 'runtime.mts'))
  expect(runtime.status, runtime.stdout + runtime.stderr).toBe(0)
  await compileRouteManifest(root, 'routes', '.sprindle/routes-source.mjs', false)
  writeFileSync(join(root, 'identity.mts'), `import {state} from './shared/state.ts';const module=await import(${JSON.stringify(pathToFileURL(join(root, '.sprindle/routes-source.mjs')).href)});const route=module.default.find((entry:any)=>entry.httpPath==='/shared');const value=await route.handlers.GET.config.action({});if(value!==state)throw new Error('source runtime changed ordinary module identity')`)
  const identity = runTsx(root, join(root, 'identity.mts'))
  expect(identity.status, identity.stdout + identity.stderr).toBe(0)
  const results: (Error | undefined)[] = []
  const watcher = await watchRouteManifest(root, 'routes', (error) => results.push(error), '.sprindle/routes.mjs', true)
  try {
    const pointerBeforeTypeEdit = readFileSync(join(root, '.sprindle/routes.ts'), 'utf8')
    const started = results.length
    expect(watcher.hasInput(payload)).toBe(false)
    writeFileSync(payload, `export interface Payload { revision:'two' }`)
    await new Promise((done) => setTimeout(done, 350))
    expect(results).toHaveLength(started)
    writeFileSync(join(external, 'consumer.ts'), `import type {RouteContract} from '../api/.sprindle/routes';type Status=Extract<RouteContract,{path:'/status';method:'get'}>['definition'];type Output=NonNullable<Status extends {readonly output?:infer V}?V:never>;declare const output:Output;const revision:'two'=output.revision`)
    const live = typeCheck(external)
    expect(live.status, live.stdout + live.stderr).toBe(0)
    expect(readFileSync(join(root, '.sprindle/routes.ts'), 'utf8')).toBe(pointerBeforeTypeEdit)
  } finally { await watcher.close() }
})
