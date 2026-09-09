import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { readRouteDirectory } from './route-files'

const roots: string[] = []
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'sprindle-routes-')); roots.push(root)
  for (const [name, source] of Object.entries(files)) { const file = join(root, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, source) }
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

test('reads groups, dotted static segments, parameters, scopes, and method exports', async () => {
  const root = await fixture({
    '+scope.ts': 'export default defineScope({})',
    '(auth)/+scope.ts': 'export default defineScope({})',
    '(auth)/users/[userId]/+server.ts': 'export const GET = defineRoute({}); export const PATCH = defineRoute({})',
    'openapi.json/+server.ts': 'export const GET = defineRoute({})',
    'helper.ts': 'export const POST = 1',
  })
  const model = await readRouteDirectory(root)
  expect(model.routes.map(({ httpPath }) => httpPath)).toEqual(['/openapi.json', '/users/:userId'])
  expect(model.routes[1]).toMatchObject({ parameters: ['userId'], methods: ['GET', 'PATCH'] })
  expect(model.routes[1].scopes).toHaveLength(2)
})

test('puts static routes before parameters and reports both collision files', async () => {
  const root = await fixture({
    'users/[id]/+server.ts': 'export const GET = 1',
    'users/me/+server.ts': 'export const GET = 1',
    '(other)/users/[id]/+server.ts': 'export const GET = 1',
  })
  await expect(readRouteDirectory(root)).rejects.toThrow(/duplicate GET \/users\/:parameter; also .*\+server\.ts/)
})

test('rejects different parameter names on one normalized path across methods', async () => {
  const root = await fixture({
    'users/[id]/+server.ts': 'export const GET = 1',
    '(other)/users/[slug]/+server.ts': 'export const POST = 1',
  })
  await expect(readRouteDirectory(root)).rejects.toThrow(/parameter names.*conflict/)
})

test.each([
  ['bad segment', { 'bad segment/+server.ts': 'export const GET = 1' }, /unsupported segment/],
  ['duplicate parameter', { '[id]/child/[id]/+server.ts': 'export const GET = 1' }, /duplicate parameter id/],
  ['reserved export', { 'ok/+server.ts': 'export const helper = 1' }, /invalid reserved export helper/],
  ['default export', { 'ok/+server.ts': 'export default 1' }, /invalid reserved export default/],
])('rejects %s', async (_, files, error) => expect(readRouteDirectory(await fixture(files))).rejects.toThrow(error))

test('reads aliased, multiple, and async method exports from syntax', async () => {
  const root = await fixture({ 'route/+server.ts': `const handler=1; export {handler as GET}; export const POST=1, PATCH=2; export async function PUT(){}` })
  expect((await readRouteDirectory(root)).routes[0].methods).toEqual(['GET', 'POST', 'PATCH', 'PUT'])
})

test('requires one default scope export', async () => {
  const root = await fixture({ '+scope.ts': 'export const scope = 1' })
  await expect(readRouteDirectory(root)).rejects.toThrow(/scope must export only a default definition/)
})
