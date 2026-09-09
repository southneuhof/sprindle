import type { Context, Hono } from 'hono'
import { toHttpError } from '../errors'
import type { IdentityResolver } from '../source'
import type { DataWriteHook } from '../model/data-write'
import type { RoutePipeline } from '../model/route-types'
import { installFileRoutes, type FileRouteManifest } from './file-routes'
export { assertRouteEntitiesBound, bindRouteEntities, getRouteManifest } from './file-routes'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export type { DataWriteHook } from '../model/data-write'
export type { FileRouteManifest, FileRouteManifestEntry } from './file-routes'
export type SprindleInstallable = FileRouteManifest[number]

export type Logger = {
  info: (object: object, message?: string) => void
  warn: (object: object, message?: string) => void
  error: (object: object, message?: string) => void
}

export const consoleLogger: Logger = {
  info: (object, message) => console.info(message ?? '', object),
  warn: (object, message) => console.warn(message ?? '', object),
  error: (object, message) => console.error(message ?? '', object),
}

export type SprindleInstallOptions = {
  context?: Record<string, unknown>
  identity?: IdentityResolver
  logger?: Logger
  pipeline?: RoutePipeline
  dataWrite?: DataWriteHook
}

export function requestContext() {
  return async (c: Context, next: () => Promise<void>) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    await next()
  }
}

export function installSprindle<TApp extends Hono<any, any>>(app: TApp, manifest: FileRouteManifest, options: SprindleInstallOptions = {}) {
  return installFileRoutes(app, manifest, options)
}

export async function loadRouteManifest(projectRoot: string, output = '.sprindle/routes.mjs'): Promise<FileRouteManifest> {
  const module = await import(pathToFileURL(resolve(projectRoot, output)).href) as { default: FileRouteManifest }
  return module.default
}

export function sprindleOnError(error: Error, c: Context) {
  const httpError = toHttpError(error)
  if (httpError) return c.json({ error: httpError.code, message: httpError.message || undefined, issues: httpError.issues }, httpError.status as 400)
  const logger = (c.get('logger') as Logger | undefined) ?? consoleLogger
  logger.error({ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, err: String(error) }, 'sprindle request failed')
  return c.json({ error: 'internal_error' }, 500)
}

export function sprindleNotFound(c: Context) {
  return c.json({ error: 'not_found' }, 404)
}
