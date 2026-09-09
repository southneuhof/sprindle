import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { installSprindle, type FileRouteManifestEntry } from '..'
import { create, defineRoute, defineScope, deleteRoute, detail, list, update } from '../../routes'
import { createTestEntity } from '../../testing'

const entry = (httpPath: string, handlers: Record<string, unknown>, scopes: unknown[] = [], parameters: string[] = []): FileRouteManifestEntry => ({ sourcePath: `${httpPath}/+server.ts`, httpPath, handlers, scopes, parameters, methods: Object.keys(handlers) })

describe('installSprindle file manifest', () => {
  const entity = createTestEntity({ schemas: { create: z.object({ id: z.string(), name: z.string() }), update: z.object({ name: z.string().optional() }), select: z.object({ id: z.string(), name: z.string() }) } })
  const scope = defineScope({ entity })
  const manifest = [entry('/items/list', { GET: list() }, [scope]), entry('/items/detail/:id', { GET: detail() }, [scope], ['id']), entry('/items/create', { POST: create() }, [scope]), entry('/items/update/:id', { PATCH: update() }, [scope], ['id']), entry('/health', { GET: defineRoute({ action: () => ({ ok: true }) }) })] as const

  it('installs resource and custom routes', async () => {
    const app = installSprindle(new Hono(), manifest)
    expect(await (await app.request('/health')).json()).toEqual({ ok: true })
    expect((await app.request('/items/list')).status).toBe(200)
  })

  it('rejects a resource route without an entity scope', () => {
    expect(() => installSprindle(new Hono(), [entry('/delete/:id', { DELETE: deleteRoute() }, [], ['id'])])).toThrow('needs an entity scope')
  })

  it('rejects malformed scopes for custom routes', () => {
    expect(() => installSprindle(new Hono(), [entry('/health', { GET: defineRoute({ action: () => ({}) }) }, [{}])])).toThrow('invalid scope definition')
  })
})
