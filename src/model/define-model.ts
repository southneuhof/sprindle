import { Hono } from 'hono'
import { compileRouteTree, type RouteTree } from './route-tree'
import type { RouteHandlerArgs, RoutePipeline } from './route-types'
import type { ModelRuntimeContext, ModelRuntimeEntity } from '../source'
import { normalizePipeline } from '../routes/pipeline'

export type DefineModelConfig<
  TPath extends string = string,
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TRoutes extends RouteTree = RouteTree,
> = {
  path: TPath
  entity: TEntity
  routes: TRoutes
} & RoutePipeline<RouteHandlerArgs<ModelRuntimeContext>>

export type DefinedModel<
  TPath extends string = string,
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TRoutes extends RouteTree = RouteTree,
> = {
  name: string
  path: TPath
  route: Hono
  routes: TRoutes
  context: ModelRuntimeContext
}

export function defineModel<
  const TPath extends string = string,
  const TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  const TRoutes extends RouteTree = RouteTree,
>({
  path,
  entity,
  routes,
  before,
  authorize,
  validate,
  after,
  error,
}: DefineModelConfig<TPath, TEntity, TRoutes>): DefinedModel<TPath, TEntity, TRoutes> {
  const route = new Hono()
  const context = { name: entity.name, entity, pipeline: normalizePipeline({ before, authorize, validate, after, error }) } as ModelRuntimeContext
  compileRouteTree({ app: route, context, tree: routes as RouteTree })
  return { name: entity.name, path, route, routes, context }
}
