import { describe, expect, expectTypeOf, it } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { create, defineRoute, deleteRoute, detail, list, update } from '../../routes'
import { defineModel } from '../../model'
import { installSprindle, type SprindleInstallSchema } from '..'
import { createTestEntity } from '../../testing'
import type { ModelRuntimeEntity } from '../../source'

const item = {
  ...createTestEntity(),
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
} satisfies ModelRuntimeEntity & { schemas: Record<'create' | 'update' | 'select', z.ZodType> }

const ping = defineRoute({
  method: 'get',
  action: (args) => args.c.json({ ok: true }),
})

const model = defineModel({
  path: '/items',
  entity: item,
  routes: {
    list: list(),
    detail: detail(),
    create: create(),
    update: update(),
    nested: {
      ping,
    },
  },
})

const health = defineRoute({
  path: '/health',
  method: 'get',
  action: () => ({ ok: true }),
})
const routes = [model, health] as const
const unboundResource = deleteRoute()

describe('installSprindle', () => {
  it('installs routes at runtime', async () => {
    const app = installSprindle(new Hono(), routes)
    const response = await app.request('/items/nested/ping')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    const healthResponse = await app.request('/health')
    expect(healthResponse.status).toBe(200)
    expect(await healthResponse.json()).toEqual({ ok: true })
  })

  it('infers Hono RPC schema from route definitions', () => {
    type Schema = SprindleInstallSchema<typeof routes>

    expectTypeOf<typeof routes[1]['path']>().toEqualTypeOf<'/health'>()
    expectTypeOf<typeof routes[0]['path']>().toEqualTypeOf<'/items'>()
    expectTypeOf<Schema['/items/list']['$get']['input']['query']>().toMatchTypeOf<{ page?: string; limit?: string; search?: string; sort?: string; order?: string }>()
    expectTypeOf<Schema['/items/list']['$get']['input']['query']['status']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Schema['/items/detail/:id']['$get']['input']>().toEqualTypeOf<{ param: { id: string } }>()
    expectTypeOf<Schema['/items/create']['$post']['input']>().toEqualTypeOf<{ json: z.input<typeof item.schemas.create> }>()
    expectTypeOf<Schema['/items/update/:id']['$patch']['input']>().toEqualTypeOf<{ json: z.input<typeof item.schemas.update>; param: { id: string } }>()
    expectTypeOf<Schema['/items/nested/ping']['$get']['status']>().toMatchTypeOf<number>()
    expectTypeOf<Schema['/items/create']['$post']['status']>().toEqualTypeOf<201 | 400 | 401 | 403 | 409 | 422 | 500>()
    type ListSuccess = Extract<Schema['/items/list']['$get'], { status: 200 }>['output']
    type DetailSuccess = Extract<Schema['/items/detail/:id']['$get'], { status: 200 }>['output']
    expectTypeOf<ListSuccess>().toEqualTypeOf<{ data: z.output<typeof item.schemas.select>[]; page: number; limit: number; total: number }>()
    expectTypeOf<DetailSuccess>().toEqualTypeOf<{ data: z.output<typeof item.schemas.select> }>()
    expectTypeOf<Schema['/health']['$get']['status']>().toEqualTypeOf<200>()
  })

  it('does not accept a resource route at the install boundary', () => {
    if (false) {
      // @ts-expect-error Canonical resource routes need a model entity.
      installSprindle(new Hono(), [unboundResource] as const)
    }
  })

  it('rejects a bypassed top-level resource route at boot', () => {
    expect(() => installSprindle(new Hono(), [unboundResource] as never)).toThrow(
      'Canonical resource routes must be mounted inside defineModel().',
    )
  })
})
