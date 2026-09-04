import { Hono } from 'hono'
import { compileRouteTree, type RouteTree } from './route-tree'
import type { ModelRouteSchema } from './route-schema'
import type { RouteHandlerArgs, RoutePipeline } from './route-types'
import type { ModelRuntimeContext, ModelRuntimeEntity } from '../source'
import { normalizePipeline } from '../routes/pipeline'
import type { ModelRecordEnrich } from './record-enrich'
import type { z } from 'zod/v4'

type SelectOutput<TEntity> = TEntity extends { schemas: { select: infer TSchema extends z.ZodType } } ? z.output<TSchema> : unknown

export type DefineModelConfig<
  TPath extends string = string,
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TRoutes extends RouteTree = RouteTree,
  TEnrich extends ModelRecordEnrich<z.ZodType, SelectOutput<TEntity>> | undefined = undefined,
> = {
  path: TPath
  entity: TEntity
  routes: TRoutes
  enrich?: TEnrich
} & RoutePipeline<RouteHandlerArgs<ModelRuntimeContext>>

export type DefinedModel<
  TPath extends string = string,
  _TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TRoutes extends RouteTree = RouteTree,
  TEnrich extends ModelRecordEnrich<any, any> | undefined = ModelRecordEnrich<any, any> | undefined,
> = {
  name: string
  path: TPath
  route: Hono<any, ModelRouteSchema<_TEntity, TRoutes, TEnrich>>
  routes: TRoutes
  context: ModelRuntimeContext<unknown, TEnrich>
}

export function defineModel<
  const TPath extends string = string,
  const TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  const TRoutes extends RouteTree = RouteTree,
  const TEnrich extends ModelRecordEnrich<z.ZodType, SelectOutput<TEntity>> = ModelRecordEnrich<z.ZodType, SelectOutput<TEntity>>,
>(config: Omit<DefineModelConfig<TPath, TEntity, TRoutes, TEnrich>, 'enrich'> & { enrich: TEnrich }): DefinedModel<TPath, TEntity, TRoutes, TEnrich>
export function defineModel<
  const TPath extends string = string,
  const TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  const TRoutes extends RouteTree = RouteTree,
>(config: DefineModelConfig<TPath, TEntity, TRoutes, undefined>): DefinedModel<TPath, TEntity, TRoutes, undefined>
export function defineModel<
  const TPath extends string,
  const TEntity extends ModelRuntimeEntity,
  const TRoutes extends RouteTree,
  const TEnrich extends ModelRecordEnrich<any, any> | undefined,
>({
  path,
  entity,
  routes,
  enrich,
  before,
  authorize,
  validate,
  after,
  error,
}: DefineModelConfig<TPath, TEntity, TRoutes, TEnrich>): DefinedModel<TPath, TEntity, TRoutes, TEnrich> {
  const route = new Hono()
  const context = { name: entity.name, entity, enrich, pipeline: normalizePipeline({ before, authorize, validate, after, error }) } as ModelRuntimeContext<unknown, TEnrich>
  compileRouteTree({ app: route, context, tree: routes as RouteTree })
  return { name: entity.name, path, route, routes, context }
}
