import type { RouteHandlerArgs } from '../model/route-types'

/**
 * Decorates one source record before the canonical response envelope is built.
 * Returning undefined keeps the source record.
 */
export type RecordEnrich<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (
  record: unknown,
  args: TArgs,
) => unknown | void | Promise<unknown | void>
