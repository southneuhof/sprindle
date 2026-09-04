// Server-owned write values: a model-level `before` hook stamps audit columns through
// `state.values`; the canonical create factory forwards them and they win over forged client keys.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { authenticated, create } from '../routes'
import { installSprindle, requestContext, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'

const audited = pgTable('audited', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdByUserId: text('created_by_user_id'),
})

const auditedEntity = createEntity({
  table: audited,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string(), createdByUserId: z.string().nullable() }),
  },
})

const source = createMemorySource<{ id: string; name: string; createdByUserId?: string | null }>()

auditedEntity.source = source as never

const app = installSprindle(
  new Hono().onError(sprindleOnError).use('*', requestContext()),
  [
    defineModel({
      path: '/audited',
      entity: auditedEntity,
      authorize: [authenticated()],
      before: [() => ({ values: { createdByUserId: 'srv' } })],
      routes: { create: create() },
    }),
  ] as const,
  { identity: () => ({ id: 'user-1' }) },
)

describe('server-owned write values', () => {
  it('stamps values over a forged client key on create', async () => {
    const response = await app.request('/audited/create', {
      method: 'post',
      body: JSON.stringify({ id: 'a-1', name: 'Wrench', createdByUserId: 'forger' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { id: 'a-1', name: 'Wrench', createdByUserId: 'srv' } })
    expect(source.rows[0]).toEqual({ id: 'a-1', name: 'Wrench', createdByUserId: 'srv' })
  })
})
