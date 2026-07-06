import type { Context, MiddlewareHandler } from 'hono'
import type { ActionHandlerArgs, ActionPipeline, AnyInput, HttpMethod, ModelAction, ModelActionKind } from '../model/action-types'
import { MODEL_ACTION } from '../model/action-types'
import type { ModelRuntimeContext } from '../source'
import { normalizePipeline, runActionPipeline, type PipelineContext } from './pipeline'

export type DefineActionConfig<
  TContext extends ModelRuntimeContext,
  TMethod extends HttpMethod,
  TPath extends string,
  TKind extends ModelActionKind,
  TState extends Record<string, unknown> = Record<string, unknown>,
> = {
  method: TMethod
  path?: TPath
  kind?: TKind
  validators?: MiddlewareHandler[]
  state?: (args: { c: Context; context: TContext }) => TState | Promise<TState>
  handler: (args: ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>) => Response | Promise<Response>
} & ActionPipeline<ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>>

export type ActionFactoryConfigFor<TState extends Record<string, unknown>> = ActionPipeline<ActionHandlerArgs<ModelRuntimeContext, TState>>

export function defineAction<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  const TMethod extends HttpMethod = HttpMethod,
  const TPath extends string = '',
  TInput extends AnyInput = {},
  TOutput = unknown,
  const TKind extends ModelActionKind = 'custom',
  TState extends Record<string, unknown> = Record<string, unknown>,
>({
  method,
  path,
  kind,
  validators = [],
  before,
  authorize,
  validate,
  after,
  error,
  state,
  handler,
}: DefineActionConfig<TContext, TMethod, TPath, TKind, TState>): ModelAction<TContext, TMethod, TPath, TInput, TOutput, TKind> {
  const actionPath = (path ?? '') as TPath
  const actionKind = (kind ?? 'custom') as TKind
  const action = { method, path: actionPath, kind: actionKind }
  const actionPipeline = normalizePipeline({ before, authorize, validate, after, error })
  return {
    [MODEL_ACTION]: true,
    method,
    path: actionPath,
    kind: actionKind,
    bind: (context) => ({
      method,
      path: actionPath,
      validators,
      handler: async (c) => {
        const typedContext = context as TContext
        const args = {
          c,
          context: typedContext,
          action,
          state: state ? await state({ c, context: typedContext }) : ({} as TState),
        } as ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>

        return runActionPipeline(
          args,
          normalizePipeline((context as PipelineContext).pipeline) as ActionPipeline<ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>> | undefined,
          actionPipeline as ActionPipeline<ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>> | undefined,
          handler,
        )
      },
    }),
  }
}
