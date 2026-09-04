import type { Schema, TypedResponse } from 'hono'
import type { z } from 'zod/v4'
import type { ModelRoute, ModelRouteInput, ModelRouteOutput } from './route-types'
import { RESOURCE_STATUS, type ResourceOperation, type ResourceRoute } from './resource-route'
import type { ModelRecordEnrich } from './record-enrich'

export type ListQuery = {
  page?: string
  limit?: string
  search?: string
  sort?: string
  order?: string
} & Record<string, string | undefined>

type JsonEndpoint<TInput, TOutput, TStatus extends number = 200> = {
  input: TInput
  output: TOutput
  outputFormat: 'json'
  status: TStatus
}

export type RouteTreeSchema<TEntity, TTree, TPrefix extends string, TEnrich extends ModelRecordEnrich<any, any> | undefined = undefined> = RouteTreeSchemaResult<TEntity, TTree, TPrefix, TEnrich> extends Schema
  ? RouteTreeSchemaResult<TEntity, TTree, TPrefix, TEnrich>
  : never

type RouteTreeSchemaResult<TEntity, TTree, TPrefix extends string, TEnrich extends ModelRecordEnrich<any, any> | undefined> = UnionToIntersection<{
  [K in keyof TTree & string]: TTree[K] extends ModelRoute
      ? RouteSchema<TEntity, TTree[K], JoinPath<JoinPath<TPrefix, K>, TTree[K]['path']>, TEnrich>
    : TTree[K] extends Record<string, unknown>
      ? RouteTreeSchemaResult<TEntity, TTree[K], JoinPath<TPrefix, K>, TEnrich>
      : {}
}[keyof TTree & string]>

export type ModelRouteSchema<TEntity, TTree, TEnrich extends ModelRecordEnrich<any, any> | undefined = undefined> = RouteTreeSchema<TEntity, TTree, '', TEnrich>

export type RouteSchema<TEntity, TRoute, TPath extends string, TEnrich extends ModelRecordEnrich<any, any> | undefined = undefined> = TRoute extends ResourceRoute<any, infer TMethod, any, any, any, infer TOperation>
  ? {
      [P in NormalizePath<TPath>]: {
        [M in `$${TMethod}`]:
          | JsonEndpoint<RouteInput<TEntity, TOperation, NormalizePath<TPath>>, OperationOutput<TEntity, TOperation, TEnrich>, typeof RESOURCE_STATUS[TOperation]['success']>
          | JsonEndpoint<RouteInput<TEntity, TOperation, NormalizePath<TPath>>, RpcError, (typeof RESOURCE_STATUS[TOperation]['errors'])[number]>
      }
    }
  : TRoute extends ModelRoute
    ? {
        [P in NormalizePath<TPath>]: {
          [M in `$${TRoute['method']}`]: OutputEndpoint<MergeInput<ModelRouteInput<TRoute> & ParamInput<NormalizePath<TPath>>>, ModelRouteOutput<TRoute>>
        }
      }
    : {}

type OutputEndpoint<TInput, TOutput> = Awaited<TOutput> extends infer TResult
  ? TResult extends TypedResponse<infer TData, infer TStatus, infer TFormat>
    ? { input: TInput; output: TData; outputFormat: TFormat; status: TStatus }
    : TResult extends object
      ? JsonEndpoint<TInput, TResult, 200>
      : JsonEndpoint<TInput, unknown, 200>
  : never

type RouteInput<TEntity, TOperation extends ResourceOperation, TPath extends string> =
  MergeInput<OperationInput<TEntity, TOperation> & ParamInput<TPath>>

type OperationInput<TEntity, TOperation extends ResourceOperation> =
  TOperation extends 'list'
    ? { query: ListQuery }
    : TOperation extends 'create'
      ? CreateInput<TEntity>
      : TOperation extends 'update'
        ? UpdateInput<TEntity>
        : {}

type CreateInput<TEntity> = TEntity extends { schemas: { create: infer TSchema extends z.ZodType } } ? { json: z.input<TSchema> } : { json: unknown }
type UpdateInput<TEntity> = TEntity extends { schemas: { update: infer TSchema extends z.ZodType } } ? { json: z.input<TSchema> } : { json: unknown }
type SelectOutput<TEntity> = TEntity extends { schemas: { select: infer TSchema extends z.ZodType } } ? z.output<TSchema> : unknown
type PublicRecordOutput<TEntity, TEnrich extends ModelRecordEnrich<any, any> | undefined> = TEnrich extends { schema: infer TSchema extends z.ZodType }
  ? z.output<TSchema>
  : SelectOutput<TEntity>
type OperationOutput<TEntity, TOperation extends ResourceOperation, TEnrich extends ModelRecordEnrich<any, any> | undefined> = TOperation extends 'list'
  ? { data: PublicRecordOutput<TEntity, TEnrich>[]; page: number; limit: number; total: number }
  : TOperation extends 'detail' | 'create' | 'update'
    ? { data: PublicRecordOutput<TEntity, TEnrich> }
    : TOperation extends 'delete'
      ? { ok: true }
      : unknown
type RpcError = { error: string; message?: string; issues?: Array<{ field?: string; message: string }> }
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

export type JoinPath<TPrefix extends string, TPath extends string> =
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
