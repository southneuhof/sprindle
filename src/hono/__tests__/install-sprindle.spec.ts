import { describe, expect, expectTypeOf, it } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { create, defineAction, detail, list, update } from '../../actions'
import { defineModel } from '../../model'
import { defineRoute } from '../../routes'
import { installSprindle, type SprindleRoutesSchema } from '..'
import type { ModelRuntimeEntity, ModelSource } from '../../source'

const source = {
  list: async () => [],
  detail: async () => null,
  create: async ({ input }) => input,
  update: async () => null,
  delete: async () => false,
  materialize: async (input) => input,
} satisfies ModelSource

const item = {
  name: 'items',
  source,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
} satisfies ModelRuntimeEntity & { schemas: Record<'create' | 'update' | 'select', z.ZodType> }

const ping = defineAction({
  method: 'get',
  handler: (args) => args.c.json({ ok: true }),
})

const model = defineModel({
  entity: item,
  actions: {
    list: list(),
    detail: detail(),
    create: create(),
    update: update(),
    nested: {
      ping: ping(),
    },
  },
})

const custom = new Hono().get('/', (c) => c.json({ ok: true }))
const routes = [defineRoute({ path: '/items', model }), defineRoute({ path: '/health', route: custom })] as const

describe('installSprindle', () => {
  it('mounts routes at runtime', async () => {
    const app = installSprindle(new Hono(), routes)
    const response = await app.request('/items/nested/ping')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('infers Hono RPC schema from route definitions', () => {
    type Schema = SprindleRoutesSchema<typeof routes>

    expectTypeOf<Schema['/items/list']['$get']['input']>().toEqualTypeOf<{ query: { page?: string; limit?: string; search?: string } }>()
    expectTypeOf<Schema['/items/detail/:id']['$get']['input']>().toEqualTypeOf<{ param: { id: string } }>()
    expectTypeOf<Schema['/items/create']['$post']['input']>().toEqualTypeOf<{ json: z.input<typeof item.schemas.create> }>()
    expectTypeOf<Schema['/items/update/:id']['$patch']['input']>().toEqualTypeOf<{ json: z.input<typeof item.schemas.update>; param: { id: string } }>()
    expectTypeOf<Schema['/items/nested/ping']['$get']['status']>().toEqualTypeOf<200>()
    expectTypeOf<Schema['/items/create']['$post']['status']>().toEqualTypeOf<201>()
    expectTypeOf<Schema['/health']['$get']['status']>().toMatchTypeOf<number>()
  })
})
