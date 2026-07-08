import type { Context, MiddlewareHandler } from 'hono'
import type { ModelRuntimeContext } from '../source'

export const MODEL_ROUTE = Symbol('MODEL_ROUTE')

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'
export type AnyInput = Record<string, unknown>
export type ModelRouteKind = 'list' | 'detail' | 'create' | 'update' | 'delete' | 'custom'

export type RouteInfo<TMethod extends HttpMethod = HttpMethod, TPath extends string = string, TKind extends ModelRouteKind = ModelRouteKind> = {
  method: TMethod
  path: TPath
  kind: TKind
}

export type RouteHandlerArgs<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TState extends Record<string, unknown> = Record<string, unknown>,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TKind extends ModelRouteKind = ModelRouteKind,
> = {
  c: Context
  context: TContext
  route: RouteInfo<TMethod, TPath, TKind>
  state: TState
}

export type ValidationIssue = string | { field?: string; message: string }
export type RouteBefore<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs) => Partial<TArgs['state']> | void | Promise<Partial<TArgs['state']> | void>
export type RouteAuthorize<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs) => Response | ValidationIssue | void | Promise<Response | ValidationIssue | void>
export type RouteValidate<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs) => ValidationIssue | ValidationIssue[] | void | Promise<ValidationIssue | ValidationIssue[] | void>
export type RouteAfter<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs & { response: Response }) => Response | void | Promise<Response | void>
export type RouteError<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs & { error: unknown }) => Response | void | Promise<Response | void>

export type RoutePipeline<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = {
  before?: RouteBefore<TArgs> | RouteBefore<TArgs>[]
  authorize?: RouteAuthorize<TArgs> | RouteAuthorize<TArgs>[]
  validate?: RouteValidate<TArgs> | RouteValidate<TArgs>[]
  after?: RouteAfter<TArgs> | RouteAfter<TArgs>[]
  error?: RouteError<TArgs> | RouteError<TArgs>[]
}

export type BoundModelRoute = {
  method: HttpMethod
  path: string
  middleware: MiddlewareHandler[]
  handler: (c: Context) => Response | Promise<Response>
}

export type ModelRoute<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TInput extends AnyInput = AnyInput,
  TOutput = unknown,
  TKind extends ModelRouteKind = ModelRouteKind,
> = {
  readonly [MODEL_ROUTE]: true
  readonly method: TMethod
  readonly path: TPath
  readonly kind: TKind
  bind: (context: TContext) => BoundModelRoute
}

export function isModelRoute(value: unknown): value is ModelRoute {
  return typeof value === 'object' && value !== null && (value as { [MODEL_ROUTE]?: unknown })[MODEL_ROUTE] === true
}
