import type { Hono } from 'hono'
import type { Schema } from 'hono'
import type { DefinedModel } from '../model'

export type ModelRoute<TPath extends string = string> = {
  kind: 'model'
  path: TPath
  model: DefinedModel
}

export type CustomRoute<TPath extends string = string, TRoute extends Hono = Hono> = {
  kind: 'custom'
  path: TPath
  route: TRoute
}

export type DefinedRoute = ModelRoute | CustomRoute

export function defineRoute<const TPath extends string>(config: { path: TPath; model: DefinedModel; route?: never }): ModelRoute<TPath>
export function defineRoute<const TPath extends string, const TRoute extends Hono>(config: { path: TPath; route: TRoute; model?: never }): CustomRoute<TPath, TRoute>
export function defineRoute(config: { path: string; model?: DefinedModel; route?: Hono }): DefinedRoute {
  if (config.model) return { kind: 'model', path: config.path, model: config.model }
  if (config.route) return { kind: 'custom', path: config.path, route: config.route }
  throw new Error('defineRoute() needs a model or route.')
}

export type CustomRoutesSchema<TRoutes extends readonly DefinedRoute[]> = UnionToIntersection<CustomRouteSchema<TRoutes[number]>>

type CustomRouteSchema<TRoute> =
  TRoute extends { kind: 'custom'; path: infer TPath extends string; route: infer THono extends Hono }
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
