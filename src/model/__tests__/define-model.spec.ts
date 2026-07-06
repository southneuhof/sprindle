import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { create, defineAction, list } from '../../actions'
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
  async materialize(input) {
    return input as { id: string }
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

  it('runs model and action phases in declaration order', async () => {
    const order: string[] = []
    const model = defineModel({
      entity: itemEntity,
      before: [() => void order.push('model.before')],
      authorize: [() => void order.push('model.authorize')],
      validate: [() => void order.push('model.validate')],
      after: [() => void order.push('model.after')],
      actions: {
        ping: defineAction({
          method: 'get',
          before: [
            ({ state }) => {
              order.push('action.before')
              return { value: `${state.value}-patched` }
            },
          ],
          authorize: [() => void order.push('action.authorize')],
          validate: [() => void order.push('action.validate')],
          after: [() => void order.push('action.after')],
          state: () => ({ value: 'state' }),
          handler: ({ c, state }) => {
            order.push(`handler.${state.value}`)
            return c.json({ ok: true })
          },
        }),
      },
    })
    const app = new Hono().route('/', model.route)

    expect((await app.request('/ping')).status).toBe(200)
    expect(order).toEqual([
      'model.before',
      'action.before',
      'model.authorize',
      'action.authorize',
      'model.validate',
      'action.validate',
      'handler.state-patched',
      'action.after',
      'model.after',
    ])
  })

  it('keeps action phases local to their action', async () => {
    const order: string[] = []
    const model = defineModel({
      entity: itemEntity,
      before: [({ action }) => void order.push(`model.${action.kind}`)],
      actions: {
        first: defineAction({
          method: 'get',
          kind: 'custom',
          before: [() => void order.push('first.before')],
          handler: ({ c }) => c.json({ ok: true }),
        }),
        second: defineAction({
          method: 'get',
          kind: 'custom',
          handler: ({ c }) => c.json({ ok: true }),
        }),
      },
    })
    const app = new Hono().route('/', model.route)

    expect((await app.request('/first')).status).toBe(200)
    expect((await app.request('/second')).status).toBe(200)
    expect(order).toEqual(['model.custom', 'first.before', 'model.custom'])
  })

  it('skips validation, handler, and after when authorize fails', async () => {
    const order: string[] = []
    const model = defineModel({
      entity: itemEntity,
      actions: {
        locked: defineAction({
          method: 'get',
          authorize: [
            () => {
              order.push('authorize')
              return 'no access'
            },
          ],
          validate: [() => void order.push('validate')],
          after: [() => void order.push('after')],
          handler: ({ c }) => {
            order.push('handler')
            return c.json({ ok: true })
          },
        }),
      },
    })
    const app = new Hono().route('/', model.route)
    const response = await app.request('/locked')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden', issues: [{ message: 'no access' }] })
    expect(order).toEqual(['authorize'])
  })

  it('returns validation errors as bad requests', async () => {
    const model = defineModel({
      entity: itemEntity,
      actions: {
        invalid: defineAction({
          method: 'get',
          validate: [() => ({ field: 'name', message: 'Name is required.' })],
          handler: ({ c }) => c.json({ ok: true }),
        }),
      },
    })
    const app = new Hono().route('/', model.route)
    const response = await app.request('/invalid')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'validation_error', issues: [{ field: 'name', message: 'Name is required.' }] })
  })

  it('maps thrown errors through action and model error phases', async () => {
    const model = defineModel({
      entity: itemEntity,
      error: [({ c }) => c.json({ error: 'model' }, 500)],
      actions: {
        fails: defineAction({
          method: 'get',
          error: [({ c, error }) => (error instanceof Error && error.message === 'known' ? c.json({ error: 'known' }, 409) : undefined)],
          handler: () => {
            throw new Error('known')
          },
        }),
        fallsBack: defineAction({
          method: 'get',
          handler: () => {
            throw new Error('unknown')
          },
        }),
      },
    })
    const app = new Hono().route('/', model.route)

    const actionMapped = await app.request('/fails')
    expect(actionMapped.status).toBe(409)
    expect(await actionMapped.json()).toEqual({ error: 'known' })

    const modelMapped = await app.request('/fallsBack')
    expect(modelMapped.status).toBe(500)
    expect(await modelMapped.json()).toEqual({ error: 'model' })
  })

  it('accepts declarative hooks on first-class action factories', async () => {
    const model = defineModel({
      entity: itemEntity,
      actions: {
        create: create({
          validate: [({ state }) => (state.input && typeof state.input === 'object' && 'id' in state.input ? undefined : 'id required')],
        }),
      },
    })
    const app = new Hono().route('/', model.route)

    const invalid = await app.request('/create', { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } })
    expect(invalid.status).toBe(400)

    const valid = await app.request('/create', { method: 'POST', body: JSON.stringify({ id: 'item-2' }), headers: { 'Content-Type': 'application/json' } })
    expect(valid.status).toBe(201)
    expect(await valid.json()).toEqual({ data: { id: 'item-1' } })
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
