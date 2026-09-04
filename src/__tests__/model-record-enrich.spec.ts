import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { create, defineModel, deleteRoute, detail, list, update } from '../index'
import { installSprindle, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'
import type { ModelRuntimeEntity } from '../source'

const source = createMemorySource<{ id: string; name: string }>({ rows: [{ id: 'item-1', name: 'Original' }] })
const entitySchemas = {
  create: z.object({ id: z.string(), name: z.string() }),
  update: z.object({ name: z.string().optional() }),
  select: z.object({ id: z.string(), name: z.string() }),
}
const entity = {
  name: 'items',
  source,
  schemas: entitySchemas,
} as unknown as ModelRuntimeEntity & { schemas: typeof entitySchemas }

const publicRecord = z.object({ id: z.string(), name: z.string(), publicName: z.string() }).strict()
const modelRun = vi.fn(async (record: unknown) => ({ ...(record as object), publicName: 'public' }))
const routeRun = vi.fn((record: unknown) => ({ ...(record as object), routeName: 'route' }))

const model = defineModel({
  path: '/items',
  entity,
  enrich: { schema: publicRecord, run: modelRun },
  routes: {
    list: list({ enrich: (records) => (routeRun(records), records) }),
    detail: detail({ enrich: (record) => (routeRun(record), { ...(record as object), routeName: 'route' }) }),
    create: create({ enrich: (record) => (routeRun(record), { ...(record as object), routeName: 'route' }) }),
    update: update({ enrich: (record) => (routeRun(record), { ...(record as object), routeName: 'route' }) }),
    delete: deleteRoute(),
  },
})

const app = installSprindle(new Hono().onError(sprindleOnError), [model] as const)

describe('model record enrichment', () => {
  it('maps every canonical record before route enrichment', async () => {
    const listResponse = await app.request('/items/list')
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toMatchObject({ data: [{ id: 'item-1', publicName: 'public' }] })

    const detailResponse = await app.request('/items/detail/item-1')
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toMatchObject({ data: { id: 'item-1', publicName: 'public', routeName: 'route' } })

    const createResponse = await app.request('/items/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'item-2', name: 'Created' }),
    })
    expect(createResponse.status).toBe(201)
    expect(await createResponse.json()).toMatchObject({ data: { id: 'item-2', publicName: 'public', routeName: 'route' } })

    const updateResponse = await app.request('/items/update/item-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    })
    expect(updateResponse.status).toBe(200)
    expect(await updateResponse.json()).toMatchObject({ data: { id: 'item-1', publicName: 'public', routeName: 'route' } })

    expect(modelRun).toHaveBeenCalledTimes(4)
    expect(routeRun).toHaveBeenCalledTimes(4)
    expect(modelRun.mock.invocationCallOrder.every((call, index) => call < routeRun.mock.invocationCallOrder[index])).toBe(true)
  })

  it('supports async model runs and skips missing, delete, and custom records', async () => {
    const before = modelRun.mock.calls.length
    expect((await app.request('/items/detail/missing')).status).toBe(404)
    expect(
      (
        await app.request('/items/update/missing', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Missing' }),
        })
      ).status,
    ).toBe(404)
    expect((await app.request('/items/delete/item-2', { method: 'DELETE' })).status).toBe(200)
    expect(modelRun.mock.calls.length).toBe(before)
  })

  it('parses the model result before the response envelope', async () => {
    const invalid = defineModel({
      path: '/invalid-items',
      entity,
      enrich: { schema: publicRecord, run: (record) => record },
      routes: { detail: detail() },
    })
    const invalidApp = installSprindle(new Hono().onError(sprindleOnError), [invalid] as const)
    const response = await invalidApp.request('/invalid-items/detail/item-1')
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('validation_error')
  })

  it('keeps no-config responses unchanged', async () => {
    const plain = defineModel({ path: '/plain-items', entity, routes: { detail: detail() } })
    const plainApp = installSprindle(new Hono(), [plain] as const)
    expect(await (await plainApp.request('/plain-items/detail/item-1')).json()).toEqual({ data: { id: 'item-1', name: 'Updated' } })
  })

  it('carries the public schema output into the local route type', () => {
    type LocalSchema = typeof model.route extends Hono<any, infer TSchema> ? TSchema : never
    type DetailOutput = Extract<LocalSchema['/detail/:id']['$get'], { status: 200 }>['output']
    expectTypeOf<DetailOutput>().toEqualTypeOf<{ data: z.output<typeof publicRecord> }>()
  })
})
