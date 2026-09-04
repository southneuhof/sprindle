import type { Context, MiddlewareHandler } from 'hono'
import type { ModelRuntimeContext } from '../source'
import type { AnyInput, HttpMethod, ModelRoute, RouteHandlerArgs, RoutePipeline } from '../model/route-types'
import { MODEL_ROUTE } from '../model/route-types'
import { markResourceRoute, type ResourceOperation, type ResourceRoute } from '../model/resource-route'
import { normalizePipeline, runRoutePipeline, type DataWriteStage, type PipelineContext } from './pipeline'

export type RouteActionResult = Response | object

export type DefineRouteConfig<
  TContext extends ModelRuntimeContext,
  TMethod extends HttpMethod,
  TPath extends string,
  TState extends Record<string, unknown> = Record<string, unknown>,
  TOutput = RouteActionResult,
> = {
  method: TMethod
  path?: TPath
  openapi?: { requestBody?: unknown }
  middleware?: MiddlewareHandler[]
  state?: (args: { c: Context; context: TContext }) => TState | Promise<TState>
  action: (args: RouteHandlerArgs<TContext, TState>) => TOutput | Promise<TOutput>
} & RoutePipeline<RouteHandlerArgs<TContext, TState>>

export type RouteConfigFor<
  TState extends Record<string, unknown>,
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
> = RoutePipeline<RouteHandlerArgs<TContext, TState>>

export function defineRoute<
  TOutput,
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  TInput extends AnyInput = {},
  TState extends Record<string, unknown> = Record<string, unknown>,
>(config: Omit<DefineRouteConfig<TContext, TMethod, '', TState, TOutput>, 'path'> & { path?: never }): ModelRoute<TContext, TMethod, '', TInput, Awaited<TOutput>>
export function defineRoute<
  TOutput,
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  const TPath extends string = string,
  TInput extends AnyInput = {},
  TState extends Record<string, unknown> = Record<string, unknown>,
>(config: DefineRouteConfig<TContext, TMethod, TPath, TState, TOutput> & { path: TPath }): ModelRoute<TContext, TMethod, TPath, TInput, Awaited<TOutput>>
export function defineRoute<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  const TPath extends string = '',
  TInput extends AnyInput = {},
  TOutput = RouteActionResult,
  TState extends Record<string, unknown> = Record<string, unknown>,
>({
  method,
  path,
  openapi,
  middleware = [],
  before,
  authorize,
  validate,
  after,
  error,
  state,
  action,
}: DefineRouteConfig<TContext, TMethod, TPath, TState, TOutput>): ModelRoute<TContext, TMethod, TPath, TInput, TOutput> {
  return createRoute({
    method,
    path,
    openapi,
    middleware,
    before,
    authorize,
    validate,
    after,
    error,
    state,
    action,
  }) as ModelRoute<TContext, TMethod, TPath, TInput, TOutput>
}

function createRoute<
  TContext extends ModelRuntimeContext,
  TMethod extends HttpMethod,
  TPath extends string,
  TState extends Record<string, unknown>,
  TOutput,
>(config: DefineRouteConfig<TContext, TMethod, TPath, TState, TOutput>, dataWriteStage?: DataWriteStage<RouteHandlerArgs<TContext, TState>>): ModelRoute<TContext, TMethod, TPath, AnyInput, TOutput> {
  const { method, path, openapi, middleware = [], before, authorize, validate, after, error, state, action } = config
  const routePath = (path ?? '') as TPath
  const routePipeline = normalizePipeline({ before, authorize, validate, after, error })
  return {
    [MODEL_ROUTE]: true as const,
    method,
    path: routePath,
    openapi,
    bind: (context) => ({
      method,
      path: routePath,
      middleware,
      handler: async (c) => {
        const typedContext = context as TContext
        let identityResult: Promise<unknown> | undefined
        const identity = () => (identityResult ??= Promise.resolve(typedContext.identity ? typedContext.identity(c) : null))
        const baseArgs = {
          c,
          context: typedContext,
          identity,
        } as Omit<RouteHandlerArgs<TContext, TState>, 'state'>

        return runRoutePipeline(
          baseArgs,
          () => (state ? state({ c, context: typedContext }) : ({} as TState)),
          normalizePipeline((context as PipelineContext).pipeline) as RoutePipeline<RouteHandlerArgs<TContext, TState>> | undefined,
          routePipeline as RoutePipeline<RouteHandlerArgs<TContext, TState>> | undefined,
          action as never,
          dataWriteStage,
        )
      },
    }),
  }
}

export function defineResourceRoute<
  TContext extends ModelRuntimeContext,
  TMethod extends HttpMethod,
  TPath extends string,
  TOutput,
  TState extends Record<string, unknown>,
  TResource extends ResourceOperation,
>(
  resource: TResource,
  config: DefineRouteConfig<TContext, TMethod, TPath, TState, TOutput>,
  extra: RouteConfigFor<TState, TContext> = {},
  dataWriteStage?: DataWriteStage<RouteHandlerArgs<TContext, TState>>,
): ResourceRoute<TContext, TMethod, TPath, AnyInput, TOutput, TResource> {
  const route = createRoute({ ...config, ...mergePipeline(config, extra) }, dataWriteStage)
  return markResourceRoute(route, resource)
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
