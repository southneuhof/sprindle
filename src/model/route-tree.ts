import type { Hono } from 'hono'
import { isModelRoute } from './route-types'
import type { ModelRoute } from './route-types'
import type { ModelRuntimeContext } from '../source'

export type RouteTree<TContext extends ModelRuntimeContext = ModelRuntimeContext> = {
  [key: string]: RouteTree<TContext> | ModelRoute<TContext>
}

export type CompileRouteTreeConfig<TContext extends ModelRuntimeContext> = {
  app: Hono
  context: TContext
  tree: RouteTree<TContext>
  segments?: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

export function compileRouteTree<TContext extends ModelRuntimeContext>({
  app,
  context,
  tree,
  segments = [],
}: CompileRouteTreeConfig<TContext>) {
  for (const [key, value] of Object.entries(tree)) {
    if (isModelRoute(value)) {
      const boundRoute = value.bind(context)
      const segmentPath = `/${[...segments, key].join('/')}`
      const path = `${segmentPath}${boundRoute.path}`
      const mount = app[boundRoute.method] as (path: string, ...handlers: unknown[]) => Hono
      mount.call(app, path, ...boundRoute.middleware, boundRoute.handler)
      continue
    }

    if (typeof value === 'function') {
      throw new Error(`Route "${[...segments, key].join('/')}" must be called before registration.`)
    }

    if (isPlainObject(value)) {
      compileRouteTree({ app, context, tree: value as RouteTree<TContext>, segments: [...segments, key] })
    }
  }
}
