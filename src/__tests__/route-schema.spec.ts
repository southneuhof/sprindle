import { describe, expect, expectTypeOf, it } from 'vitest'
import { Hono } from 'hono'
import { hc, type InferRequestType } from 'hono/client'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { create, createEntity, defineModel, detail, list, update } from '../index'
import { defineRoute } from '../routes'
import type { ModelRuntimeContext } from '../source'
import type { ModelRouteInput, ModelRouteOutput } from '../model/route-types'

const items = pgTable('route_schema_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const item = createEntity({
  table: items,
  schemas: {
    create: z.object({ name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

const customRoute = defineRoute<
  { data: string },
  ModelRuntimeContext,
  'post',
  { json: { value: string } }
>({
  method: 'post',
  action: () => ({ data: 'ok' }),
})

const model = defineModel({
  path: '/items',
  entity: item,
  routes: {
    list: list(),
    detail: detail(),
    create: create(),
    custom: customRoute,
  },
})

const realCreateRoute = create()
const realNestedRoute = update()

const realModel = defineModel({
  path: '/real-items',
  entity: item,
  routes: {
    create: realCreateRoute,
    nested: { child: realNestedRoute },
  },
})

type LocalSchema = typeof model.route extends Hono<any, infer TSchema> ? TSchema : never
type LocalClient = ReturnType<typeof hc<typeof model.route>>
type CustomRequest = InferRequestType<LocalClient['custom']['$post']>
type ItemCreateInput = z.input<typeof item.schemas.create>
type ItemUpdateInput = z.input<typeof item.schemas.update>
type RealSchema = typeof realModel.route extends Hono<any, infer TSchema> ? TSchema : never
type RealClient = ReturnType<typeof hc<typeof realModel.route>>
type RealCreateRequest = InferRequestType<RealClient['create']['$post']>
type RealNestedRequest = InferRequestType<RealClient['nested']['child'][':id']['$patch']>

describe('relative model route schema', () => {
  it('keeps local paths, literal keys, and route types', () => {
    expect(model.route).toBeInstanceOf(Hono)
    expect(model.route.routes.map((route) => route.path)).toEqual(['/list', '/detail/:id', '/create', '/custom'])

    expectTypeOf<'/list' extends keyof LocalSchema ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<'/items/list' extends keyof LocalSchema ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<string extends keyof LocalSchema ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<ModelRouteInput<typeof customRoute>>().toEqualTypeOf<{ json: { value: string } }>()
    expectTypeOf<ModelRouteOutput<typeof customRoute>>().toEqualTypeOf<{ data: string }>()
    expectTypeOf<CustomRequest>().toEqualTypeOf<{ json: { value: string } }>()
    expectTypeOf<ItemCreateInput>().toEqualTypeOf<{ name: string }>()
    expectTypeOf<LocalSchema['/list']['$get']['status']>().toEqualTypeOf<200 | 400 | 401 | 403 | 500>()
    expectTypeOf<LocalSchema['/detail/:id']['$get']['status']>().toEqualTypeOf<200 | 400 | 401 | 403 | 404 | 500>()
    expectTypeOf<LocalSchema['/create']['$post']['status']>().toEqualTypeOf<201 | 400 | 401 | 403 | 409 | 422 | 500>()
  })

  it('keeps real canonical and nested route literals', () => {
    expect(realModel.route.routes.map((route) => route.path)).toEqual(['/create', '/nested/child/:id'])
    expectTypeOf<typeof realCreateRoute.method>().toEqualTypeOf<'post'>()
    expectTypeOf<typeof realCreateRoute.path>().toEqualTypeOf<''>()
    expectTypeOf<typeof realNestedRoute.method>().toEqualTypeOf<'patch'>()
    expectTypeOf<typeof realNestedRoute.path>().toEqualTypeOf<'/:id'>()
    expect('kind' in realCreateRoute).toBe(false)
    expect('kind' in realNestedRoute).toBe(false)
    expectTypeOf<string extends keyof RealSchema ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<string extends keyof RealSchema['/create'] ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<string extends keyof RealSchema['/nested/child/:id'] ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'$post' extends keyof RealSchema['/create'] ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<'$get' extends keyof RealSchema['/create'] ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'$patch' extends keyof RealSchema['/nested/child/:id'] ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<RealCreateRequest>().toEqualTypeOf<{ json: ItemCreateInput }>()
    expectTypeOf<RealNestedRequest>().toEqualTypeOf<{ param: { id: string }; json: ItemUpdateInput }>()
    expectTypeOf<RealSchema['/nested/child/:id']['$patch']['status']>().toEqualTypeOf<200 | 400 | 401 | 403 | 404 | 409 | 422 | 500>()
  })

  it('does not accept a resource contract on defineRoute', () => {
    if (false) {
      // @ts-expect-error defineRoute accepts only an HTTP contract.
      defineRoute({ kind: 'create', method: 'post', action: () => ({ data: 'nope' }) })
    }
  })

  it('exposes canonical and custom routes through Hono client accessors', () => {
    const client = hc<typeof model.route>('http://probe')
    expect(client.list.$get).toBeTypeOf('function')
    expect(client.detail[':id'].$get).toBeTypeOf('function')
    expect(client.custom.$post).toBeTypeOf('function')

    if (false) {
      // @ts-expect-error custom JSON input is required and must keep its shape.
      client.custom.$post({ json: { wrong: true } })
    }
  })
})
