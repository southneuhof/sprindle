import type { Context, MiddlewareHandler } from 'hono'
import type { ModelRuntimeContext } from '../source'

export const MODEL_ACTION = Symbol('MODEL_ACTION')

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'
export type AnyInput = Record<string, unknown>
export type ModelActionKind = 'list' | 'detail' | 'create' | 'update' | 'delete' | 'custom'

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
