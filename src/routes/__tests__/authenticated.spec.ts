import { defineFileModelFixture, testDefineRoute, testInstallSprindle } from '../../testing/file-manifest'
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { authenticated } from '../authenticated'


import { sprindleNotFound, sprindleOnError } from '../../hono'
import type { IdentityResolver, ModelRuntimeEntity, ModelSource } from '../../source'

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

function buildApp(identity?: IdentityResolver) {
  const guarded = defineFileModelFixture({
    path: '/guarded',
    entity: itemEntity,
    authorize: [authenticated()],
    routes: {
      read: testDefineRoute({ method: 'get', action: async ({ c, identity: resolve }) => c.json({ identity: await resolve() }) }),
      denied: testDefineRoute({ method: 'get', authorize: [() => 'Access denied.'], action: ({ c }) => c.json({ ok: true }) }),
    },
  })

  const open = defineFileModelFixture({
    path: '/open',
    entity: itemEntity,
    routes: {
      read: testDefineRoute({ method: 'get', action: ({ c }) => c.json({ ok: true }) }),
    },
  })

  const app = new Hono().onError(sprindleOnError).notFound(sprindleNotFound)
  return testInstallSprindle(app, [guarded, open] as const, { identity })
}

describe('authenticated guard', () => {
  it('rejects requests without an identity', async () => {
    const response = await buildApp().request('/guarded/read')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('authorizes before state parsing and before hooks', async () => {
    const order: string[] = []
    const guarded = defineFileModelFixture({
      path: '/guarded',
      entity: itemEntity,
      authorize: [authenticated()],
      routes: {
        payload: testDefineRoute({
          method: 'post',
          state: async ({ c }) => {
            order.push('state')
            return await c.req.json()
          },
          before: [() => void order.push('before')],
          action: ({ c }) => c.json({ ok: true }),
        }),
      },
    })
    const app = new Hono().onError(sprindleOnError).notFound(sprindleNotFound)
    testInstallSprindle(app, [guarded] as const)

    const response = await app.request('/guarded/payload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(response.status).toBe(401)
    expect(order).toEqual([])
  })

  it('passes requests with an identity and exposes it to the action', async () => {
    const response = await buildApp(() => ({ id: 'user-1' })).request('/guarded/read')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ identity: { id: 'user-1' } })
  })

  it('leaves guardless routes public and never resolves identity for them', async () => {
    const identity = vi.fn(() => ({ id: 'user-1' }))
    const response = await buildApp(identity).request('/open/read')
    expect(response.status).toBe(200)
    expect(identity).not.toHaveBeenCalled()
  })

  it('resolves identity at most once per request', async () => {
    const identity = vi.fn(() => ({ id: 'user-1' }))
    await buildApp(identity).request('/guarded/read')
    expect(identity).toHaveBeenCalledTimes(1)
  })

  it('answers 401 before a custom authorize hook can answer 403', async () => {
    const unauthenticated = await buildApp().request('/guarded/denied')
    expect(unauthenticated.status).toBe(401)

    const forbidden = await buildApp(() => ({ id: 'user-1' })).request('/guarded/denied')
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: 'forbidden', issues: [{ message: 'Access denied.' }] })
  })
})
