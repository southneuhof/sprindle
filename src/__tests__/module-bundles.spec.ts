import { defineFileModelFixture, testDefineModule, testInstallSprindle } from '../testing/file-manifest'
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineDomainPart } from '../model'
import type { DomainEntity } from '../model'
import { create, deleteRoute, detail, list, update } from '../routes'

import { createMemorySource } from '../testing'

type Expect<T extends true> = T
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false
type Not<X extends boolean> = X extends true ? false : true

const itemsTable = pgTable('items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  active: text('active'),
})
const toolsTable = pgTable('tools', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
})

function withMemorySource<T extends DomainEntity>(entity: T): T {
  entity.source = createMemorySource<Record<string, unknown>>() as never
  return entity
}

// Real Drizzle-backed entities keep literal schema types; the parity proof
// (plans/typeproof/app-type-parity.proof.ts) relies on exactly that.
const items = withMemorySource(
  createEntity({
    table: itemsTable,
    schemas: {
      select: z.object({ id: z.string(), name: z.string(), active: z.string().nullable() }),
      create: z.object({ id: z.string(), name: z.string() }),
      update: z.object({ name: z.string().optional() }),
    },
  }),
)

const tools = withMemorySource(
  createEntity({
    table: toolsTable,
    schemas: {
      select: z.object({ id: z.string(), label: z.string() }),
      create: z.object({ id: z.string(), label: z.string() }),
      update: z.object({ label: z.string().optional() }),
    },
  }),
)

const itemsModel = defineFileModelFixture({
  path: '/items',
  entity: items,
  routes: {
    list: list(),
    detail: detail(),
    create: create(),
    update: update(),
    delete: deleteRoute(),
  },
})
const toolsModel = defineFileModelFixture({
  path: '/tools',
  entity: tools,
  routes: { list: list(), detail: detail() },
})

const bundles = [
  testDefineModule({ domain: defineDomainPart({ tables: { itemsTable }, entities: [items] }), models: [itemsModel] }),
  testDefineModule({ domain: defineDomainPart({ tables: { toolsTable }, entities: [tools] }), models: [toolsModel] }),
] as const

export const appFromBundles = testInstallSprindle(new Hono(), bundles, {})
export const appLiteral = testInstallSprindle(new Hono(), [itemsModel, toolsModel] as const, {})

type SchemaOf<A> = A extends Hono<any, infer S> ? S : never
type Endpoint<A, P extends string> = P extends keyof SchemaOf<A> ? SchemaOf<A>[P] : never

describe('module bundles', () => {
  it('serves canonical routes through the bundle path', async () => {
    const response = await appFromBundles.request('/items/list')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [], page: 1, limit: 20, total: 0 })
    expect((await appFromBundles.request('/tools/list')).status).toBe(200)
    expect((await appFromBundles.request('/items/detail/nope')).status).toBe(404)
  })
})
