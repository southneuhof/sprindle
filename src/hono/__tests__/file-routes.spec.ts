import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { forbidden } from '../../errors'
import { installSprindle, sprindleNotFound, sprindleOnError, type FileRouteManifestEntry } from '..'
import { create, defineRoute, defineScope, detail, list, update } from '../../routes'
import { createTestEntity } from '../../testing'

const entry = (path: string, handlers: Record<string, unknown>, scopes: unknown[] = [], parameters: string[] = []): FileRouteManifestEntry => ({
  sourcePath: `${path}/+server.ts`, httpPath: path, parameters, methods: Object.keys(handlers), scopes, handlers,
})
const app = (routes: FileRouteManifestEntry[], options = {}) => installSprindle(new Hono().onError(sprindleOnError).notFound(sprindleNotFound), routes, options)

describe('file route runtime', () => {
  it('runs entered scopes in order and unwinds errors through entered scopes', async () => {
    const order: string[] = []
    const outer = defineScope({ context: () => { order.push('outer-context'); return { outer: true } }, authorize: () => { order.push('outer-authorize') }, error: () => { order.push('outer-error') } })
    const inner = defineScope({ context: () => { order.push('inner-context'); return { inner: true } }, authorize: () => { order.push('inner-authorize') }, error: () => { order.push('inner-error') } })
    const route = defineRoute({ authorize: () => { order.push('route-authorize') }, action: () => { throw new Error('failure') }, error: () => { order.push('route-error') } })
    const response = await app([entry('/nested', { GET: route }, [outer, inner])]).request('/nested')
    expect(response.status).toBe(500)
    expect(order).toEqual(['outer-context', 'outer-authorize', 'inner-context', 'inner-authorize', 'route-authorize', 'route-error', 'inner-error', 'outer-error'])
  })

  it('stops before child context after a parent rejection', async () => {
    const child = vi.fn()
    const parent = defineScope({ authorize: () => { throw forbidden() } })
    const route = defineRoute({ action: () => ({ ok: true }) })
    const response = await app([entry('/private', { GET: route }, [parent, defineScope({ context: child })])]).request('/private')
    expect(response.status).toBe(403)
    expect(child).not.toHaveBeenCalled()
  })

  it('unwinds errors only through scopes and routes that entered', async () => {
    const calls: string[] = []
    const route = defineRoute({ action: () => ({ ok: true }), error: () => { calls.push('route-error'); return new Response('bypassed') } })
    const child = defineScope({ context: () => { calls.push('child-context'); throw new Error('child') }, error: () => { calls.push('child-error') } })
    const parentContext = defineScope({ context: () => { throw new Error('parent-context') }, error: () => { calls.push('parent-context-error') } })
    expect((await app([entry('/parent-context', { GET: route }, [parentContext, child])]).request('/parent-context')).status).toBe(500)
    expect(calls).toEqual([])

    const parentAuth = defineScope({ authorize: () => { throw forbidden() }, error: () => { calls.push('parent-auth-error') } })
    expect((await app([entry('/parent-auth', { GET: route }, [parentAuth, child])]).request('/parent-auth')).status).toBe(403)
    expect(calls).toEqual(['parent-auth-error'])

    calls.length = 0
    const parent = defineScope({ error: () => { calls.push('parent-error') } })
    expect((await app([entry('/child-context', { GET: route }, [parent, child])]).request('/child-context')).status).toBe(500)
    expect(calls).toEqual(['child-context', 'parent-error'])

    calls.length = 0
    const enteredRoute = defineRoute({ action: () => { throw new Error('route') }, error: () => { calls.push('route-error'); return new Response('handled') } })
    expect((await app([entry('/route', { GET: enteredRoute }, [parent])]).request('/route')).status).toBe(200)
    expect(calls).toEqual(['route-error'])
  })

  it('runs route middleware around early responses and errors', async () => {
    const calls: string[] = []
    const middleware = async (c: Parameters<NonNullable<Parameters<typeof defineRoute>[0]['middleware']>[number]>[0], next: () => Promise<void>) => {
      calls.push('before')
      await next()
      calls.push('after')
      c.header('x-cleanup', 'yes')
    }
    const denied = defineRoute({ middleware: [async (c) => c.json({ denied: true }, 403)], action: () => ({ ok: true }) })
    expect(await (await app([entry('/denied', { GET: denied })]).request('/denied')).json()).toEqual({ denied: true })
    const failure = defineRoute({ middleware: [middleware], action: () => { throw new Error('failure') } })
    const response = await app([entry('/failure', { GET: failure })]).request('/failure')
    expect(response.status).toBe(500)
    expect(response.headers.get('x-cleanup')).toBe('yes')
    expect(calls).toEqual(['before', 'after'])
  })

  it('parses create input before typed hooks and custom run', async () => {
    const entity = createTestEntity({ schemas: { create: z.object({ age: z.coerce.number() }), select: z.object({ age: z.number() }) } })
    const route = create({ run: ({ state }) => ({ age: state.input.age }) })
    const response = await app([entry('/people', { POST: route }, [defineScope({ entity })])]).request('/people', { method: 'POST', body: JSON.stringify({ age: '42' }) })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { age: 42 } })
  })

  it('persists parsed state edits and parses each canonical write once', async () => {
    let createParses = 0, updateParses = 0
    const entity = createTestEntity({
      rows: [{ id: 'one', name: 'before' }],
      schemas: {
        create: z.preprocess((value) => { createParses++; return value }, z.object({ name: z.string().transform((value) => value.trim()) })),
        update: z.preprocess((value) => { updateParses++; return value }, z.object({ name: z.string().transform((value) => value.trim()) }).partial()),
        select: z.object({ id: z.string(), name: z.string() }),
      },
    })
    const scope = defineScope({ entity })
    const target = app([
      entry('/items', { POST: create({ before: ({ state }) => { state.input.name = 'created' } }) }, [scope]),
      entry('/items/:id', { PATCH: update({ before: ({ state }) => { state.input.name = 'updated' } }) }, [scope], ['id']),
    ])
    expect(await (await target.request('/items', { method: 'POST', body: JSON.stringify({ name: ' raw ' }) })).json()).toMatchObject({ data: { name: 'created' } })
    expect(await (await target.request('/items/one', { method: 'PATCH', body: JSON.stringify({ name: ' raw ' }) })).json()).toMatchObject({ data: { name: 'updated' } })
    expect({ createParses, updateParses }).toEqual({ createParses: 1, updateParses: 1 })
  })

  it('enters identity resolvers in scope order', async () => {
    const childIdentity = vi.fn(() => ({ account: 'child' }))
    const root = defineScope({ identity: () => ({ role: 'guest' }), authorize: async ({ identity }) => { if (JSON.stringify(await identity()) !== '{"role":"admin"}') throw forbidden() } })
    const child = defineScope({ identity: childIdentity })
    const route = defineRoute({ action: async ({ identity }) => ({ identity: await identity() }) })
    expect((await app([entry('/denied-identity', { GET: route }, [root, child])]).request('/denied-identity')).status).toBe(403)
    expect(childIdentity).not.toHaveBeenCalled()

    const allowedRoot = defineScope({ identity: () => ({ role: 'admin' }), authorize: async ({ identity }) => { if (JSON.stringify(await identity()) !== '{"role":"admin"}') throw forbidden() } })
    expect(await (await app([entry('/allowed-identity', { GET: route }, [allowedRoot, child])]).request('/allowed-identity')).json()).toEqual({ identity: { account: 'child' } })
    expect(childIdentity).toHaveBeenCalledTimes(1)
  })

  it('keeps the context snapshot for each entered scope', async () => {
    const calls: string[] = []
    const root = defineScope({
      context: () => ({ value: 1 }),
      before: ({ context }) => { calls.push(`root-before-${context.value.toFixed()}`) },
      validate: ({ context }) => { calls.push(`root-validate-${context.value.toFixed()}`) },
      after: ({ context }) => { calls.push(`root-after-${context.value.toFixed()}`) },
      error: ({ context }) => { calls.push(`root-error-${context.value.toFixed()}`) },
    })
    const child = defineScope({
      context: () => ({ value: 'text' }),
      before: ({ context }) => { calls.push(`child-before-${context.value.toUpperCase()}`) },
    })
    const route = defineRoute({ action: ({ context }) => ({ value: context.value }) })
    const target = app([entry('/context-snapshots', { GET: route }, [root, child])])
    expect(await (await target.request('/context-snapshots')).json()).toEqual({ value: 'text' })
    expect(calls).toEqual(['root-before-1', 'child-before-TEXT', 'root-validate-1', 'root-after-1'])

    calls.length = 0
    const failure = defineRoute({ action: () => { throw new Error('failure') } })
    expect((await app([entry('/context-error', { GET: failure }, [root, child])]).request('/context-error')).status).toBe(500)
    expect(calls).toContain('root-error-1')
  })

  it('clears inherited enrichment for a new entity and applies enrich-only descendants', async () => {
    const first = createTestEntity({ rows: [{ id: 'first', name: 'First' }] })
    const second = createTestEntity({ rows: [{ id: 'second', name: 'Second' }] })
    const parent = defineScope({ entity: first, enrich: { schema: z.object({ parent: z.boolean() }), run: () => ({ parent: true }) } })
    const replacement = defineScope({ entity: second })
    const child = defineScope({ enrich: { schema: z.object({ child: z.boolean() }), run: () => ({ child: true }) } })
    const target = app([
      entry('/replacement', { GET: list() }, [parent, replacement]),
      entry('/child', { GET: list() }, [parent, replacement, child]),
    ])
    expect((await (await target.request('/replacement')).json()).data).toEqual([{ id: 'second', name: 'Second' }])
    expect((await (await target.request('/child')).json()).data).toEqual([{ child: true }])
  })

  it('uses the declaring scope context for inherited enrichment', async () => {
    const entity = createTestEntity({ rows: [{ id: 'one' }] })
    const parent = defineScope({
      context: () => ({ value: 1 }),
      entity,
      enrich: { schema: z.object({ value: z.string() }), run: (_record, { context }) => ({ value: context.value.toFixed() }) },
    })
    const child = defineScope({ context: () => ({ value: 'child' }) })
    const response = await app([entry('/enrich-context', { GET: list() }, [parent, child])]).request('/enrich-context')
    expect(await response.json()).toMatchObject({ data: [{ value: '1' }] })
  })

  it('uses the declaring scope identity for inherited enrichment', async () => {
    const entity = createTestEntity({ rows: [{ id: 'one' }] })
    const parent = defineScope({
      identity: () => ({ value: 1 }),
      entity,
      enrich: { schema: z.object({ value: z.string() }), run: async (_record, { identity }) => ({ value: (await identity()).value.toFixed() }) },
    })
    const childIdentity = vi.fn(() => ({ value: 'child' }))
    const child = defineScope({ identity: childIdentity })
    const response = await app([entry('/enrich-identity', { GET: list() }, [parent, child])]).request('/enrich-identity')
    expect(await response.json()).toMatchObject({ data: [{ value: '1' }] })
    expect(childIdentity).not.toHaveBeenCalled()
  })

  it('keeps framework metadata outside business context', async () => {
    const entity = createTestEntity()
    const route = list({ run: ({ context }) => ({ data: [{ keys: Object.keys(context) }], total: 1 }) })
    const target = app([entry('/items', { GET: route }, [defineScope({ entity }), defineScope({ enrich: { schema: z.object({ keys: z.array(z.string()), public: z.boolean() }), run: async (record) => ({ ...(record as { keys: string[] }), public: true }) } })])])
    const result = await (await target.request('/items')).json() as { data: { keys: string[]; public: boolean }[] }
    expect(result.data[0]).toEqual({ keys: [], public: true })
    const reserved = app([entry('/reserved', { GET: defineRoute({ action: () => ({ ok: true }) }) }, [defineScope({ context: () => ({ entity: 'bad' }) })])])
    expect((await reserved.request('/reserved')).status).toBe(500)
  })

  it('creates fresh context and memoizes identity for each request', async () => {
    let contextId = 0
    const identities = vi.fn(() => ({ id: crypto.randomUUID() }))
    const scope = defineScope({ context: () => ({ request: ++contextId }) })
    const route = defineRoute({ action: async ({ context, identity }) => ({ request: context.request, same: await identity() === await identity() }) })
    const target = app([entry('/requests', { GET: route }, [scope])], { identity: identities })
    expect(await (await target.request('/requests')).json()).toEqual({ request: 1, same: true })
    expect(await (await target.request('/requests')).json()).toEqual({ request: 2, same: true })
    expect(identities).toHaveBeenCalledTimes(2)
  })

  it('runs canonical resource state, audit values, and public conversion', async () => {
    const entity = createTestEntity({ rows: [{ id: 'one', name: 'Raw' }], schemas: { select: z.object({ id: z.string(), name: z.string(), audit: z.string().optional() }) } })
    const scope = defineScope({ entity, enrich: { schema: z.object({ id: z.string(), name: z.string(), audit: z.string().optional(), public: z.boolean() }), run: async (record) => ({ ...(record as { id: string; name: string }), public: true }) } })
    const routes = [
      entry('/items', { GET: list() }, [scope]),
      entry('/items/:id', { GET: detail(), PATCH: update() }, [scope], ['id']),
      entry('/items/create', { POST: create() }, [scope]),
    ]
    const target = app(routes, { dataWrite: ({ operation }) => ({ audit: operation }) })
    const listed = await (await target.request('/items')).json() as { data: unknown[] }
    expect(listed.data[0]).toMatchObject({ id: 'one', public: true })
    const created = await target.request('/items/create', { method: 'POST', body: JSON.stringify({ name: 'New' }) })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ data: { name: 'New', audit: 'create', public: true } })
    const updated = await target.request('/items/one', { method: 'PATCH', body: JSON.stringify({ name: 'Changed' }) })
    expect(await updated.json()).toMatchObject({ data: { name: 'Changed', audit: 'update', public: true } })
  })

  it('supports named parameters, HEAD, explicit HEAD, OPTIONS, 405, and 404', async () => {
    const get = defineRoute({ action: ({ params }) => ({ id: params.userId }) })
    const head = defineRoute({ action: () => new Response(null, { status: 204 }) })
    const target = app([entry('/users/:userId', { GET: get, HEAD: head }, [], ['userId'])])
    expect(await (await target.request('/users/a')).json()).toEqual({ id: 'a' })
    expect((await target.request('/users/a', { method: 'HEAD' })).status).toBe(204)
    const options = await target.request('/users/a', { method: 'OPTIONS' })
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    const rejected = await target.request('/users/a', { method: 'POST' })
    expect(rejected.status).toBe(405)
    expect(rejected.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    expect((await target.request('/missing')).status).toBe(404)
  })

  it('combines methods for one normalized path and uses the final explicit HEAD response', async () => {
    const head = defineRoute({ middleware: [async (c, next) => { await next(); c.res = new Response(null, { status: 207, headers: { 'x-head': 'changed' } }) }], action: () => new Response(null, { status: 204 }) })
    const target = app([
      entry('/things/:id', { GET: defineRoute({ action: () => ({ get: true }) }), HEAD: head }, [], ['id']),
      entry('/things/:id', { POST: defineRoute({ action: () => ({ post: true }) }) }, [], ['id']),
      entry('/things/static', { GET: defineRoute({ action: () => ({ static: true }) }) }),
    ])
    const options = await target.request('/things/value', { method: 'OPTIONS' })
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST')
    const response = await target.request('/things/value', { method: 'HEAD' })
    expect(response.status).toBe(207)
    expect(response.headers.get('x-head')).toBe('changed')
    expect(await (await target.request('/things/static')).json()).toEqual({ static: true })
    expect(() => app([
      entry('/same/:id', { GET: defineRoute({ action: () => ({}) }) }, [], ['id']),
      entry('/same/:slug', { POST: defineRoute({ action: () => ({}) }) }, [], ['slug']),
    ])).toThrow('parameter names')
  })

  it('runs install, scope, and route hooks in composition order', async () => {
    const order: string[] = []
    const layer = (name: string) => ({
      authorize: () => { order.push(`${name}-authorize`) },
      before: () => { order.push(`${name}-before`) },
      after: ({ response }: { response?: Response }) => { order.push(`${name}-after`); return response },
    })
    const scope = defineScope(layer('scope'))
    const route = defineRoute({ ...layer('route'), action: () => { order.push('action'); return { ok: true } } })
    const target = app([entry('/order', { GET: route }, [scope])], { pipeline: layer('install') })
    expect((await target.request('/order')).status).toBe(200)
    expect(order).toEqual([
      'install-authorize', 'scope-authorize', 'route-authorize',
      'install-before', 'scope-before', 'route-before', 'action',
      'route-after', 'scope-after', 'install-after',
    ])
  })

  it('applies list policy before hooks and reports invalid enum filters', async () => {
    const observed: unknown[] = []
    const entity = createTestEntity({ rows: [{ id: 'one', status: 'active', createdAt: '2026-01-01' }] })
    const scope = defineScope({ entity })
    const route = list({
      query: { defaultSort: 'createdAt', enumFilters: { status: ['active', 'inactive'] } },
      before: ({ state }) => { observed.push({ ...state.query as object }) },
    })
    const target = app([entry('/items', { GET: route }, [scope])])
    expect((await target.request('/items?status=active')).status).toBe(200)
    expect(observed[0]).toMatchObject({ sort: 'createdAt', status: 'active' })
    const invalid = await target.request('/items?status=other')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'validation_error' })
  })

  it('uses a named resource parameter', async () => {
    const entity = createTestEntity({ rows: [{ id: 'one', name: 'One' }] })
    const target = app([entry('/items/:itemId', { GET: detail({ param: 'itemId' }) }, [defineScope({ entity })], ['itemId'])])
    expect(await (await target.request('/items/one')).json()).toMatchObject({ data: { id: 'one' } })
  })

  it('rejects invalid resource definitions before requests', () => {
    expect(() => app([entry('/items', { POST: list() })])).toThrow('list cannot be exported as POST')
    expect(() => app([entry('/items/:itemId', { GET: detail() }, [defineScope({ entity: createTestEntity() })], ['itemId'])])).toThrow('needs parameter id')
    expect(() => app([entry('/custom', { GET: defineRoute({ action: () => ({}) }) }, [{}])])).toThrow('invalid scope definition')
    expect(() => app([entry('/bad-entity', { GET: list() }, [defineScope({ entity: { name: 'bad', schemas: {}, source: {} } as never })])])).toThrow('schemas.create.parse')
  })
})
