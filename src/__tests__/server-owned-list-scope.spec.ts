// Server-owned read scope: a model-level `before` hook fills `state.where` on list
// routes; the factory forwards it and the source ANDs it after its own query plan,
// so a client-supplied conflicting filter cannot widen the visible rows.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { authenticated, list } from '../routes'
import { installSprindle, requestContext, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'

const scopedItems = pgTable('scoped_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
})

const scopedItemEntity = createEntity({
  table: scopedItems,
  schemas: {
    create: z.object({ id: z.string(), name: z.string(), ownerId: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string(), ownerId: z.string() }),
  },
})

const source = createMemorySource<{ id: string; name: string; ownerId: string }>()

source.rows.push(
  { id: 'item-a', name: 'Mine A', ownerId: 'srv-user' },
  { id: 'item-b', name: 'Theirs B', ownerId: 'other-user' },
)

scopedItemEntity.source = source as never

const app = installSprindle(
  new Hono().onError(sprindleOnError).use('*', requestContext()),
  [
    defineModel({
      path: '/scoped-items',
      entity: scopedItemEntity,
      authorize: [authenticated()],
      before: [() => ({ where: (row: { ownerId: string }) => row.ownerId === 'srv-user' })],
      routes: { list: list() },
    }),
  ] as const,
  { identity: () => ({ id: 'user-1' }) },
)

describe('server-owned list scope', () => {
  it('restricts rows through the before hook', async () => {
    const response = await app.request('/scoped-items/list?page=1&limit=10')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: 'item-a', name: 'Mine A', ownerId: 'srv-user' }], page: 1, limit: 10, total: 1 })
  })

  it('keeps the scope winning over a conflicting client filter', async () => {
    const response = await app.request('/scoped-items/list?page=1&limit=10&ownerId=other-user')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: unknown[]; total: number }
    expect(body.data).toEqual([])
    expect(body.total).toBe(0)
  })

  it('lets a client filter that agrees with the scope pass through', async () => {
    const response = await app.request('/scoped-items/list?page=1&limit=10&ownerId=srv-user')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: 'item-a', name: 'Mine A', ownerId: 'srv-user' }], page: 1, limit: 10, total: 1 })
  })
})
