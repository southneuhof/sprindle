import type { Context, MiddlewareHandler } from 'hono'
import type { AnyInput, HttpMethod, ModelAction, ModelActionKind } from '../model/action-types'
import { MODEL_ACTION } from '../model/action-types'
import type { ModelRuntimeContext } from '../source'

export type DefineActionConfig<
  TContext extends ModelRuntimeContext,
  TMethod extends HttpMethod,
  TPath extends string,
  TKind extends ModelActionKind,
> = {
  method: TMethod
  path?: TPath
  kind?: TKind
  validators?: MiddlewareHandler[]
  handler: (args: { c: Context; context: TContext }) => Response | Promise<Response>
}

export function defineAction<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  const TPath extends string = '',
  TInput extends AnyInput = {},
  TOutput = unknown,
  const TKind extends ModelActionKind = 'custom',
>({
  method,
  path,
  kind,
  validators = [],
  handler,
}: DefineActionConfig<TContext, TMethod, TPath, TKind>): ModelAction<TContext, TMethod, TPath, TInput, TOutput, TKind> {
  const actionPath = (path ?? '') as TPath
  const actionKind = (kind ?? 'custom') as TKind
  return {
    [MODEL_ACTION]: true,
    method,
    path: actionPath,
    kind: actionKind,
    bind: (context) => ({
      method,
      path: actionPath,
      validators,
      handler: (c) => handler({ c, context }),
    }),
  }
}
