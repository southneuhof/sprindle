import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { create, defineRoute, update } from '../routes'
import { installSprindle, sprindleOnError, type DataWriteHook } from '../hono'
import { createMemorySource } from '../testing'

const entity = createEntity({
  table: { name: 'data_write_items' },
  schemas: {
    create: z.object({ id: z.string(), name: z.string(), owner: z.string() }),
    update: z.object({ name: z.string(), owner: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string(), owner: z.string() }),
  },
})
const source = createMemorySource<{ id: string; name: string; owner: string }>({ rows: [{ id: 'item-1', name: 'Existing', owner: 'old' }] })
entity.source = source as never

const identity = vi.fn(async () => ({ id: 'server-user' }))
const order: string[] = []
const dataWriteHook = vi.fn(async (args: Parameters<DataWriteHook>[0]) => {
  order.push(`data-write.${args.operation}`)
  if (args.operation === 'create') {
    const first = await args.identity()
    const second = await args.identity()
    expect(second).toBe(first)
    return { owner: 'server' }
  }
  return { owner: 'server-update' }
})

const app = installSprindle(
  new Hono().onError(sprindleOnError),
  [
    defineModel({
      path: '/data-write-items',
      entity,
      routes: {
        create: create({
          before: [({ state }) => {
            order.push('before')
            expect(state.values).toEqual({ owner: 'server' })
          }],
          validate: [() => void order.push('validate')],
        }),
        update: update(),
        custom: defineRoute({
          method: 'get',
          state: () => ({ values: { owner: 'custom' } }),
          action: ({ state }) => ({ data: state.values }),
        }),
      },
    }),
  ] as const,
  { identity, dataWrite: dataWriteHook },
)

describe('explicit data-write seam', () => {
  beforeEach(() => {
    source.rows.splice(0, source.rows.length, { id: 'item-1', name: 'Existing', owner: 'old' })
    order.length = 0
    identity.mockClear()
    dataWriteHook.mockClear()
  })

  it('runs the matching callback before generic hooks and keeps values server-owned', async () => {
    const response = await app.request('/data-write-items/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'item-2', name: 'Created', owner: 'forged' }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { id: 'item-2', name: 'Created', owner: 'server' } })
    expect(source.rows.find((row) => row.id === 'item-2')).toEqual({ id: 'item-2', name: 'Created', owner: 'server' })
    expect(order).toEqual(['data-write.create', 'before', 'validate'])
    expect(dataWriteHook).toHaveBeenCalledOnce()
    expect(identity).toHaveBeenCalledOnce()
  })

  it('runs update only for canonical update and keeps its server values', async () => {
    const response = await app.request('/data-write-items/update/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', owner: 'forged' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { id: 'item-1', name: 'Updated', owner: 'server-update' } })
    expect(dataWriteHook).toHaveBeenCalledOnce()
    expect(dataWriteHook).toHaveBeenCalledWith(expect.objectContaining({ operation: 'update' }))
  })

  it('does not invoke automatic callbacks for a custom values state', async () => {
    const response = await app.request('/data-write-items/custom')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { owner: 'custom' } })
    expect(dataWriteHook).not.toHaveBeenCalled()
  })

  if (false) {
    const hook: DataWriteHook = (args) => {
      // @ts-expect-error data-write callbacks do not receive route metadata.
      void args.route
      // @ts-expect-error data-write callbacks do not receive route state.
      void args.state
      void args.operation
      return {}
    }
    void hook
  }
})
