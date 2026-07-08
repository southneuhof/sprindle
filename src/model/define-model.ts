import { Hono } from 'hono'
import { compileRouteTree, type RouteTree } from './route-tree'
import type { RouteHandlerArgs, RoutePipeline } from './route-types'
import type { ModelRuntimeContext, ModelRuntimeEntity } from '../source'
import { normalizePipeline } from '../routes/pipeline'

export type DefineModelConfig<
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TRoutes extends RouteTree = RouteTree,
> = {
  entity: TEntity
  routes: TRoutes
} & RoutePipeline<RouteHandlerArgs<ModelRuntimeContext>>

export type DefinedModel<
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TRoutes extends RouteTree = RouteTree,
> = {
  name: string
  route: Hono
  routes: TRoutes
  context: ModelRuntimeContext
}

export function defineModel<
  const TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  const TRoutes extends RouteTree = RouteTree,
>({
  entity,
  routes,
  before,
  authorize,
  validate,
  after,
  error,
}: DefineModelConfig<TEntity, TRoutes>): DefinedModel<TEntity, TRoutes> {
  const route = new Hono()
  const context = { name: entity.name, entity, pipeline: normalizePipeline({ before, authorize, validate, after, error }) } as ModelRuntimeContext
  compileRouteTree({ app: route, context, tree: routes as RouteTree })
  return { name: entity.name, route, routes, context }
}
