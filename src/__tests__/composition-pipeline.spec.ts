import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { createEntity, defineModel, defineModule } from '../model'
import type { DomainEntity } from '../model'
import { create, defineRoute, list } from '../routes'
import { forbidden } from '../errors'
import { installSprindle } from '../hono'
import { createMemorySource } from '../testing'

type Expect<T extends true> = T
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false

// Install attaches merged pipelines onto the model's live context, so one
// model instance belongs to exactly one installation. Fresh models per case.
function makeEntity(): DomainEntity & { memoryRows: Array<Record<string, unknown>> } {
  const entity = createEntity({
    table: { name: 'items' },
    schemas: {
      select: z.object({ id: z.string(), name: z.string(), tag: z.string().nullable().optional() }),
      create: z.object({ id: z.string(), name: z.string() }),
      update: z.object({ name: z.string().optional() }),
    },
  }) as unknown as DomainEntity
  const source = createMemorySource<Record<string, unknown>>()
  entity.source = source as never
  return Object.assign(entity, { memoryRows: source.rows })
}

function makeModel(entity: DomainEntity, order: string[]) {
  const record = (label: string) => () => {
    order.push(label)
  }
  return defineModel({
    path: '/items',
    entity,
    before: [record('model-before')],
    authorize: [record('model-authorize')],
    after: [record('model-after')],
    error: [record('model-error')],
    routes: {
      list: list(),
      store: create(),
      // A route-tree key appends to the route's own path; empty path keeps /items/boom.
      boom: defineRoute({
        method: 'get',
        path: '',
        before: [record('route-before')],
        authorize: [record('route-authorize')],
        after: [record('route-after')],
        error: [record('route-error')],
        action: () => {
          throw forbidden('boom')
        },
      }),
    },
  })
}

describe('composition pipeline', () => {
  it('runs before hooks outermost-first and after/error hooks outermost-last', async () => {
    const order: string[] = []
    const bundles = [
      defineModule({
        pipeline: {
          before: [() => void order.push('bundle-before')],
          authorize: [() => void order.push('bundle-authorize')],
          after: [() => void order.push('bundle-after')],
          error: [() => void order.push('bundle-error')],
        },
        models: [makeModel(makeEntity(), order)],
      }),
    ] as const
    const app = installSprindle(new Hono(), bundles, {
      pipeline: {
        before: [() => void order.push('install-before')],
        authorize: [() => void order.push('install-authorize')],
        after: [() => void order.push('install-after')],
        error: [() => void order.push('install-error')],
      },
    })

    const response = await app.request('/items/boom')
    expect(response.status).toBe(403)
    expect(order).toEqual([
      'install-authorize',
      'bundle-authorize',
      'model-authorize',
      'route-authorize',
      'install-before',
      'bundle-before',
      'model-before',
      'route-before',
      'route-error',
      'model-error',
      'bundle-error',
      'install-error',
    ])
  })

  it('lets install-scope authorize short-circuit every inner scope', async () => {
    const order: string[] = []
    const bundles = [defineModule({ models: [makeModel(makeEntity(), order)] })] as const
    const app = installSprindle(new Hono(), bundles, {
      pipeline: { before: [() => void order.push('install-before')], authorize: [() => 'install says no'] },
    })

    const response = await app.request('/items/list')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden', issues: [{ message: 'install says no' }] })
    // Authorization blocks state creation, before hooks, validation, action,
    // and after hooks at every inner scope.
    expect(order).toEqual([])
  })

  it('inherits install-scope state patches on canonical writes (values bag)', async () => {
    const entity = makeEntity()
    const bundles = [defineModule({ models: [makeModel(entity, [])] })] as const
    const app = installSprindle(new Hono(), bundles, {
      pipeline: { before: [() => ({ values: { tag: 'injected' } })] },
    })

    const response = await app.request('/items/store', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a-1', name: 'First' }),
    })
    expect(response.status).toBe(201)
    expect(entity.memoryRows[0]).toMatchObject({ id: 'a-1', name: 'First', tag: 'injected' })
  })

  it('keeps client types identical to the flat installation', () => {
    const bundles = [defineModule({ models: [makeModel(makeEntity(), [])] })] as const
    const bundled = installSprindle(new Hono(), bundles, {})
    const flat = installSprindle(new Hono(), [[...bundles[0].models][0]] as const, {})
    type _parity = Expect<Equal<typeof bundled, typeof flat>>
    expect(bundled.request).toBeTypeOf('function')
  })
})
