import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { create, defineRoute, list } from '../../routes'
import { defineModel } from '../define-model'
import { createDrizzleModel } from '../../source'
import { getPrimaryKeyColumns } from '../../source/drizzle-source'
import type { RouteTree } from '../route-tree'
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
  if (false) {
    const uncalledRoute = defineRoute({
      method: 'get',
      action: ({ c }) => c.json({ ok: true }),
    })

    // @ts-expect-error route factories must be called before registration
    const tree: RouteTree = { uncalledRoute }
    void tree
  }

  it('compiles route tree keys into route segments', async () => {
    const model = defineModel({
      entity: itemEntity,
      routes: {
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

  it('runs model and route phases in declaration order', async () => {
    const order: string[] = []
    const model = defineModel({
      entity: itemEntity,
      before: [() => void order.push('model.before')],
      authorize: [() => void order.push('model.authorize')],
      validate: [() => void order.push('model.validate')],
      after: [() => void order.push('model.after')],
      routes: {
        ping: defineRoute({
          method: 'get',
          before: [
            ({ state }) => {
              order.push('route.before')
              return { value: `${state.value}-patched` }
            },
          ],
          authorize: [() => void order.push('route.authorize')],
          validate: [() => void order.push('route.validate')],
          after: [() => void order.push('route.after')],
          state: () => ({ value: 'state' }),
          action: ({ c, state }) => {
            order.push(`handler.${state.value}`)
            return c.json({ ok: true })
          },
        })(),
      },
    })
    const app = new Hono().route('/', model.route)

    expect((await app.request('/ping')).status).toBe(200)
    expect(order).toEqual([
      'model.before',
      'route.before',
      'model.authorize',
      'route.authorize',
      'model.validate',
      'route.validate',
      'handler.state-patched',
      'route.after',
      'model.after',
    ])
  })

  it('keeps route phases local to their route', async () => {
    const order: string[] = []
    const model = defineModel({
      entity: itemEntity,
      before: [({ route }) => void order.push(`model.${route.kind}`)],
      routes: {
        first: defineRoute({
          method: 'get',
          kind: 'custom',
          before: [() => void order.push('first.before')],
          action: ({ c }) => c.json({ ok: true }),
        })(),
        second: defineRoute({
          method: 'get',
          kind: 'custom',
          action: ({ c }) => c.json({ ok: true }),
        })(),
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
      routes: {
        locked: defineRoute({
          method: 'get',
          authorize: [
            () => {
              order.push('authorize')
              return 'no access'
            },
          ],
          validate: [() => void order.push('validate')],
          after: [() => void order.push('after')],
          action: ({ c }) => {
            order.push('handler')
            return c.json({ ok: true })
          },
        })(),
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
      routes: {
        invalid: defineRoute({
          method: 'get',
          validate: [() => ({ field: 'name', message: 'Name is required.' })],
          action: ({ c }) => c.json({ ok: true }),
        })(),
      },
    })
    const app = new Hono().route('/', model.route)
    const response = await app.request('/invalid')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'validation_error', issues: [{ field: 'name', message: 'Name is required.' }] })
  })

  it('maps thrown errors through route and model error phases', async () => {
    const model = defineModel({
      entity: itemEntity,
      error: [({ c }) => c.json({ error: 'model' }, 500)],
      routes: {
        fails: defineRoute({
          method: 'get',
          error: [({ c, error }) => (error instanceof Error && error.message === 'known' ? c.json({ error: 'known' }, 409) : undefined)],
          action: () => {
            throw new Error('known')
          },
        })(),
        fallsBack: defineRoute({
          method: 'get',
          action: () => {
            throw new Error('unknown')
          },
        })(),
      },
    })
    const app = new Hono().route('/', model.route)

    const routeMapped = await app.request('/fails')
    expect(routeMapped.status).toBe(409)
    expect(await routeMapped.json()).toEqual({ error: 'known' })

    const modelMapped = await app.request('/fallsBack')
    expect(modelMapped.status).toBe(500)
    expect(await modelMapped.json()).toEqual({ error: 'model' })
  })

  it('accepts declarative hooks on first-class route factories', async () => {
    const model = defineModel({
      entity: itemEntity,
      routes: {
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

  it('accepts forwarded hooks on custom route factories', async () => {
    const custom = defineRoute({
      method: 'get',
      before: [({ state }) => ({ value: `${state.value}-base` })],
      state: () => ({ value: 'state' }),
      action: ({ c, state }) => c.json({ value: state.value }),
    })
    const model = defineModel({
      entity: itemEntity,
      routes: {
        custom: custom({
          before: [({ state }) => ({ value: `${state.value}-call` })],
          validate: [({ state }) => (state.value === 'state-base-call' ? undefined : 'wrong order')],
        }),
      },
    })
    const app = new Hono().route('/', model.route)
    const response = await app.request('/custom')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ value: 'state-base-call' })
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
