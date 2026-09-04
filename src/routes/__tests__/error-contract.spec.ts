import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { defineRoute } from '../define-route'
import { created } from '../index'
import { defineModel } from '../../model'
import { sprindleNotFound, sprindleOnError } from '../../hono'
import { notFound, validationError } from '../../errors'
import type { ModelRuntimeEntity, ModelSource } from '../../source'

const source: ModelSource<{ id: string }> = {
  async list() {
    return { data: [{ id: 'item-1' }], total: 1 }
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

function buildApp() {
  const model = defineModel({
    path: '/items',
    entity: itemEntity,
    routes: {
      missing: defineRoute({
        method: 'get',
        action: () => {
          throw notFound('Item is gone.')
        },
      }),
      made: defineRoute({
        method: 'post',
        action: (args) => created(args.c, { id: 'item-1' }),
      }),
      invalid: defineRoute({
        method: 'get',
        action: () => {
          throw validationError([{ field: 'name', message: 'Name is required.' }])
        },
      }),
      broken: defineRoute({
        method: 'get',
        action: () => {
          throw new Error('database password is hunter2')
        },
      }),
      handled: defineRoute({
        method: 'get',
        error: [({ c }) => c.json({ error: 'handled' }, 409)],
        action: () => {
          throw notFound()
        },
      }),
    },
  })

  return new Hono().onError(sprindleOnError).notFound(sprindleNotFound).route('/', model.route)
}

describe('error contract', () => {
  it('renders the created helper as a 201 data envelope', async () => {
    const app = buildApp()
    const response = await app.request('/made', { method: 'POST' })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { id: 'item-1' } })
  })

  it('renders thrown HttpErrors through the envelope', async () => {
    const app = buildApp()

    const missing = await app.request('/missing')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found', message: 'Item is gone.' })

    const invalid = await app.request('/invalid')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'validation_error', issues: [{ field: 'name', message: 'Name is required.' }] })
  })

  it('hides non-HttpError details behind internal_error', async () => {
    const app = buildApp()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const broken = await app.request('/broken')
    expect(broken.status).toBe(500)
    const body = await broken.json()
    expect(body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(body)).not.toContain('hunter2')

    logged.mockRestore()
  })

  it('lets error hooks win over contract rendering', async () => {
    const handled = await buildApp().request('/handled')
    expect(handled.status).toBe(409)
    expect(await handled.json()).toEqual({ error: 'handled' })
  })

  it('answers unmatched routes with the not_found envelope', async () => {
    const unmatched = await buildApp().request('/nothing-here')
    expect(unmatched.status).toBe(404)
    expect(await unmatched.json()).toEqual({ error: 'not_found' })
  })
})
