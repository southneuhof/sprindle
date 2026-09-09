import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import { create, defineRoute, defineScope, detail, list, update } from '../routes'
import type { DefineFileCreate, DefineFileDetail, DefineFileList, DefineFileRoute, DefineFileScope, DefineFileUpdate, ScopeView } from '../routes/definition'

type Entity = { schemas: { create: typeof createSchema; update: typeof updateSchema; select: typeof selectSchema } }
const createSchema = z.object({ name: z.string() })
const updateSchema = z.object({ name: z.string().optional() })
const selectSchema = z.object({ id: z.string(), name: z.string() })
type Scope = ScopeView<{}, Entity, Entity>
type Params = { id: string }

const custom = defineRoute({ action: () => ({ data: 'ok' as const }) })
const createRoute = (create as DefineFileCreate<Scope, {}>)()
const detailRoute = (detail as DefineFileDetail<Scope, Params>)()
const updateRoute = (update as DefineFileUpdate<Scope, Params>)()
const identityScope = (defineScope as DefineFileScope<ScopeView, {}>)({ identity: () => ({ sessionId: 'session-1' }) })
const identityRoute = (defineRoute as DefineFileRoute<typeof identityScope, {}>)({
  action: async ({ identity }) => ({ sessionId: (await identity()).sessionId }),
})
const parentIdentityScope = (defineScope as DefineFileScope<ScopeView, {}>)({
  identity: () => ({ role: 'admin' as const }),
  authorize: async ({ identity }) => { const value: 'admin' = (await identity()).role; void value },
})
const childIdentityScope = (defineScope as DefineFileScope<typeof parentIdentityScope, {}>)({
  identity: () => ({ account: 42 }),
  context: async ({ identity }) => ({ account: (await identity()).account }),
})
const childIdentityRoute = (defineRoute as DefineFileRoute<typeof childIdentityScope, {}>)({
  action: async ({ identity }) => ({ account: (await identity()).account }),
})
const enrichedEntityScope = (defineScope as DefineFileScope<ScopeView, {}>)({
  entity: {} as Entity,
  enrich: { schema: z.object({ publicName: z.string() }), run: () => ({ publicName: 'public' }) },
})
const replacementSelect = z.object({ replacementId: z.string() })
type ReplacementEntity = { schemas: { create: typeof createSchema; update: typeof updateSchema; select: typeof replacementSelect } }
const replacementEntityScope = (defineScope as DefineFileScope<typeof enrichedEntityScope, {}>)({ entity: {} as ReplacementEntity })
const replacementList = (list as DefineFileList<typeof replacementEntityScope, {}>)()

describe('file route schema', () => {
  it('keeps method and path out of route definitions', () => {
    expect('method' in custom).toBe(false)
    expect('path' in custom).toBe(false)
    expect(custom.kind).toBe('route')
    expect(createRoute.kind).toBe('create')
  })

  it('infers custom and canonical route contracts', () => {
    expectTypeOf(custom).toMatchTypeOf<{ output?: { data: 'ok' } }>()
    expectTypeOf(createRoute).toMatchTypeOf<{ input?: { name: string }; output?: { data: { id: string; name: string } } }>()
    expectTypeOf(detailRoute).toMatchTypeOf<{ output?: { data: { id: string; name: string } } | { error: 'not_found' } }>()
    expectTypeOf(updateRoute).toMatchTypeOf<{ input?: { name?: string }; output?: { data: { id: string; name: string } } | { error: 'not_found' } }>()
    expectTypeOf(identityRoute).toMatchTypeOf<{ output?: { sessionId: string } }>()
    expectTypeOf(childIdentityRoute).toMatchTypeOf<{ output?: { account: number } }>()
    expectTypeOf(replacementList).toMatchTypeOf<{ output?: { data: { replacementId: string }[] } }>()
  })

  it('rejects method and path in public source', () => {
    if (false) {
      // @ts-expect-error File routes get their method and path from the file name and export.
      defineRoute({ method: 'get', path: '/wrong', action: () => ({}) })
    }
  })
})
