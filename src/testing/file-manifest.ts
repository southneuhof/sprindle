import { z } from 'zod/v4'
import { defineRoute as runtimeDefineRoute, isFileRoute, type RuntimeRouteDefinition } from '../routes/define-route'
import { defineScope } from '../routes/define-scope'
import type { FileRouteManifest, FileRouteManifestEntry } from '../hono/file-routes'
import { installSprindle } from '../hono'
import { generateOpenApi } from '../openapi'
import type { Hono } from 'hono'

type FixtureConfig = Record<string, unknown> & { path: string; entity?: Record<string, unknown>; routes: Record<string, unknown> }

export function testDefineRoute(config: Record<string, unknown>) {
  return runtimeDefineRoute(config as never)
}

export function defineFileModelFixture(config: FixtureConfig): FileRouteManifest {
  const { path, entity: inputEntity, routes, ...scopePipeline } = config
  const passthrough = z.looseObject({})
  const entity = inputEntity ? { ...inputEntity, schemas: inputEntity.schemas ?? { create: passthrough, update: passthrough, select: passthrough } } : undefined
  const scope = defineScope({ ...scopePipeline, entity } as never)
  const entries: FileRouteManifestEntry[] = []
  walk(routes, [], (segments, definition) => {
    const route = definition as RuntimeRouteDefinition
    const methods = { list: 'GET', detail: 'GET', create: 'POST', update: 'PATCH', delete: 'DELETE' } as const
    const configuredPath = typeof route.config.path === 'string' ? route.config.path : undefined
    const method = route.kind === 'route' ? String(route.config.method ?? 'GET').toUpperCase() : methods[route.kind as keyof typeof methods]
    const needsId = ['detail', 'update', 'delete'].includes(route.kind)
    const suffix = configuredPath ? configuredPath.split('/').filter(Boolean) : [...segments, ...(needsId ? [':id'] : [])]
    const httpPath = configuredPath?.startsWith('/') ? configuredPath : joinPath(path, suffix)
    const parameters = [...httpPath.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1])
    entries.push({ sourcePath: `${httpPath}/+server.ts`, httpPath, parameters, methods: [method], scopes: [scope], handlers: { [method]: route } })
  })
  return entries
}

export function mergeFileManifests(...values: readonly (FileRouteManifest | readonly FileRouteManifest[])[]): FileRouteManifest {
  return values.flat(2) as FileRouteManifestEntry[]
}

export function testDefineModule<T extends { pipeline?: Record<string, unknown>; models: readonly FileRouteManifest[] }>(value: T) {
  if (!value.pipeline) return value
  const scope = defineScope(value.pipeline as never)
  return { ...value, models: value.models.map((manifest) => manifest.map((entry) => ({ ...entry, scopes: [scope, ...entry.scopes] }))) }
}

export function testInstallSprindle<TApp extends Hono<any, any>>(app: TApp, values: unknown, options?: Parameters<typeof installSprindle>[2]) {
  return installSprindle(app, collect(values), options)
}

export function testGenerateOpenApi(values: unknown, info: Parameters<typeof generateOpenApi>[1]) {
  return generateOpenApi(collect(values), info)
}

function collect(value: unknown): FileRouteManifest {
  if (Array.isArray(value)) return value.flatMap(collect)
  if (value && typeof value === 'object' && 'models' in value) return collect((value as { models: unknown }).models)
  if (value && typeof value === 'object' && 'httpPath' in value) return [value as FileRouteManifestEntry]
  if (isFileRoute(value)) {
    const route = value as RuntimeRouteDefinition
    if (route.kind !== 'route') throw new Error('Canonical resource routes need an entity scope.')
    const path = String(route.config.path ?? '')
    const method = String(route.config.method ?? 'GET').toUpperCase()
    return [{ sourcePath: `${path}/+server.ts`, httpPath: path, parameters: [], methods: [method], scopes: [], handlers: { [method]: route } }]
  }
  throw new Error('Test file manifest contains an unsupported value.')
}

function walk(value: Record<string, unknown>, segments: string[], add: (segments: string[], route: RuntimeRouteDefinition) => void) {
  for (const [key, child] of Object.entries(value)) {
    if (isFileRoute(child)) add([...segments, segment(key)], child)
    else if (child && typeof child === 'object') walk(child as Record<string, unknown>, [...segments, segment(key)], add)
  }
}

function segment(value: string) { return value.replaceAll('_', '-') }
function joinPath(root: string, segments: readonly string[]) { return `${root.replace(/\/$/, '')}/${segments.join('/')}`.replace(/\/$/, '') }
