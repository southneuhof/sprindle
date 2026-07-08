import type { Hono } from 'hono'
import type { Schema } from 'hono'
import type { DefinedModel, ModelRoute } from '../model'

export type ModelRouteMount<TPath extends string = string, TModel extends DefinedModel = DefinedModel> = {
  kind: 'model'
  path: TPath
  model: TModel
}

export type HonoRouteMount<TPath extends string = string, TRoute extends Hono = Hono> = {
  kind: 'hono'
  path: TPath
  route: TRoute
}

export type SprindleRouteMount<TPath extends string = string, TRoute extends ModelRoute = ModelRoute> = {
  kind: 'route'
  path: TPath
  route: TRoute
}

export type MountedRoute = ModelRouteMount<string, DefinedModel> | HonoRouteMount | SprindleRouteMount

export function mountRoute<const TPath extends string, const TModel extends DefinedModel>(config: { path: TPath; model: TModel; route?: never }): ModelRouteMount<TPath, TModel>
export function mountRoute<const TPath extends string, const TRoute extends Hono>(config: { path: TPath; route: TRoute; model?: never }): HonoRouteMount<TPath, TRoute>
export function mountRoute<const TPath extends string, const TRoute extends ModelRoute>(config: { path: TPath; route: TRoute; model?: never }): SprindleRouteMount<TPath, TRoute>
export function mountRoute(config: { path: string; model?: DefinedModel; route?: Hono | ModelRoute }): MountedRoute {
  if (config.model) return { kind: 'model', path: config.path, model: config.model }
  if (config.route && 'bind' in config.route) return { kind: 'route', path: config.path, route: config.route }
  if (config.route) return { kind: 'hono', path: config.path, route: config.route }
  throw new Error('mountRoute() needs a model or route.')
}

export type HonoRouteMountSchema<TRoutes extends readonly MountedRoute[]> = UnionToIntersection<HonoMountSchema<TRoutes[number]>>

type HonoMountSchema<TRoute> =
  TRoute extends { kind: 'hono'; path: infer TPath extends string; route: infer THono extends Hono }
    ? PrefixSchema<HonoSchema<THono>, TPath>
    : {}

type HonoSchema<THono> = THono extends Hono<any, infer TSchema extends Schema> ? TSchema : {}

type PrefixSchema<TSchema extends Schema, TPrefix extends string> = {
  [TPath in keyof TSchema as JoinPath<TPrefix, TPath & string>]: TSchema[TPath]
}

type JoinPath<TPrefix extends string, TPath extends string> =
  TPath extends ''
    ? TPrefix
    : TPath extends '/'
      ? TPrefix
      : TPrefix extends '/'
        ? TPath
        : TPath extends `/${infer TRest}`
          ? `${TPrefix}/${TRest}`
          : `${TPrefix}/${TPath}`

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer U) => void ? U : never
