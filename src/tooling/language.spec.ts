import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { createRouteLanguage, redirectSprindleImports } from './language'

const projects: string[] = []
function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'sprindle-language-test-')); projects.push(project)
  const root = join(project, 'routes'); mkdirSync(root)
  mkdirSync(join(project, 'node_modules'))
  symlinkSync(join(import.meta.dirname, '../../node_modules/zod'), join(project, 'node_modules/zod'), 'dir')
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, include: ['routes/**/*.ts'] }))
  const put = (name: string, source: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `import { defineScope, defineRoute, list, detail, create, update } from '@southneuhof/sprindle'\n${source}`); return file }
  return { project, root, put }
}
afterEach(() => projects.splice(0).forEach((project) => rmSync(project, { recursive: true, force: true })))

test('infers parameters, replaced child context, and Zod output without broad context', () => {
  const { project, put } = fixture()
  put('+scope.ts', `export default defineScope({context:()=>({user:{id:'u'}, replaced:1})})`)
  const parent = put('(auth)/+scope.ts', `export default defineScope({context:({context})=>({owner:context.user.id, replaced:'text'})})`)
  put('(auth)/users/+scope.ts', `import { z } from 'zod'; export default defineScope({entity:{schemas:{select:z.object({id:z.string(),name:z.string()})}}})`)
  const route = put('(auth)/users/[userId]/+server.ts', `export const GET=defineRoute({action:({params,context})=>({id:params.userId,owner:context.owner,value:context.replaced})})`)
  put('(other)/+scope.ts', `// owner is unrelated\nexport default defineScope({context:()=>({owner:'wrong'})})`)
  const list = put('(auth)/users/list/+server.ts', `export const GET=list({run:({context,state})=>({data:[{id:context.user.id,name:'A'}],total:state.query.page})})`)
  const language = createRouteLanguage(project)
  expect(language.diagnostics()).toEqual([])
  const routeText = readFileSync(route, 'utf8')
  expect(language.type(route, routeText.indexOf('params.userId') + 7)).toBe('string')
  expect(language.type(route, routeText.indexOf('context.replaced') + 8)).toBe('string')
  expect(language.definitions(route, routeText.indexOf('context.owner') + 8)).toEqual([expect.objectContaining({ fileName: parent })])
  expect(() => language.rename(route, routeText.indexOf('context.owner') + 8)).toThrow(/complete references cannot be proven/)
  expect(() => language.rename(route, routeText.indexOf('params.userId') + 7)).toThrow(/requires a directory move/)
  language.open(list, readFileSync(list, 'utf8').replace("name:'A'", "label:'A'"))
  expect(language.diagnostics().some((error) => error.fileName === list && error.code === 2322)).toBe(true)
  language.closeDocument(list)
  language.open(parent, readFileSync(parent, 'utf8').replace('owner:', 'account:'))
  expect(language.diagnostics().some((error) => error.fileName === route && error.text.includes('owner'))).toBe(true)
  language.close()
})

test('maps incomplete edits and add, move, and delete changes to source files', () => {
  const { project, root, put } = fixture()
  put('+scope.ts', `const user={id:'u'};export default defineScope({context:()=>({user})})`)
  const route = put('[id]/+server.ts', `export const GET=defineRoute({action:({params,context})=>params.id})`)
  const language = createRouteLanguage(project)
  const source = readFileSync(route, 'utf8')
  language.open(route, source.replace('params.id', 'params.wrong'))
  expect(language.diagnostics()).toContainEqual(expect.objectContaining({ fileName: route, pos: source.indexOf('params.id') + 7, code: 2339 }))
  language.closeDocument(route)
  const added = put('[id]/child/[childId]/+server.ts', `export const GET=defineRoute({action:({params})=>params.childId})`)
  expect(language.diagnostics()).toEqual([])
  const moved = join(root, 'public/[slug]/+server.ts'); mkdirSync(dirname(moved), { recursive: true }); renameSync(added, moved)
  expect(language.diagnostics().some((error) => error.fileName === moved && error.text.includes('childId'))).toBe(true)
  rmSync(moved)
  expect(language.diagnostics()).toEqual([])
  language.close()
})

test('rewrites aliases and type imports without changing offsets or comments', () => {
  const source = `// from '@southneuhof/sprindle'\nimport { defineRoute as route, type FileRouteArgs } from '@southneuhof/sprindle'\nroute(`
  const output = redirectSprindleImports(source, './.r')
  expect(output).toHaveLength(source.length)
  expect(output).toContain(`// from '@southneuhof/sprindle'`)
  expect(output).toContain(`from "./.r"`)
})

test('preserves JSONC config roots and normal project diagnostics', () => {
  const { project, put } = fixture()
  writeFileSync(join(project, 'base.json'), `{"compilerOptions":{"strict":true,"noEmit":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","skipLibCheck":true}}`)
  writeFileSync(join(project, 'tsconfig.json'), `{
    // The native compiler must parse this file.
    "extends": "./base.json",
    "include": ["**/*.ts"],
  }`)
  const other = join(project, 'other.ts'); writeFileSync(other, `const value: number = 'wrong'`)
  put('ok/+server.ts', `export const GET=defineRoute({action:()=>({ok:true})})`)
  const language = createRouteLanguage(project)
  expect(language.diagnostics()).toContainEqual(expect.objectContaining({ fileName: other, code: 2322 }))
  writeFileSync(other, `export const value: number = 1`)
  expect(language.diagnostics()).not.toContainEqual(expect.objectContaining({ fileName: other, code: 2322 }))
  language.open(other, `export const value: number = 'open error'`)
  expect(language.diagnostics()).toContainEqual(expect.objectContaining({ fileName: other, code: 2322 }))
  language.closeDocument(other)
  expect(language.diagnostics()).not.toContainEqual(expect.objectContaining({ fileName: other, code: 2322 }))
  language.close()
})

test('preserves dependency declaration diagnostics when skipLibCheck is false', () => {
  const { project, put } = fixture()
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: false }, include: ['**/*.ts'] }))
  const dependency = join(project, 'node_modules', 'broken'); mkdirSync(dependency)
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ types: 'index.d.ts' }))
  const declaration = join(dependency, 'index.d.ts'); writeFileSync(declaration, `export declare const broken: MissingDependencyType`)
  writeFileSync(join(project, 'other.ts'), `import { broken } from 'broken';void broken`)
  put('ok/+server.ts', `export const GET=defineRoute({action:()=>1})`)
  const language = createRouteLanguage(project)
  expect(language.diagnostics().some((item) => item.code === 2304 && item.fileName?.endsWith('/node_modules/broken/index.d.ts'))).toBe(true)
  language.close()
})

test('recovers from incomplete first-line and same-line imports', () => {
  const { project, put } = fixture()
  const route = put('broken/+server.ts', `export const GET=defineRoute({action:()=>1})`)
  const language = createRouteLanguage(project)
  language.open(route, 'import { defineRoute')
  expect(() => language.diagnostics()).not.toThrow()
  language.open(route, `import {defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:()=>1})`)
  expect(language.diagnostics()).toEqual([])
  language.close()
})

test('rejects a context rename before any partial destructuring edits', () => {
  const { project, put } = fixture()
  put('+scope.ts', `export default defineScope({context:()=>({user:{id:'u'}})})`)
  const route = put('me/+server.ts', `export const GET=defineRoute({action:({context})=>{const {user}=context;return user.id}})`)
  const language = createRouteLanguage(project)
  const source = readFileSync(route, 'utf8')
  expect(() => language.rename(route, source.indexOf('{user}') + 1)).toThrow(/complete references cannot be proven/)
  language.close()
})

test('refuses alias, computed, and imported helper property renames without edits', () => {
  const { project, put } = fixture()
  put('+scope.ts', `export default defineScope({context:()=>({user:{id:'u'}})})`)
  const alias = put('alias/+server.ts', `export const GET=defineRoute({action:({context})=>{const {user:current}=context;return current.id}})`)
  put('computed/+server.ts', `export const GET=defineRoute({action:({context})=>context['user'].id})`)
  writeFileSync(join(project, 'helper.ts'), `export const read=(context:{user:{id:string}})=>context.user.id`)
  const language = createRouteLanguage(project)
  const source = readFileSync(alias, 'utf8')
  expect(() => language.rename(alias, source.indexOf('user:current'))).toThrow(/complete references cannot be proven/)
  language.close()
})

test('opens the actual API TypeScript project without replacing its configured roots', () => {
  const apiRoot = join(import.meta.dirname, '../../../../apps/api')
  const language = createRouteLanguage(apiRoot, 'src/routes')
  expect(() => language.diagnostics()).not.toThrow()
  language.close()
})

test('infers enriched public records and parsed create and update values', () => {
  const { project, put } = fixture()
  put('users/+scope.ts', `import { z } from 'zod'; export default defineScope({entity:{schemas:{select:z.object({id:z.string()}),create:z.object({age:z.coerce.number()}),update:z.object({age:z.coerce.number()})}},enrich:{schema:z.object({id:z.string(),label:z.string()}),run:record=>({...record,label:record.id})}})`)
  put('users/+server.ts', `export const GET=list({run:()=>({data:[{id:'1'}],total:1})});export const POST=create({run:({state})=>{const age:number=state.input.age;return {id:String(age)}}});const listLabel:string=(null as unknown as NonNullable<typeof GET.output>).data[0].label;const createLabel:string=(null as unknown as NonNullable<typeof POST.output>).data.label`)
  put('users/[id]/+server.ts', `export const PATCH=update({run:({state})=>{const age:number=state.input.age;return {id:String(age)}}});const updateLabel:string=(null as unknown as Exclude<NonNullable<typeof PATCH.output>,{error:string}>).data.label`)
  const language = createRouteLanguage(project)
  expect(language.diagnostics()).toEqual([])
  language.close()
})

test('checks the accepted scope, custom route, list, and detail contracts without annotations', () => {
  const { project, put } = fixture()
  put('+scope.ts', `
    export default defineScope({
      context: async ({c}) => ({header:c.req.header('authorization'), user:{id:'u'}}),
      authorize: ({c,identity}) => { c.header('x-auth','yes'); void identity() },
      after: ({response}) => response,
      error: ({error}) => { void error },
    })`)
  put('me/+server.ts', `export const GET=defineRoute({state:()=>({seen:true}),before:({state})=>({seen:state.seen}),authorize:({context})=>{void context.user.id},validate:({state})=>{void state.seen},action:({c,context,state,identity})=>{void c;void state;void identity();return {user:context.user,header:context.header}}})`)
  put('users/+scope.ts', `import { z } from 'zod'; export default defineScope({entity:{schemas:{select:z.object({id:z.string(),name:z.string()}),create:z.object({name:z.string()}),update:z.object({name:z.string().optional()})}}})`)
  put('users/+server.ts', `export const GET=list({authorize:({context})=>{void context.user.id},before:({state})=>({where:state.query.page}),run:({context,state})=>({data:[{id:context.user.id,name:'A'}],total:state.query.limit})})`)
  put('users/[id]/+server.ts', `export const GET=detail({param:'id',authorize:({params})=>{void params.id},before:({state})=>({where:state.id})})`)
  const language = createRouteLanguage(project)
  expect(language.diagnostics()).toEqual([])
  language.close()
})
