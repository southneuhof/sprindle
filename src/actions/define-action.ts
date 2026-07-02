import type { Context, MiddlewareHandler } from 'hono'
import type { HttpMethod, ModelAction } from '../model/action-types'
import { MODEL_ACTION } from '../model/action-types'
import type { ModelRuntimeContext } from '../source'

export type DefineActionConfig<TContext extends ModelRuntimeContext> = {
  method: HttpMethod
  path?: string
  validators?: MiddlewareHandler[]
  handler: (args: { c: Context; context: TContext }) => Response | Promise<Response>
}

export function defineAction<TContext extends ModelRuntimeContext = ModelRuntimeContext>({
  method,
  path = '',
  validators = [],
  handler,
}: DefineActionConfig<TContext>): ModelAction<TContext> {
  return {
    [MODEL_ACTION]: true,
    bind: (context) => ({
      method,
      path,
      validators,
      handler: (c) => handler({ c, context }),
    }),
  }
}
