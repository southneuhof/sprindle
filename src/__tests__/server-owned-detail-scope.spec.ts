// Server-owned read scope on detail reads: a model-level `before` hook fills
// `state.where` on detail routes; the factory forwards it and the source ANDs
// it after the primary-key predicate, so hidden rows answer 404 instead of
// leaking through single-row reads.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { authenticated, detail } from '../routes'
import { installSprindle, requestContext, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'

const scopedItems = pgTable('scoped_detail_items', {
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
      routes: { detail: detail() },
    }),
  ] as const,
  { identity: () => ({ id: 'user-1' }) },
)

describe('server-owned detail scope', () => {
  it('answers 404 when the scope excludes the row', async () => {
    const response = await app.request('/scoped-items/detail/item-b')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })

  it('returns the row when the scope passes it', async () => {
    const response = await app.request('/scoped-items/detail/item-a')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { id: 'item-a', name: 'Mine A', ownerId: 'srv-user' } })
  })

  it('answers 404 for a missing row regardless of the scope', async () => {
    const response = await app.request('/scoped-items/detail/missing')

    expect(response.status).toBe(404)
  })
})
