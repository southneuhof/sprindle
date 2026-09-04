import type { RouteHandlerArgs } from '../model/route-types'

/**
 * Decorates one source record before the canonical response envelope is built.
 * Returning undefined keeps the source record.
 */
export type RecordEnrich<TArgs extends RouteHandlerArgs = RouteHandlerArgs> = (
  record: unknown,
  args: TArgs,
) => unknown | void | Promise<unknown | void>

export async function applyModelRecordEnrich(record: unknown, args: RouteHandlerArgs): Promise<unknown> {
  const enrich = args.context.enrich
  if (!enrich) return record
  const enriched = await enrich.run(record, args)
  return enrich.schema.parse(enriched)
}
