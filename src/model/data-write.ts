import type { Context } from 'hono'
import type { ModelRuntimeContext } from '../source'
import type { RouteHandlerArgs } from './route-types'

export type DataWriteOperation = 'create' | 'update'

export type DataWriteHook = (args: {
  c: Context
  context: ModelRuntimeContext
  identity: () => Promise<unknown>
  operation: DataWriteOperation
}) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>

const DATA_WRITE_HOOK = Symbol('SPRINDLE_DATA_WRITE_HOOK')

type DataWriteTarget = object & { [DATA_WRITE_HOOK]?: DataWriteHook }

export function attachDataWriteHook(target: object, hook: DataWriteHook | undefined) {
  Object.defineProperty(target, DATA_WRITE_HOOK, { configurable: true, value: hook })
}

export function getDataWriteHook(target: object): DataWriteHook | undefined {
  return (target as DataWriteTarget)[DATA_WRITE_HOOK]
}

export async function runDataWrite<
  TContext extends ModelRuntimeContext,
  TState extends { values: Record<string, unknown> | undefined },
>(operation: DataWriteOperation, args: RouteHandlerArgs<TContext, TState>) {
  const { c, context, state, identity } = args
  const values = await getDataWriteHook(context)?.({ c, context, identity, operation })
  if (values) state.values = { ...state.values, ...values }
}
