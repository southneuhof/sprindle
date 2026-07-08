import type { Context, MiddlewareHandler } from 'hono'
import type { ModelRuntimeContext } from '../source'
import type { AnyInput, HttpMethod, ModelRoute, ModelRouteKind, RouteHandlerArgs, RoutePipeline } from '../model/route-types'
import { MODEL_ROUTE } from '../model/route-types'
import { normalizePipeline, runRoutePipeline, type PipelineContext } from './pipeline'

export type RouteActionResult = Response | object

export type DefineRouteConfig<
  TContext extends ModelRuntimeContext,
  TMethod extends HttpMethod,
  TPath extends string,
  TKind extends ModelRouteKind,
  TState extends Record<string, unknown> = Record<string, unknown>,
> = {
  method: TMethod
  path?: TPath
  kind?: TKind
  middleware?: MiddlewareHandler[]
  state?: (args: { c: Context; context: TContext }) => TState | Promise<TState>
  action: (args: RouteHandlerArgs<TContext, TState, TMethod, TPath, TKind>) => RouteActionResult | Promise<RouteActionResult>
} & RoutePipeline<RouteHandlerArgs<TContext, TState, TMethod, TPath, TKind>>

export type RouteConfigFor<
  TState extends Record<string, unknown>,
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TKind extends ModelRouteKind = ModelRouteKind,
> = RoutePipeline<RouteHandlerArgs<TContext, TState, TMethod, TPath, TKind>>

export type RouteFactoryConfigFor<TState extends Record<string, unknown>> = RouteConfigFor<TState>

export type ModelRouteFactory<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TInput extends AnyInput = AnyInput,
  TOutput = unknown,
  TKind extends ModelRouteKind = ModelRouteKind,
  TState extends Record<string, unknown> = Record<string, unknown>,
> = (config?: RouteConfigFor<TState, TContext, TMethod, TPath, TKind>) => ModelRoute<TContext, TMethod, TPath, TInput, TOutput, TKind>

export function defineRoute<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  TInput extends AnyInput = {},
  TOutput = unknown,
  const TKind extends ModelRouteKind = 'custom',
  TState extends Record<string, unknown> = Record<string, unknown>,
>(config: Omit<DefineRouteConfig<TContext, TMethod, '', TKind, TState>, 'path'> & { path?: never }): ModelRoute<TContext, TMethod, '', TInput, TOutput, TKind>
export function defineRoute<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  const TPath extends string = string,
  TInput extends AnyInput = {},
  TOutput = unknown,
  const TKind extends ModelRouteKind = 'custom',
  TState extends Record<string, unknown> = Record<string, unknown>,
>(config: DefineRouteConfig<TContext, TMethod, TPath, TKind, TState> & { path: TPath }): ModelRoute<TContext, TMethod, TPath, TInput, TOutput, TKind>
export function defineRoute<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  const TPath extends string = '',
  TInput extends AnyInput = {},
  TOutput = unknown,
  const TKind extends ModelRouteKind = 'custom',
  TState extends Record<string, unknown> = Record<string, unknown>,
>({
  method,
  path,
  kind,
  middleware = [],
  before,
  authorize,
  validate,
  after,
  error,
  state,
  action,
}: DefineRouteConfig<TContext, TMethod, TPath, TKind, TState>): ModelRoute<TContext, TMethod, TPath, TInput, TOutput, TKind> {
  const routePath = (path ?? '') as TPath
  const routeKind = (kind ?? 'custom') as TKind
  const route = { method, path: routePath, kind: routeKind }
  const routePipeline = normalizePipeline({ before, authorize, validate, after, error })
  return {
    [MODEL_ROUTE]: true,
    method,
    path: routePath,
    kind: routeKind,
    bind: (context) => ({
      method,
      path: routePath,
      middleware,
      handler: async (c) => {
        const typedContext = context as TContext
        const args = {
          c,
          context: typedContext,
          route,
          state: state ? await state({ c, context: typedContext }) : ({} as TState),
        } as RouteHandlerArgs<TContext, TState, TMethod, TPath, TKind>

        return runRoutePipeline(
          args,
          normalizePipeline((context as PipelineContext).pipeline) as RoutePipeline<RouteHandlerArgs<TContext, TState, TMethod, TPath, TKind>> | undefined,
          routePipeline as RoutePipeline<RouteHandlerArgs<TContext, TState, TMethod, TPath, TKind>> | undefined,
          action,
        )
      },
    }),
  }
}

export function defineRouteFactory<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  const TPath extends string = '',
  TInput extends AnyInput = {},
  TOutput = unknown,
  const TKind extends ModelRouteKind = 'custom',
  TState extends Record<string, unknown> = Record<string, unknown>,
>(config: DefineRouteConfig<TContext, TMethod, TPath, TKind, TState>): ModelRouteFactory<TContext, TMethod, TPath, TInput, TOutput, TKind, TState> {
  return (extra = {}) => defineRoute({ ...config, ...mergePipeline(config, extra) } as never) as ModelRoute<TContext, TMethod, TPath, TInput, TOutput, TKind>
}

function mergePipeline<TArgs extends RouteHandlerArgs>(base: RoutePipeline<TArgs>, config: RoutePipeline<TArgs>) {
  return {
    before: mergeHooks(base.before, config.before),
    authorize: mergeHooks(base.authorize, config.authorize),
    validate: mergeHooks(base.validate, config.validate),
    after: mergeHooks(base.after, config.after),
    error: mergeHooks(base.error, config.error),
  }
}

function mergeHooks<T>(base: T | T[] | undefined, extra: T | T[] | undefined) {
  if (!base) return extra
  if (!extra) return base
  return [...list(base), ...list(extra)]
}

function list<T>(value: T | T[]) {
  return Array.isArray(value) ? value : [value]
}
