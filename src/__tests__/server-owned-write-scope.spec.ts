import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { authenticated, deleteRoute, update } from '../routes'
import { installSprindle, requestContext, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'

const scopedItems = pgTable('scoped_write_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
})

const entity = createEntity({
  table: scopedItems,
  schemas: {
    create: z.object({ id: z.string(), name: z.string(), ownerId: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string(), ownerId: z.string() }),
  },
})

const source = createMemorySource<{ id: string; name: string; ownerId: string }>({
  rows: [
    { id: 'item-a', name: 'Mine A', ownerId: 'srv-user' },
    { id: 'item-b', name: 'Theirs B', ownerId: 'other-user' },
  ],
})
entity.source = source as never

const app = installSprindle(
  new Hono().onError(sprindleOnError).use('*', requestContext()),
  [defineModel({
    path: '/scoped-write-items',
    entity,
    authorize: [authenticated()],
    before: [() => ({ where: (row: { ownerId: string }) => row.ownerId === 'srv-user' })],
    routes: { update: update(), delete: deleteRoute() },
  })] as const,
  { identity: () => ({ id: 'user-1' }) },
)

describe('server-owned write scope', () => {
  it('updates and deletes a row that passes the server scope', async () => {
    const updated = await app.request('/scoped-write-items/update/item-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated A' }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ data: { id: 'item-a', name: 'Updated A', ownerId: 'srv-user' } })

    const deleted = await app.request('/scoped-write-items/delete/item-a', { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
  })

  it('hides an out-of-scope row from update and delete without changing it', async () => {
    const before = { ...source.rows.find((row) => row.id === 'item-b')! }
    const updateResponse = await app.request('/scoped-write-items/update/item-b?ownerId=srv-user', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Must stay hidden', ownerId: 'srv-user' }),
    })
    expect(updateResponse.status).toBe(404)
    expect(await updateResponse.json()).toEqual({ error: 'not_found' })
    expect(source.rows.find((row) => row.id === 'item-b')).toEqual(before)

    const deleteResponse = await app.request('/scoped-write-items/delete/item-b?ownerId=srv-user', { method: 'DELETE' })
    expect(deleteResponse.status).toBe(404)
    expect(await deleteResponse.json()).toEqual({ error: 'not_found' })
    expect(source.rows.find((row) => row.id === 'item-b')).toEqual(before)
  })
})
