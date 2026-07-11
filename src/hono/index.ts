import type { Hono, TypedResponse } from 'hono'
import type { z } from 'zod/v4'
import type { DefinedModel, ModelRoute, ModelRuntimeContext } from '../model'

type ListQuery = {
  page?: string
  limit?: string
  search?: string
}

type JsonEndpoint<TInput, TOutput, TStatus extends number = 200> = {
  input: TInput
  output: TOutput
  outputFormat: 'json'
  status: TStatus
}

export type SprindleInstallable = DefinedModel | ModelRoute
export type SprindleInstallSchema<TInstallables extends readonly SprindleInstallable[]> = UnionToIntersection<SprindleSchema<TInstallables[number]>>

type RequireTopLevelRoutePath<TInstallables extends readonly SprindleInstallable[]> = {
  readonly [K in keyof TInstallables]: TInstallables[K] extends ModelRoute<any, any, '', any, any, any> ? never : TInstallables[K]
}

type SprindleSchema<TInstallable> =
  TInstallable extends { method: infer TMethod extends string; path: infer TPath extends string; kind: infer TKind extends string }
    ? RouteSchema<unknown, TMethod, TKind, TPath>
    : TInstallable extends DefinedModel
      ? ModelSchema<TInstallable>
      : {}

type ModelSchema<TModel extends DefinedModel> =
  TModel extends DefinedModel<infer TPath, infer TEntity, infer TRoutes> ? RouteTreeSchema<TEntity, TRoutes, TPath> : {}

type RouteTreeSchema<TEntity, TTree, TPrefix extends string> = UnionToIntersection<{
  [K in keyof TTree & string]: TTree[K] extends ModelRoute<any, infer TMethod, infer TPath, any, infer TOutput, infer TKind>
    ? RouteSchema<TEntity, TMethod, TKind, JoinPath<JoinPath<TPrefix, K>, TPath>, TOutput>
    : TTree[K] extends Record<string, unknown>
      ? RouteTreeSchema<TEntity, TTree[K], JoinPath<TPrefix, K>>
      : {}
}[keyof TTree & string]>

type RouteSchema<TEntity, TMethod extends string, TKind extends string, TPath extends string, TOutput = unknown> = {
  [P in NormalizePath<TPath>]: {
    [M in `$${TMethod}`]: TKind extends 'custom'
      ? OutputEndpoint<RouteInput<TEntity, TKind, NormalizePath<TPath>>, TOutput>
      : CanonicalEndpoint<TEntity, RouteInput<TEntity, TKind, NormalizePath<TPath>>, TKind>
  }
}

type CanonicalEndpoint<TEntity, TInput, TKind extends string> =
  | JsonEndpoint<TInput, KindOutput<TEntity, TKind>, RouteStatus<TKind>>
  | JsonEndpoint<TInput, RpcError, ErrorStatus<TKind>>

type OutputEndpoint<TInput, TOutput> = Awaited<TOutput> extends infer TResult
  ? TResult extends TypedResponse<infer TData, infer TStatus, infer TFormat>
    ? { input: TInput; output: TData; outputFormat: TFormat; status: TStatus }
    : TResult extends object
      ? JsonEndpoint<TInput, TResult, 200>
      : JsonEndpoint<TInput, unknown, 200>
  : never

type RouteInput<TEntity, TKind extends string, TPath extends string> =
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
type SelectOutput<TEntity> = TEntity extends { schemas: { select: infer TSchema extends z.ZodType } } ? z.output<TSchema> : unknown
type KindOutput<TEntity, TKind extends string> = TKind extends 'list'
  ? { data: SelectOutput<TEntity>[]; page: number; limit: number; total?: number }
  : TKind extends 'detail' | 'create' | 'update'
    ? { data: SelectOutput<TEntity> }
    : TKind extends 'delete'
      ? { ok: true }
      : unknown
type RpcError = { error: string; message?: string; issues?: Array<{ field?: string; message: string }> }
type RouteStatus<TKind extends string> = TKind extends 'create' ? 201 : 200
type ErrorStatus<TKind extends string> = TKind extends 'list' ? 400 | 401 | 403 | 500 : TKind extends 'create' ? 400 | 401 | 403 | 409 | 422 | 500 : 400 | 401 | 403 | 404 | 409 | 422 | 500

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

export function installSprindle<const TApp extends Hono<any, any>, const TInstallables extends readonly SprindleInstallable[]>(
  app: TApp,
  installables: TInstallables & RequireTopLevelRoutePath<TInstallables>,
): TApp extends Hono<infer TEnv, infer TSchema> ? Hono<TEnv, TSchema & SprindleInstallSchema<TInstallables>> : never {
  for (const installable of installables) {
    if ('route' in installable) {
      app.route(installable.path, installable.route)
      continue
    }

    if (!installable.path) throw new Error('Top-level Sprindle routes need a path.')
    const boundRoute = installable.bind({ name: installable.path } as ModelRuntimeContext)
    const install = app[boundRoute.method] as (path: string, ...handlers: unknown[]) => Hono
    install.call(app, boundRoute.path, ...boundRoute.middleware, boundRoute.handler)
  }

  return app as never
}
