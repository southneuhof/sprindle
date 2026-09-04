import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { create, deleteRoute, list, update } from '../routes'
import { installSprindle, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'

const entity = createEntity({
  table: { name: 'canonical_run_items' },
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})
const source = createMemorySource<{ id: string; name: string }>({ rows: [{ id: 'item-1', name: 'Existing' }] })
entity.source = source as never

const listRun = vi.fn(async () => ({ data: [{ id: 'item-1', name: 'Listed' }], total: 1 }))
const createRun = vi.fn(async (args: { state: { input: Record<string, unknown> } }) => args.state.input)
const updateRun = vi.fn(async (args: { state: { id: string; input: Record<string, unknown> } }) => {
  if (args.state.id === 'missing') return undefined
  return { id: args.state.id, ...args.state.input }
})
const deleteRun = vi.fn(async () => undefined)

const model = defineModel({
  path: '/canonical-run-items',
  entity,
  routes: {
    list: list({ run: listRun }),
    create: create({ run: createRun }),
    update: update({ run: updateRun }),
    delete: deleteRoute({ run: deleteRun }),
  },
})

const app = installSprindle(new Hono().onError(sprindleOnError), [model] as const)

describe('canonical constructor run seams', () => {
  it('keeps canonical list, create, and update wire contracts', async () => {
    const listResponse = await app.request('/canonical-run-items/list?page=2&limit=5')
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toEqual({ data: [{ id: 'item-1', name: 'Listed' }], page: 2, limit: 5, total: 1 })
    expect(listRun).toHaveBeenCalledOnce()

    const createResponse = await app.request('/canonical-run-items/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'item-2', name: 'Created' }),
    })
    expect(createResponse.status).toBe(201)
    expect(await createResponse.json()).toEqual({ data: { id: 'item-2', name: 'Created' } })
    expect(createRun).toHaveBeenCalledOnce()

    const updateResponse = await app.request('/canonical-run-items/update/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    })
    expect(updateResponse.status).toBe(200)
    expect(await updateResponse.json()).toEqual({ data: { id: 'item-1', name: 'Updated' } })
    expect(updateRun).toHaveBeenCalledOnce()
  })

  it('keeps constructor-owned not-found and delete responses', async () => {
    const updateResponse = await app.request('/canonical-run-items/update/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Missing' }),
    })
    expect(updateResponse.status).toBe(404)
    expect(await updateResponse.json()).toEqual({ error: 'not_found' })

    const deleteResponse = await app.request('/canonical-run-items/delete/item-1', { method: 'DELETE' })
    expect(deleteResponse.status).toBe(200)
    expect(await deleteResponse.json()).toEqual({ ok: true })
    expect(deleteRun).toHaveBeenCalledOnce()
  })
})
