import type { Context, MiddlewareHandler } from 'hono'
import type { ModelRuntimeContext } from '../source'

export const MODEL_ROUTE = Symbol('MODEL_ROUTE')
export declare const MODEL_ROUTE_TYPES: unique symbol

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'
export type AnyInput = Record<string, unknown>

export type RouteHandlerArgs<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TState extends Record<string, unknown> = Record<string, unknown>,
> = {
  c: Context
  context: TContext
  state: TState
  /** Lazy, memoized per request: resolves the caller's identity, or null when none is installed. */
  identity: () => Promise<unknown>
}

export type ValidationIssue = string | { field?: string; message: string }
export type RouteAuthorizeArgs<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = Omit<TArgs, 'state'>
export type RouteErrorArgs<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = RouteAuthorizeArgs<TArgs> & {
  state?: TArgs['state']
  error: unknown
}
export type RouteBefore<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs) => Partial<TArgs['state']> | void | Promise<Partial<TArgs['state']> | void>
export type RouteAuthorize<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: RouteAuthorizeArgs<TArgs>) => Response | ValidationIssue | void | Promise<Response | ValidationIssue | void>
export type RouteValidate<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs) => ValidationIssue | ValidationIssue[] | void | Promise<ValidationIssue | ValidationIssue[] | void>
export type RouteAfter<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: TArgs & { response: Response }) => Response | void | Promise<Response | void>
export type RouteError<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (args: RouteErrorArgs<TArgs>) => Response | void | Promise<Response | void>

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
  _TInput extends AnyInput = AnyInput,
  _TOutput = unknown,
> = {
  readonly [MODEL_ROUTE]: true
  readonly method: TMethod
  readonly path: TPath
  readonly openapi?: { requestBody?: unknown }
  bind: (context: TContext) => BoundModelRoute
} & {
  readonly [MODEL_ROUTE_TYPES]?: {
    readonly input: _TInput
    readonly output: _TOutput
  }
}

export type ModelRouteInput<TRoute extends ModelRoute> = TRouterTypes<TRoute>['input']
export type ModelRouteOutput<TRoute extends ModelRoute> = TRouterTypes<TRoute>['output']

type TRouterTypes<TRoute extends ModelRoute> = TRoute extends { readonly [MODEL_ROUTE_TYPES]?: infer TTypes }
  ? TTypes extends { input: infer TInput; output: infer TOutput }
    ? { input: TInput; output: TOutput }
    : { input: never; output: never }
  : { input: never; output: never }

export function isModelRoute(value: unknown): value is ModelRoute {
  return typeof value === 'object' && value !== null && (value as { [MODEL_ROUTE]?: unknown })[MODEL_ROUTE] === true
}
