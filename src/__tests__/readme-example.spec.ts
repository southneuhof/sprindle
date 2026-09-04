// Keep in sync with README.md — this spec is the README example, compiled and run.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { authenticated, create, detail, list, update } from '../routes'
import { installSprindle, requestContext, sprindleNotFound, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'

export const items = pgTable('items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

export const item = createEntity({
  table: items,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

// The README binds a real database; the example runs here against the memory source.
item.source = createMemorySource<{ id: string; name: string }>() as never

export const itemModel = defineModel({
  path: '/items',
  entity: item,
  enrich: {
    schema: z.object({ id: z.string(), name: z.string(), label: z.string() }),
    run: (record) => ({ ...record, label: record.name.toUpperCase() }),
  },
  authorize: [authenticated()],
  routes: { list: list(), detail: detail(), create: create(), update: update() },
})

const resolveSession = () => ({ id: 'user-1' })

export const app = installSprindle(
  new Hono().onError(sprindleOnError).notFound(sprindleNotFound).use('*', requestContext()),
  [itemModel] as const,
  { identity: () => resolveSession() },
)

export type AppType = typeof app

describe('README example', () => {
  it('serves the canonical list route', async () => {
    const response = await app.request('/items/list')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [], page: 1, limit: 20, total: 0 })
  })
})
