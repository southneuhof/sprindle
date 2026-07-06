import { Hono } from 'hono'
import { compileActionTree, type ActionTree } from './action-tree'
import type { ActionHandlerArgs, ActionPipeline } from './action-types'
import type { ModelRuntimeContext, ModelRuntimeEntity } from '../source'
import { normalizePipeline } from '../actions/pipeline'

export type DefineModelConfig<
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TActions extends Record<string, unknown> = Record<string, unknown>,
> = {
  entity: TEntity
  actions: TActions
} & ActionPipeline<ActionHandlerArgs<ModelRuntimeContext>>

export type DefinedModel<
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TActions extends Record<string, unknown> = Record<string, unknown>,
> = {
  name: string
  route: Hono
  actions: TActions
  context: ModelRuntimeContext
}

export function defineModel<
  const TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  const TActions extends Record<string, unknown> = Record<string, unknown>,
>({
  entity,
  actions,
  before,
  authorize,
  validate,
  after,
  error,
}: DefineModelConfig<TEntity, TActions>): DefinedModel<TEntity, TActions> {
  const route = new Hono()
  const context = { name: entity.name, entity, pipeline: normalizePipeline({ before, authorize, validate, after, error }) } as ModelRuntimeContext
  compileActionTree({ app: route, context, tree: actions as ActionTree })
  return { name: entity.name, route, actions, context }
}
