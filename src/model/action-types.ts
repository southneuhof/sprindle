import type { Context, MiddlewareHandler } from 'hono'
import type { ModelRuntimeContext } from '../source'

export const MODEL_ACTION = Symbol('MODEL_ACTION')

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

export type BoundModelAction = {
  method: HttpMethod
  path: string
  validators: MiddlewareHandler[]
  handler: (c: Context) => Response | Promise<Response>
}

export type ModelAction<TContext extends ModelRuntimeContext = ModelRuntimeContext> = {
  readonly [MODEL_ACTION]: true
  bind: (context: TContext) => BoundModelAction
}

export function isModelAction(value: unknown): value is ModelAction {
  return typeof value === 'object' && value !== null && (value as { [MODEL_ACTION]?: unknown })[MODEL_ACTION] === true
}
