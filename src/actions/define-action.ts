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
  middleware?: MiddlewareHandler[]
  state?: (args: { c: Context; context: TContext }) => TState | Promise<TState>
  handler: (args: ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>) => Response | Promise<Response>
} & ActionPipeline<ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>>

export type ActionConfigFor<
  TState extends Record<string, unknown>,
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TKind extends ModelActionKind = ModelActionKind,
> = ActionPipeline<ActionHandlerArgs<TContext, TState, TMethod, TPath, TKind>>

export type ActionFactoryConfigFor<TState extends Record<string, unknown>> = ActionConfigFor<TState>

export type ModelActionFactory<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TInput extends AnyInput = AnyInput,
  TOutput = unknown,
  TKind extends ModelActionKind = ModelActionKind,
  TState extends Record<string, unknown> = Record<string, unknown>,
> = (config?: ActionConfigFor<TState, TContext, TMethod, TPath, TKind>) => ModelAction<TContext, TMethod, TPath, TInput, TOutput, TKind>

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
  middleware = [],
  before,
  authorize,
  validate,
  after,
  error,
  state,
  handler,
}: DefineActionConfig<TContext, TMethod, TPath, TKind, TState>): ModelActionFactory<TContext, TMethod, TPath, TInput, TOutput, TKind, TState> {
  const actionPath = (path ?? '') as TPath
  const actionKind = (kind ?? 'custom') as TKind
  const action = { method, path: actionPath, kind: actionKind }
  const basePipeline = { before, authorize, validate, after, error }
  return (config = {}) => {
    const actionPipeline = normalizePipeline(mergePipeline(basePipeline, config))
    return {
      [MODEL_ACTION]: true,
      method,
      path: actionPath,
      kind: actionKind,
      bind: (context) => ({
        method,
        path: actionPath,
        middleware,
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
}

function mergePipeline<TArgs extends ActionHandlerArgs>(base: ActionPipeline<TArgs>, config: ActionPipeline<TArgs>) {
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
