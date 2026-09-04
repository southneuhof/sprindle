import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { defineRoute } from '../../routes'
import { defineModel } from '../../model'
import { installSprindle, requestContext, sprindleOnError, type Logger } from '..'
import type { ModelRuntimeEntity, ModelSource } from '../../source'

const source: ModelSource<{ id: string }> = {
  async list() {
    return { data: [], total: 0 }
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

function buildApp(logger?: Logger) {
  const model = defineModel({
    path: '/items',
    entity: itemEntity,
    routes: {
      ok: defineRoute({ method: 'get', action: ({ c }) => c.json({ ok: true }) }),
      broken: defineRoute({
        method: 'get',
        action: () => {
          throw new Error('boom')
        },
      }),
    },
  })

  const app = new Hono().onError(sprindleOnError).use('*', requestContext())
  return installSprindle(app, [model] as const, { logger })
}

describe('requestContext', () => {
  it('assigns a request id and echoes it on the response', async () => {
    const response = await buildApp().request('/items/ok')
    expect(response.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/)
  })

  it('honors an inbound request id', async () => {
    const response = await buildApp().request('/items/ok', { headers: { 'x-request-id': 'abc' } })
    expect(response.headers.get('x-request-id')).toBe('abc')
  })

  it('gives distinct ids to distinct requests', async () => {
    const app = buildApp()
    const first = await app.request('/items/ok')
    const second = await app.request('/items/ok')
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'))
  })

  it('logs failures with the request id the client saw', async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const response = await buildApp(logger).request('/items/broken')

    expect(response.status).toBe(500)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.error).mock.calls[0][0]).toMatchObject({
      requestId: response.headers.get('x-request-id'),
      method: 'GET',
      path: '/items/broken',
      err: 'Error: boom',
    })
  })
})
