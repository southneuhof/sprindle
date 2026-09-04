import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '../model'
import { create, detail, update } from '../routes'
import { installSprindle, requestContext, sprindleOnError } from '../hono'
import { createMemorySource } from '../testing'

const records = pgTable('record_enrich_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const entity = createEntity({
  table: records,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

const source = createMemorySource<{ id: string; name: string }>({ rows: [{ id: 'item-1', name: 'Original' }] })
entity.source = source as never

const detailEnrich = vi.fn((record: unknown, args: { state: { id: string } }) => {
  expect(record).toEqual({ id: 'item-1', name: 'Original' })
  expect(args.state.id).toBe('item-1')
  return undefined
})
const createEnrich = vi.fn((record: unknown, args: { state: { input: Record<string, unknown> } }) => {
  expect(record).toMatchObject({ id: 'item-2', name: 'Created' })
  expect(args.state.input).toEqual({ id: 'item-2', name: 'Created' })
  return { ...(record as object), enriched: 'create' }
})
const updateEnrich = vi.fn((record: unknown, args: { state: { id: string; input: Record<string, unknown> } }) => {
  expect(record).toMatchObject({ id: 'item-1', name: 'Updated' })
  expect(args.state.id).toBe('item-1')
  expect(args.state.input).toEqual({ name: 'Updated' })
  return { ...(record as object), enriched: 'update' }
})

const app = installSprindle(
  new Hono().onError(sprindleOnError).use('*', requestContext()),
  [defineModel({
    path: '/record-enrich-items',
    entity,
    routes: {
      detail: detail({ enrich: detailEnrich }),
      create: create({ enrich: createEnrich }),
      update: update({ enrich: updateEnrich }),
    },
  })] as const,
)

describe('record enrichment', () => {
  it('enriches detail, create, and update records at their canonical statuses', async () => {
    const detailResponse = await app.request('/record-enrich-items/detail/item-1')
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toEqual({ data: { id: 'item-1', name: 'Original' } })

    const createResponse = await app.request('/record-enrich-items/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'item-2', name: 'Created' }),
    })
    expect(createResponse.status).toBe(201)
    expect(await createResponse.json()).toEqual({ data: { id: 'item-2', name: 'Created', enriched: 'create' } })

    const updateResponse = await app.request('/record-enrich-items/update/item-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    })
    expect(updateResponse.status).toBe(200)
    expect(await updateResponse.json()).toEqual({ data: { id: 'item-1', name: 'Updated', enriched: 'update' } })
    expect(detailEnrich).toHaveBeenCalledTimes(1)
    expect(createEnrich).toHaveBeenCalledTimes(1)
    expect(updateEnrich).toHaveBeenCalledTimes(1)
  })

  it('keeps the source record for undefined and does not enrich not-found records', async () => {
    const detailCalls = detailEnrich.mock.calls.length
    const response = await app.request('/record-enrich-items/detail/missing')
    expect(response.status).toBe(404)
    expect(detailEnrich).toHaveBeenCalledTimes(detailCalls)

    const updateCalls = updateEnrich.mock.calls.length
    const updateResponse = await app.request('/record-enrich-items/update/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing' }),
    })
    expect(updateResponse.status).toBe(404)
    expect(updateEnrich).toHaveBeenCalledTimes(updateCalls)
  })
})
