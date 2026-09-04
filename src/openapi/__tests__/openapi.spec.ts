import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { create, defineRoute, deleteRoute, detail, list, update } from '../../routes'
import { defineModel } from '../../model'
import { createTestEntity, testApp } from '../../testing'
import { generateOpenApi, openapiRoute } from '..'
import type { ModelRuntimeEntity } from '../../source'

const item = {
  ...createTestEntity(),
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
} as unknown as ModelRuntimeEntity

const ping = defineRoute({ method: 'get', action: ({ c }) => c.json({ ok: true }) })

const model = defineModel({
  path: '/items',
  entity: item,
  routes: {
    list: list(),
    detail: detail(),
    create: create(),
    update: update(),
    delete: deleteRoute(),
    nested: { ping },
  },
})

const health = defineRoute({ path: '/health', method: 'get', action: ({ c }) => c.json({ ok: true }) })
const customWrite = defineRoute({ path: '/custom', method: 'post', openapi: { requestBody: z.object({ file: z.object({ id: z.string() }) }) }, action: ({ c }) => c.json({ ok: true }) })
const installables = [model, health, customWrite] as const
const info = { title: 'Test API', version: '0.0.0' }

describe('generateOpenApi', () => {
  it('rejects a top-level resource route', () => {
    expect(() => generateOpenApi([deleteRoute()] as never, info)).toThrow('Canonical resource routes must be mounted inside defineModel().')
  })

  it('emits every canonical route with OpenAPI path syntax', () => {
    const document = generateOpenApi(installables, info)

    expect(document.openapi).toBe('3.1.0')
    expect(Object.keys(document.paths).sort()).toEqual(
      ['/custom', '/health', '/items/create', '/items/delete/{id}', '/items/detail/{id}', '/items/list', '/items/nested/ping', '/items/update/{id}'].sort(),
    )
    expect(document.paths['/items/update/{id}'].patch).toBeDefined()
    expect(document.paths['/items/delete/{id}'].delete).toBeDefined()
  })

  it('declares the reserved list query parameters and the free-form filter note', () => {
    const listOperation = generateOpenApi(installables, info).paths['/items/list'].get as {
      parameters: { name: string; in: string }[]
      description: string
    }

    expect(listOperation.parameters.filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name)).toEqual([
      'page',
      'limit',
      'search',
      'sort',
      'order',
    ])
    expect(listOperation.description).toContain('equal column value')
  })

  it('references entity component schemas for bodies and payloads', () => {
    const document = generateOpenApi(installables, info)

    expect(Object.keys(document.components.schemas).sort()).toEqual(['Items', 'ItemsCreate', 'ItemsUpdate'])
    expect(document.paths['/items/create'].post).toMatchObject({
      requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemsCreate' } } } },
      responses: { '201': { content: { 'application/json': { schema: { properties: { data: { $ref: '#/components/schemas/Items' } } } } } } },
    })
  })

  it('documents a custom JSON request schema', () => {
    expect(generateOpenApi(installables, info).paths['/custom'].post).toMatchObject({
      requestBody: { content: { 'application/json': { schema: { properties: { file: { properties: { id: { type: 'string' } } } }, required: ['file'] } } } },
    })
  })

  it('documents the exact response statuses for every route contract', () => {
    const document = generateOpenApi(installables, info)
    const statuses = (path: string, method: string) => Object.keys((document.paths[path][method] as { responses: Record<string, unknown> }).responses).sort()

    expect(statuses('/items/list', 'get')).toEqual(['200', '400', '401', '403', '500'])
    expect(statuses('/items/detail/{id}', 'get')).toEqual(['200', '400', '401', '403', '404', '500'])
    expect(statuses('/items/create', 'post')).toEqual(['201', '400', '401', '403', '409', '422', '500'])
    expect(statuses('/items/update/{id}', 'patch')).toEqual(['200', '400', '401', '403', '404', '409', '422', '500'])
    expect(statuses('/items/delete/{id}', 'delete')).toEqual(['200', '400', '401', '403', '404', '500'])
    expect(statuses('/health', 'get')).toEqual(['200', '400', '401', '403', '500'])

    const detailOperation = document.paths['/items/detail/{id}'].get as { responses: Record<string, unknown> }
    expect(detailOperation.responses['404']).toMatchObject({ content: { 'application/json': { schema: { required: ['error'] } } } })
  })

  it('emits only paths the router actually serves', async () => {
    const app = testApp(installables)
    const served = new Set(app.routes.map((route) => route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')))

    for (const path of Object.keys(generateOpenApi(installables, info).paths)) {
      expect(served.has(path)).toBe(true)
    }
  })
})

describe('openapiRoute', () => {
  it('serves the document', async () => {
    const routes = [...installables, openapiRoute(installables, info)] as const
    const response = await testApp(routes).request('/openapi.json')

    expect(response.status).toBe(200)
    expect((await response.json()).openapi).toBe('3.1.0')
  })
})
