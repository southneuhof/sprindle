import type { Context } from 'hono'
import type { ModelRuntimeContext } from '../source/model-source'

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
