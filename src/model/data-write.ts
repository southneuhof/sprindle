import type { Context } from 'hono'
import type { ModelRuntimeContext } from '../source'

export type DataWriteOperation = 'create' | 'update'

export type DataWriteHook = (args: {
  c: Context
  context: ModelRuntimeContext
  identity: () => Promise<unknown>
  operation: DataWriteOperation
}) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>
