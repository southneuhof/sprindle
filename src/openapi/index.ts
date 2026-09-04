import { z } from 'zod/v4'
import { defineRoute } from '../routes'
import { isModelRoute } from '../model/route-types'
import { isResourceRoute, RESOURCE_STATUS, resourceOperation, type ResourceOperation } from '../model/resource-route'
import { iterRoutes } from '../model/route-tree'
import type { ModelRoute } from '../model/route-types'
import type { DefinedModel } from '../model'
import type { SprindleInstallable } from '../hono'

export type OpenApiInfo = { title: string; version: string }
export type OpenApiDocument = {
  openapi: '3.1.0'
  info: OpenApiInfo
  paths: Record<string, Record<string, unknown>>
  components: { schemas: Record<string, unknown> }
}

type EntitySchemas = { create?: unknown; update?: unknown; select?: unknown }

const RESERVED_LIST_QUERY_PARAMETERS = [
  { name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'search', schema: { type: 'string' } },
  { name: 'sort', schema: { type: 'string' } },
  { name: 'order', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
]

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    issues: {
      type: 'array',
      items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } }, required: ['message'] },
    },
  },
  required: ['error'],
}

/** Builds an OpenAPI 3.1 document from the same models `installSprindle` mounts. */
export function generateOpenApi(installables: readonly SprindleInstallable[], info: OpenApiInfo): OpenApiDocument {
  const document: OpenApiDocument = { openapi: '3.1.0', info, paths: {}, components: { schemas: {} } }

  const handleModel = (model: DefinedModel) => {
    const entity = model.context?.entity as ({ name?: string } & { schemas?: EntitySchemas }) | undefined
    const entityName = componentName(model.name || model.path)
    registerEntitySchemas(document, entityName, entity?.schemas, model.context?.enrich)
    walkRouteTree(document, model.routes as Record<string, unknown>, [], model.path, entityName)
  }

  const handle = (installable: SprindleInstallable) => {
    if (isModelRoute(installable)) {
      if (isResourceRoute(installable)) throw new Error('Canonical resource routes must be mounted inside defineModel().')
      addOperation(document, installable.path, installable, undefined)
      return
    }
    if ('models' in installable) {
      for (const nested of installable.models) handle(nested)
      return
    }
    if ('route' in installable) handleModel(installable)
  }

  for (const installable of installables) handle(installable)

  return document
}

/** A `GET` route serving the generated document; mount it like any other top-level route. */
export function openapiRoute<const TPath extends string = '/openapi.json'>(
  installables: readonly SprindleInstallable[],
  info: OpenApiInfo,
  path: TPath = '/openapi.json' as TPath,
) {
  return defineRoute({
    path,
    method: 'get',
    // Public by default; attach `authenticated()` in the app if the document is not public.
    action: ({ c }) => c.json(generateOpenApi(installables, info)),
  })
}

function walkRouteTree(
  document: OpenApiDocument,
  tree: Record<string, unknown>,
  segments: string[],
  prefix: string,
  entityName: string | undefined,
) {
  for (const { route, keyPath } of iterRoutes(tree as never)) {
    addOperation(document, `${joinPath(prefix, `/${keyPath.join('/')}`)}${route.path}`, route, entityName)
  }
}

function addOperation(document: OpenApiDocument, rawPath: string, route: ModelRoute, entityName: string | undefined) {
  const path = normalizePath(rawPath)
  const contract = resourceOperation(route)
  const errorStatuses = contract ? RESOURCE_STATUS[contract].errors : [400, 401, 403, 500]
  const operation: Record<string, unknown> = {
    responses: {
      ...successResponse(contract, entityName),
      ...Object.fromEntries(errorStatuses.map((status) => [status, jsonResponse('Error', ERROR_SCHEMA)])),
    },
  }

  const parameters = [
    ...pathParameters(path),
    ...(contract === 'list' ? RESERVED_LIST_QUERY_PARAMETERS.map((parameter) => ({ ...parameter, in: 'query', required: false })) : []),
  ]
  if (parameters.length) operation.parameters = parameters
  if (contract === 'list') operation.description = 'Any query parameter beyond the reserved ones filters on an equal column value.'
  if (!contract) operation.description = 'Response shape not declared.'

  if (entityName && (contract === 'create' || contract === 'update')) {
    const schemaName = `${entityName}${contract === 'create' ? 'Create' : 'Update'}`
    if (document.components.schemas[schemaName]) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } } }
    }
  }
  if (!contract && isZodSchema(route.openapi?.requestBody)) {
    operation.requestBody = { required: true, content: { 'application/json': { schema: z.toJSONSchema(route.openapi.requestBody, { io: 'input', unrepresentable: 'any' }) } } }
  }

  document.paths[path] ??= {}
  document.paths[path][route.method] = operation
}

function successResponse(contract: ResourceOperation | undefined, entityName: string | undefined) {
  const selectRef = entityName ? { $ref: `#/components/schemas/${entityName}` } : {}

  if (contract === 'list') {
    return {
      '200': jsonResponse('List', {
        type: 'object',
        properties: { data: { type: 'array', items: selectRef }, page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } },
        required: ['data', 'page', 'limit', 'total'],
      }),
    }
  }
  if (contract === 'detail' || contract === 'update') return { '200': jsonResponse('Record', { type: 'object', properties: { data: selectRef }, required: ['data'] }) }
  if (contract === 'create') return { '201': jsonResponse('Created', { type: 'object', properties: { data: selectRef }, required: ['data'] }) }
  if (contract === 'delete') return { '200': jsonResponse('Deleted', { type: 'object', properties: { ok: { const: true } }, required: ['ok'] }) }
  return { '200': jsonResponse('Response shape not declared.', {}) }
}

function jsonResponse(description: string, schema: object) {
  return { description, content: { 'application/json': { schema } } }
}

function registerEntitySchemas(document: OpenApiDocument, entityName: string, schemas: EntitySchemas | undefined, enrich?: { schema?: unknown }) {
  if (!schemas) return
  const named: [string, unknown, 'input' | 'output'][] = [
    [entityName, enrich?.schema ?? schemas.select, 'output'],
    [`${entityName}Create`, schemas.create, 'input'],
    [`${entityName}Update`, schemas.update, 'input'],
  ]
  for (const [name, schema, io] of named) {
    if (!isZodSchema(schema)) continue
    document.components.schemas[name] = z.toJSONSchema(schema, { io, unrepresentable: 'any' })
  }
}

function isZodSchema(value: unknown): value is z.ZodType {
  return Boolean(value && typeof value === 'object' && '_zod' in (value as Record<string, unknown>))
}

function componentName(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9]+(.)/g, (_match, character: string) => character.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '')
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

function joinPath(prefix: string, path: string) {
  if (!prefix || prefix === '/') return path
  return `${prefix}${path}`
}

function normalizePath(path: string) {
  return path.replace(/\/{2,}/g, '/').replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function pathParameters(path: string) {
  return [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }))
}
