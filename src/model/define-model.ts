import { Hono } from 'hono'
import { compileActionTree, type ActionTree } from './action-tree'
import type { ModelRuntimeContext, ModelRuntimeEntity } from '../source'

export type DefineModelConfig<
  TEntity extends ModelRuntimeEntity = ModelRuntimeEntity,
  TActions extends Record<string, unknown> = Record<string, unknown>,
> = {
  entity: TEntity
  actions: TActions
}

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
}: DefineModelConfig<TEntity, TActions>): DefinedModel<TEntity, TActions> {
  const route = new Hono()
  const context = { name: entity.name, entity } as ModelRuntimeContext
  compileActionTree({ app: route, context, tree: actions as ActionTree })
  return { name: entity.name, route, actions, context }
}
