import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { generateOpenApi } from '..'
import { create, defineRoute, defineScope, deleteRoute, detail, list, update } from '../../routes'
import { createTestEntity } from '../../testing'
import type { FileRouteManifestEntry } from '../../hono'

const entry = (httpPath: string, handlers: Record<string, unknown>, scopes: unknown[] = [], parameters: string[] = []): FileRouteManifestEntry => ({ sourcePath: `${httpPath}/+server.ts`, httpPath, handlers, scopes, parameters, methods: Object.keys(handlers) })
const entity = createTestEntity({ name: 'items', schemas: { create: z.object({ name: z.string() }), update: z.object({ name: z.string().optional() }), select: z.object({ id: z.string(), name: z.string() }) } })
const scope = defineScope({ entity })
const custom = defineRoute({ openapi: { requestBody: z.object({ file: z.object({ id: z.string() }) }) }, action: () => ({ ok: true }) })
const manifest = [
  entry('/items/list', { GET: list() }, [scope]), entry('/items/detail/:id', { GET: detail() }, [scope], ['id']),
  entry('/items/create', { POST: create() }, [scope]), entry('/items/update/:id', { PATCH: update() }, [scope], ['id']),
  entry('/items/delete/:id', { DELETE: deleteRoute() }, [scope], ['id']), entry('/custom', { POST: custom }),
]
const document = generateOpenApi(manifest, { title: 'Test', version: '1' })
const operation = (path: string, method: string) => document.paths[path][method] as Record<string, unknown>

describe('file route OpenAPI', () => {
  it('emits every path with OpenAPI parameter syntax', () => expect(Object.keys(document.paths).sort()).toEqual(['/custom','/items/create','/items/delete/{id}','/items/detail/{id}','/items/list','/items/update/{id}']))
  it('declares list query and path parameters', () => {
    const listParameters = operation('/items/list', 'get').parameters as { name: string }[]
    expect(listParameters.map((value) => value.name)).toEqual(['page','limit','search','sort','order'])
    expect((operation('/items/detail/{id}', 'get').parameters as { name: string }[])[0]).toMatchObject({ name: 'id', in: 'path', required: true })
  })
  it('uses entity schemas and custom request bodies', () => {
    expect(Object.keys(document.components.schemas).sort()).toEqual(['Items','ItemsCreate','ItemsUpdate'])
    expect(operation('/items/create', 'post').requestBody).toBeDefined()
    expect(operation('/custom', 'post').requestBody).toBeDefined()
  })
  it('documents canonical response statuses', () => {
    const statuses = (path: string, method: string) => Object.keys((document.paths[path][method] as { responses: object }).responses).sort()
    expect(statuses('/items/create','post')).toEqual(['201','400','401','403','409','422','500'])
    expect(statuses('/items/detail/{id}','get')).toContain('404')
    expect(statuses('/items/list','get')).toEqual(['200','400','401','403','500'])
  })

  it('uses the effective descendant enrichment without overwriting sibling schemas', () => {
    const red = defineScope({ enrich: { schema: z.object({ red: z.literal(true) }), run: () => ({ red: true as const }) } })
    const blue = defineScope({ enrich: { schema: z.object({ blue: z.literal(true) }), run: () => ({ blue: true as const }) } })
    const other = createTestEntity({ name: 'other', schemas: { select: z.object({ id: z.string(), other: z.boolean() }) } })
    const replaced = defineScope({ entity: other })
    const result = generateOpenApi([
      entry('/red', { GET: list() }, [scope, red]),
      entry('/blue', { GET: list() }, [scope, blue]),
      entry('/other', { GET: list() }, [scope, red, replaced]),
    ], { title: 'Shapes', version: '1' })
    expect(result.components.schemas.Items).toMatchObject({ properties: { red: { const: true } } })
    expect(result.components.schemas.ItemsPublic2).toMatchObject({ properties: { blue: { const: true } } })
    expect(result.components.schemas.Other).toMatchObject({ properties: { other: { type: 'boolean' } } })
    const reference = (path: string) => {
      const response = (result.paths[path].get as { responses: Record<string, { content: { 'application/json': { schema: { properties: { data: { items: { $ref: string } } } } } } }> }).responses['200']
      return response.content['application/json'].schema.properties.data.items.$ref
    }
    expect(reference('/red')).toBe('#/components/schemas/Items')
    expect(reference('/blue')).toBe('#/components/schemas/ItemsPublic2')
    expect(reference('/other')).toBe('#/components/schemas/Other')
  })
})
