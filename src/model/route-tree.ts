import type { Hono } from 'hono'
import { isModelRoute } from './route-types'
import type { ModelRoute } from './route-types'
import type { ModelRuntimeContext } from '../source'

export type RouteTree<TContext extends ModelRuntimeContext = ModelRuntimeContext> = {
  [key: string]: RouteTree<TContext> | ModelRoute<TContext>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

/** Walks a route tree depth-first, yielding each route with its key path. */
export function* iterRoutes<TContext extends ModelRuntimeContext>(
  tree: RouteTree<TContext>,
  prefix: string[] = [],
): Generator<{ route: ModelRoute<TContext>; keyPath: string[] }> {
  for (const [key, value] of Object.entries(tree)) {
    if (isModelRoute(value)) yield { route: value, keyPath: [...prefix, key] }
    else if (isPlainObject(value)) yield* iterRoutes(value as RouteTree<TContext>, [...prefix, key])
    else if (typeof value === 'function') throw new Error(`Route "${[...prefix, key].join('/')}" must be called before registration.`)
  }
}

export function compileRouteTree<TContext extends ModelRuntimeContext>({
  app,
  context,
  tree,
}: CompileRouteTreeConfig<TContext>) {
  for (const { route, keyPath } of iterRoutes(tree)) {
    const boundRoute = route.bind(context)
    const path = `/${keyPath.join('/')}${boundRoute.path}`
    const mount = app[boundRoute.method] as (path: string, ...handlers: unknown[]) => Hono
    mount.call(app, path, ...boundRoute.middleware, boundRoute.handler)
  }
}

type CompileRouteTreeConfig<TContext extends ModelRuntimeContext> = {
  app: Hono
  context: TContext
  tree: RouteTree<TContext>
}
