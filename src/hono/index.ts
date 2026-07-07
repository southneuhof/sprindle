import type { Hono, Schema } from 'hono'
import type { z } from 'zod/v4'
import type { DefinedModel, ModelAction } from '../model'
import type { DefinedRoute } from '../routes'

type ListQuery = {
  page?: string
  limit?: string
  search?: string
}

type JsonEndpoint<TInput, TStatus extends number = 200> = {
  input: TInput
  output: unknown
  outputFormat: 'json'
  status: TStatus
}

export type SprindleRoutesSchema<TRoutes extends readonly DefinedRoute[]> = UnionToIntersection<SprindleRouteSchema<TRoutes[number]>>

type SprindleRouteSchema<TRoute> =
  TRoute extends { kind: 'custom'; path: infer TPath extends string; route: infer THono extends Hono }
    ? PrefixSchema<HonoSchema<THono>, TPath>
    : TRoute extends { kind: 'model'; path: infer TPath extends string; model: infer TModel extends DefinedModel }
      ? ModelSchema<TModel, TPath>
      : {}

type ModelSchema<TModel extends DefinedModel, TPrefix extends string> =
  TModel extends DefinedModel<infer TEntity, infer TActions> ? ActionTreeSchema<TEntity, TActions, TPrefix> : {}

type ActionTreeSchema<TEntity, TTree, TPrefix extends string> = UnionToIntersection<{
  [K in keyof TTree & string]: TTree[K] extends ModelAction<any, infer TMethod, infer TPath, any, any, infer TKind>
    ? ActionSchema<TEntity, TMethod, TKind, JoinPath<JoinPath<TPrefix, K>, TPath>>
    : TTree[K] extends Record<string, unknown>
      ? ActionTreeSchema<TEntity, TTree[K], JoinPath<TPrefix, K>>
      : {}
}[keyof TTree & string]>

type ActionSchema<TEntity, TMethod extends string, TKind extends string, TPath extends string> = {
  [P in NormalizePath<TPath>]: {
    [M in `$${TMethod}`]: JsonEndpoint<ActionInput<TEntity, TKind, NormalizePath<TPath>>, ActionStatus<TKind>>
  }
}

type ActionInput<TEntity, TKind extends string, TPath extends string> =
  MergeInput<KindInput<TEntity, TKind> & ParamInput<TPath>>

type KindInput<TEntity, TKind extends string> =
  TKind extends 'list'
    ? { query: ListQuery }
    : TKind extends 'create'
      ? CreateInput<TEntity>
      : TKind extends 'update'
        ? UpdateInput<TEntity>
        : {}

type CreateInput<TEntity> = TEntity extends { schemas: { create: infer TSchema extends z.ZodType } } ? { json: z.input<TSchema> } : { json: unknown }
type UpdateInput<TEntity> = TEntity extends { schemas: { update: infer TSchema extends z.ZodType } } ? { json: z.input<TSchema> } : { json: unknown }
type ActionStatus<TKind extends string> = TKind extends 'create' ? 201 : 200

type ParamInput<TPath extends string> = keyof ExtractParams<TPath> extends never ? {} : { param: ExtractParams<TPath> }
type ExtractParams<TPath extends string> =
  string extends TPath
    ? Record<string, string>
    : TPath extends `${string}:${infer Param}/${infer Rest}`
      ? ParamRecord<Param> & ExtractParams<`/${Rest}`>
      : TPath extends `${string}:${infer Param}`
        ? ParamRecord<Param>
        : {}
type ParamRecord<TParam extends string> = { [K in CleanParam<TParam>]: string }
type CleanParam<TParam extends string> = TParam extends `${infer Name}{${string}` ? Name : TParam extends `${infer Name}?` ? Name : TParam

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

type NormalizePath<TPath extends string> = TPath extends `${infer Head}//${infer Tail}` ? NormalizePath<`${Head}/${Tail}`> : TPath
type MergeInput<T> = { [K in keyof T]: T[K] }
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer U) => void ? U : never

export function installSprindle<const TApp extends Hono<any, any>, const TRoutes extends readonly DefinedRoute[]>(
  app: TApp,
  routes: TRoutes,
): TApp extends Hono<infer TEnv, infer TSchema> ? Hono<TEnv, TSchema & SprindleRoutesSchema<TRoutes>> : never {
  for (const route of routes) {
    if (route.kind === 'model') {
      app.route(route.path, route.model.route)
      continue
    }

    app.route(route.path, route.route)
  }

  return app as never
}
