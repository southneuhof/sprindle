import { Hono } from 'hono'
import { compileActionTree, type ActionTree } from './action-tree'
import type { ModelRuntimeContext, ModelRuntimeEntity } from '../source'

export type DefineModelConfig<TModel = unknown, TContext extends ModelRuntimeContext<TModel> = ModelRuntimeContext<TModel>> = {
  entity: ModelRuntimeEntity<TModel>
  actions: ActionTree<TContext>
}

export type DefinedModel<TModel = unknown, TContext extends ModelRuntimeContext<TModel> = ModelRuntimeContext<TModel>> = {
  name: string
  route: Hono
  actions: ActionTree<TContext>
  context: TContext
}

export function defineModel<TModel = unknown, TContext extends ModelRuntimeContext<TModel> = ModelRuntimeContext<TModel>>({
  entity,
  actions,
}: DefineModelConfig<TModel, TContext>): DefinedModel<TModel, TContext> {
  const route = new Hono()
  const context = { name: entity.name, entity } as TContext
  compileActionTree({ app: route, context, tree: actions })
  return { name: entity.name, route, actions, context }
}
