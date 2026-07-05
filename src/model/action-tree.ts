import type { Hono } from 'hono'
import { isModelAction } from './action-types'
import type { ModelAction } from './action-types'
import type { ModelRuntimeContext } from '../source'

export type ActionTree<TContext extends ModelRuntimeContext = ModelRuntimeContext> = {
  [key: string]: ActionTree<TContext> | ModelAction<TContext>
}

export type CompileActionTreeConfig<TContext extends ModelRuntimeContext> = {
  app: Hono
  context: TContext
  tree: ActionTree<TContext>
  segments?: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

export function compileActionTree<TContext extends ModelRuntimeContext>({
  app,
  context,
  tree,
  segments = [],
}: CompileActionTreeConfig<TContext>) {
  for (const [key, value] of Object.entries(tree)) {
    if (isModelAction(value)) {
      const boundAction = value.bind(context)
      const segmentPath = `/${[...segments, key].join('/')}`
      const path = `${segmentPath}${boundAction.path}`
      const mount = app[boundAction.method] as (path: string, ...handlers: unknown[]) => Hono
      mount.call(app, path, ...boundAction.validators, boundAction.handler)
      continue
    }

    if (isPlainObject(value)) {
      compileActionTree({ app, context, tree: value as ActionTree<TContext>, segments: [...segments, key] })
    }
  }
}
