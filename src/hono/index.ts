import type { Context, Hono } from 'hono'
import { toHttpError } from '../errors'
import type { DefinedModel, ModelRoute, ModelRuntimeContext } from '../model'
import type { ModuleBundle } from '../model/module-bundle'
import type { RouteSchema, RouteTreeSchema } from '../model/route-schema'
import { isResourceRoute, type ResourceRoute } from '../model/resource-route'
import type { IdentityResolver } from '../source'
import type { RoutePipeline, RouteAfter, RouteBefore, RouteAuthorize, RouteError, RouteValidate } from '../model/route-types'
import { normalizePipeline } from '../routes/pipeline'
import type { DataWriteHook } from '../model/data-write'
import { attachDataWriteHook } from '../model/data-write'

export type { DataWriteHook } from '../model/data-write'

export type SprindleInstallable = DefinedModel | ModelRoute | ModuleBundle
export type SprindleInstallSchema<TInstallables extends readonly SprindleInstallable[]> = UnionToIntersection<SprindleSchema<TInstallables[number]>>

type RequireTopLevelRoutePath<TInstallables extends readonly SprindleInstallable[]> = {
  readonly [K in keyof TInstallables]: TInstallables[K] extends ResourceRoute
    ? never
    : TInstallables[K] extends ModuleBundle
      ? Omit<TInstallables[K], 'models'> & { models: RequireTopLevelRoutePath<TInstallables[K]['models']> }
      : TInstallables[K] extends ModelRoute<any, any, '', any, any> ? never : TInstallables[K]
}

type SprindleSchema<TInstallable> =
  TInstallable extends DefinedModel
      ? ModelSchema<TInstallable>
      : TInstallable extends ModuleBundle
      ? UnionToIntersection<SprindleSchema<TInstallable['models'][number]>>
      : TInstallable extends ModelRoute
        ? RouteSchema<unknown, TInstallable, TInstallable['path']>
      : {}

type ModelSchema<TModel extends DefinedModel> =
  TModel extends DefinedModel<infer TPath, infer TEntity, infer TRoutes, infer TEnrich> ? RouteTreeSchema<TEntity, TRoutes, TPath, TEnrich> : {}
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer U) => void ? U : never

/** Minimal, pino-compatible logging surface. Apps bring their own implementation. */
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
  /** Resolves the caller's identity for every route; `authenticated()` guards read it. */
  identity?: IdentityResolver
  /** Receives framework-level error logs; defaults to a console adapter. */
  logger?: Logger
  /**
   * Composition hooks at install scope. Every mounted model inherits them:
   * `before`/`authorize`/`validate` run before model- and route-scope hooks,
   * `after`/`error` run after them (outermost last).
   */
  pipeline?: RoutePipeline
  /** Separate server-owned write callbacks used only by canonical create/update constructors. */
  dataWrite?: DataWriteHook
}

/**
 * Concatenates pipeline scopes without changing hook order. Scope storage
 * (`composeScopes`) decides the after/error direction, so intermediate merges
 * never reverse twice.
 */
function concatPipelines(layers: Array<RoutePipeline | undefined>): RoutePipeline | undefined {
  const picked = layers.filter((layer): layer is RoutePipeline => Boolean(layer))
  if (!picked.length) return undefined
  const collect = <T,>(key: 'before' | 'authorize' | 'validate' | 'after' | 'error'): T[] =>
    picked.flatMap<T>((layer) => {
      const value = layer[key]
      if (!value) return []
      return (Array.isArray(value) ? value : [value]) as T[]
    })
  return normalizePipeline({
    before: collect<RouteBefore>('before'),
    authorize: collect<RouteAuthorize>('authorize'),
    validate: collect<RouteValidate>('validate'),
    after: collect<RouteAfter>('after'),
    error: collect<RouteError>('error'),
  })
}

/**
 * Final scope merge for storage on a model context: `before`/`authorize`/
 * `validate` stay outermost-first; `after`/`error` are stored innermost-first,
 * because the executor runs route scope first, then this list forward.
 */
function composeScopes(layers: Array<RoutePipeline | undefined>): RoutePipeline | undefined {
  const merged = concatPipelines(layers)
  if (!merged) return undefined
  return normalizePipeline({
    before: merged.before,
    authorize: merged.authorize,
    validate: merged.validate,
    after: merged.after ? [...asArray(merged.after)].reverse() : undefined,
    error: merged.error ? [...asArray(merged.error)].reverse() : undefined,
  })
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

/** Middleware: assigns a request id (honoring an inbound `x-request-id`) and echoes it on the response. */
export function requestContext() {
  return async (c: Context, next: () => Promise<void>) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    await next()
  }
}

/**
 * Single installer: module bundles and bare installables (DefinedModel,
 * ModelRoute) mix freely in one tuple. Every mounted model inherits
 * `options.pipeline` (install scope); bundle children additionally inherit the
 * bundle's own `pipeline`, merged around the model's hooks.
 */
export function installSprindle<const TApp extends Hono<any, any>, const TInstallables extends readonly SprindleInstallable[]>(
  app: TApp,
  installables: TInstallables & RequireTopLevelRoutePath<TInstallables>,
  options: SprindleInstallOptions = {},
): TApp extends Hono<infer TEnv, infer TSchema> ? Hono<TEnv, TSchema & SprindleInstallSchema<TInstallables>> : never {
  const logger = options.logger ?? consoleLogger
  app.use('*', async (c: Context, next: () => Promise<void>) => {
    c.set('logger', logger)
    await next()
  })

  // Model contexts are compiled before install; handlers read `.pipeline`
  // lazily per request, so assigning the merged scope here takes effect.
  const mountModel = (model: DefinedModel, outer: RoutePipeline | undefined) => {
    if (options.identity) model.context.identity = options.identity
    attachDataWriteHook(model.context, options.dataWrite)
    model.context.pipeline = composeScopes([outer, model.context.pipeline])
    app.route(model.path, model.route)
  }

  const mountRoute = (route: ModelRoute, outer: RoutePipeline | undefined) => {
    if (isResourceRoute(route)) throw new Error('Canonical resource routes must be mounted inside defineModel().')
    if (!route.path) throw new Error('Top-level Sprindle routes need a path.')
    const context = { name: route.path, identity: options.identity, pipeline: outer } as ModelRuntimeContext
    const boundRoute = route.bind(context)
    const install = app[boundRoute.method] as (path: string, ...handlers: unknown[]) => Hono
    install.call(app, boundRoute.path, ...boundRoute.middleware, boundRoute.handler)
  }

  for (const installable of installables) {
    if ('models' in installable) {
      const bundleScope = concatPipelines([options.pipeline, installable.pipeline])
      for (const nested of installable.models) {
        if ('models' in nested) throw new Error('Nested module bundles are not supported.')
        if ('route' in nested) mountModel(nested, bundleScope)
        else mountRoute(nested, bundleScope)
      }
      continue
    }
    if ('route' in installable) mountModel(installable, options.pipeline)
    else mountRoute(installable as ModelRoute, options.pipeline)
  }

  return app as never
}

/** Hono `app.onError` handler: renders HttpErrors through the envelope and hides everything else behind `internal_error`. */
export function sprindleOnError(error: Error, c: Context) {
  const httpError = toHttpError(error)
  if (httpError) return c.json({ error: httpError.code, message: httpError.message || undefined, issues: httpError.issues }, httpError.status as 400)

  const logger = (c.get('logger') as Logger | undefined) ?? consoleLogger
  logger.error({ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, err: String(error) }, 'sprindle request failed')
  return c.json({ error: 'internal_error' }, 500)
}

/** Hono `app.notFound` handler: one envelope for unmatched routes. */
export function sprindleNotFound(c: Context) {
  return c.json({ error: 'not_found' }, 404)
}
