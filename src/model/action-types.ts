import type { Context, MiddlewareHandler } from 'hono'
import type { ModelRuntimeContext } from '../source'

export const MODEL_ACTION = Symbol('MODEL_ACTION')

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'
export type AnyInput = Record<string, unknown>
export type ModelActionKind = 'list' | 'detail' | 'create' | 'update' | 'delete' | 'custom'

export type ActionInfo<TMethod extends HttpMethod = HttpMethod, TPath extends string = string, TKind extends ModelActionKind = ModelActionKind> = {
  method: TMethod
  path: TPath
  kind: TKind
}

export type ActionHandlerArgs<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TState extends Record<string, unknown> = Record<string, unknown>,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TKind extends ModelActionKind = ModelActionKind,
> = {
  c: Context
  context: TContext
  action: ActionInfo<TMethod, TPath, TKind>
  state: TState
}

export type ValidationIssue = string | { field?: string; message: string }
export type ActionBefore<TArgs extends ActionHandlerArgs = ActionHandlerArgs> = (args: TArgs) => Partial<TArgs['state']> | void | Promise<Partial<TArgs['state']> | void>
export type ActionAuthorize<TArgs extends ActionHandlerArgs = ActionHandlerArgs> = (args: TArgs) => Response | ValidationIssue | void | Promise<Response | ValidationIssue | void>
export type ActionValidate<TArgs extends ActionHandlerArgs = ActionHandlerArgs> = (args: TArgs) => ValidationIssue | ValidationIssue[] | void | Promise<ValidationIssue | ValidationIssue[] | void>
export type ActionAfter<TArgs extends ActionHandlerArgs = ActionHandlerArgs> = (args: TArgs & { response: Response }) => Response | void | Promise<Response | void>
export type ActionError<TArgs extends ActionHandlerArgs = ActionHandlerArgs> = (args: TArgs & { error: unknown }) => Response | void | Promise<Response | void>

export type ActionPipeline<TArgs extends ActionHandlerArgs = ActionHandlerArgs> = {
  before?: ActionBefore<TArgs> | ActionBefore<TArgs>[]
  authorize?: ActionAuthorize<TArgs> | ActionAuthorize<TArgs>[]
  validate?: ActionValidate<TArgs> | ActionValidate<TArgs>[]
  after?: ActionAfter<TArgs> | ActionAfter<TArgs>[]
  error?: ActionError<TArgs> | ActionError<TArgs>[]
}

export type BoundModelAction = {
  method: HttpMethod
  path: string
  validators: MiddlewareHandler[]
  handler: (c: Context) => Response | Promise<Response>
}

export type ModelAction<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TInput extends AnyInput = AnyInput,
  TOutput = unknown,
  TKind extends ModelActionKind = ModelActionKind,
> = {
  readonly [MODEL_ACTION]: true
  readonly method: TMethod
  readonly path: TPath
  readonly kind: TKind
  bind: (context: TContext) => BoundModelAction
}

export function isModelAction(value: unknown): value is ModelAction {
  return typeof value === 'object' && value !== null && (value as { [MODEL_ACTION]?: unknown })[MODEL_ACTION] === true
}
