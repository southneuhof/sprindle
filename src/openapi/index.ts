import { z } from 'zod/v4'
import { getRouteManifest, type FileRouteManifest } from '../hono'
import { isFileRoute } from '../routes'
import { resolveScopeMetadata } from '../hono/file-routes'

export type OpenApiInfo = { title: string; version: string }
export type OpenApiDocument = { openapi: '3.1.0'; info: OpenApiInfo; paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } }

const errors = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    issues: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } }, required: ['message'] } },
  },
  required: ['error'],
}
const listParameters = [
  { name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'search', schema: { type: 'string' } }, { name: 'sort', schema: { type: 'string' } },
  { name: 'order', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
]

export function generateOpenApi(manifest: FileRouteManifest, info: OpenApiInfo): OpenApiDocument {
  const document: OpenApiDocument = { openapi: '3.1.0', info, paths: {}, components: { schemas: {} } }
  const publicNames = new Map<unknown, string>()
  const publicCounts = new Map<string, number>()
  for (const entry of manifest) for (const method of entry.methods) {
    const route = entry.handlers[method]
    if (!isFileRoute(route)) continue
    const metadata = resolveScopeMetadata(entry.scopes, entry.httpPath)
    const entity = metadata.entity as { name?: string; schemas?: { select?: unknown; create?: unknown; update?: unknown } } | undefined
    const entityName = entity ? componentName(entity.name ?? entry.httpPath) : undefined
    let name = entityName
    const publicKey = metadata.enrich ?? entity
    if (entityName && publicKey) {
      name = publicNames.get(publicKey)
      if (!name) { const count = (publicCounts.get(entityName) ?? 0) + 1; publicCounts.set(entityName, count); name = count === 1 ? entityName : `${entityName}Public${count}`; publicNames.set(publicKey, name) }
    }
    if (name && entityName && entity?.schemas) register(document, entityName, name, entity.schemas, metadata.enrich)
    const path = entry.httpPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    const statuses = route.kind === 'create' ? [201, 400, 401, 403, 409, 422, 500] : route.kind === 'detail' || route.kind === 'update' || route.kind === 'delete' ? [200, 400, 401, 403, 404, 500] : [200, 400, 401, 403, 500]
    const success = statuses[0]
    const operation: Record<string, unknown> = { responses: Object.fromEntries(statuses.map((status) => [status, json(status === success ? 'Response' : 'Error', status === success ? successSchema(route.kind, name) : errors)])) }
    const parameters = [...entry.parameters.map((parameter) => ({ name: parameter, in: 'path', required: true, schema: { type: 'string' } })), ...(route.kind === 'list' ? listParameters.map((parameter) => ({ ...parameter, in: 'query', required: false })) : [])]
    if (parameters.length) operation.parameters = parameters
    if (entityName && (route.kind === 'create' || route.kind === 'update')) operation.requestBody = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${entityName}${route.kind === 'create' ? 'Create' : 'Update'}` } } } }
    if (route.kind === 'route' && isZod(route.config.openapi && (route.config.openapi as { requestBody?: unknown }).requestBody)) operation.requestBody = { required: true, content: { 'application/json': { schema: z.toJSONSchema((route.config.openapi as { requestBody: z.ZodType }).requestBody, { io: 'input', unrepresentable: 'any' }) } } }
    document.paths[path] ??= {}; document.paths[path][method.toLowerCase()] = operation
  }
  return document
}

export function generateInstalledOpenApi(c: import('hono').Context, info: OpenApiInfo) {
  return generateOpenApi(getRouteManifest(c), info)
}

function successSchema(kind: string, name?: string) { const record = name ? { $ref: `#/components/schemas/${name}` } : {}; if (kind === 'list') return { type: 'object', properties: { data: { type: 'array', items: record }, page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } }, required: ['data', 'page', 'limit', 'total'] }; if (kind === 'delete') return { type: 'object', properties: { ok: { const: true } }, required: ['ok'] }; if (['detail', 'create', 'update'].includes(kind)) return { type: 'object', properties: { data: record }, required: ['data'] }; return {} }
function json(description: string, schema: object) { return { description, content: { 'application/json': { schema } } } }
function isZod(value: unknown): value is z.ZodType { return Boolean(value && typeof value === 'object' && '_zod' in (value as object)) }
function componentName(value: string) { const clean = value.replace(/[^a-zA-Z0-9]+(.)/g, (_match, character: string) => character.toUpperCase()).replace(/[^a-zA-Z0-9]/g, ''); return clean.charAt(0).toUpperCase() + clean.slice(1) }
function register(document: OpenApiDocument, entityName: string, publicName: string, schemas: { select?: unknown; create?: unknown; update?: unknown }, enrich: unknown) { const publicSchema = (enrich as { schema?: unknown } | undefined)?.schema ?? schemas.select; for (const [schemaName, schema, io] of [[publicName, publicSchema, 'output'], [`${entityName}Create`, schemas.create, 'input'], [`${entityName}Update`, schemas.update, 'input']] as const) if (isZod(schema)) document.components.schemas[schemaName] = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) }
