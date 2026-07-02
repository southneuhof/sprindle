import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { list } from '../../actions'
import { defineModel } from '../define-model'
import { createDrizzleModel } from '../../source'
import { getPrimaryKeyColumns } from '../../source/drizzle-source'
import type { ModelRuntimeEntity, ModelSource } from '../../source'

const source: ModelSource<{ id: string }> = {
  async list() {
    return [{ id: 'item-1' }]
  },
  async detail() {
    return null
  },
  async create() {
    return { id: 'item-1' }
  },
  async update() {
    return null
  },
  async delete() {
    return false
  },
}
const itemEntity = { name: 'items', source } as ModelRuntimeEntity

describe('defineModel route compiler', () => {
  it('compiles action tree keys into route segments', async () => {
    const model = defineModel({
      entity: itemEntity,
      actions: {
        list: list(),
        nested: {
          version1: list(),
          test: {
            versionTest: list(),
          },
        },
      },
    })
    const app = new Hono().route('/', model.route)

    expect((await app.request('/list')).status).toBe(200)
    expect((await app.request('/nested/version1')).status).toBe(200)
    expect((await app.request('/nested/test/versionTest')).status).toBe(200)
  })

  it('uses the drizzle table name as the model name', () => {
    const table = pgTable('products', { id: text('id').primaryKey() })
    const model = createDrizzleModel({
      db: {},
      table,
      schemas: { create: { parse: (input) => input }, update: { parse: (input) => input }, select: { parse: (input) => input } },
    })

    expect(model.name).toBe('products')
  })

  it('infers inline and composite primary keys from drizzle tables', () => {
    const single = pgTable('single_key', { id: text('id').primaryKey() })
    const composite = pgTable('composite_key', { one: text('one'), two: text('two') }, (table) => [
      primaryKey({ columns: [table.one, table.two] }),
    ])

    expect(getPrimaryKeyColumns(single).map((column) => column.name)).toEqual(['id'])
    expect(getPrimaryKeyColumns(composite).map((column) => column.name)).toEqual(['one', 'two'])
  })
})
