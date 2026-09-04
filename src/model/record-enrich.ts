import type { z } from 'zod/v4'
import type { RouteHandlerArgs } from './route-types'

/** Shared public-record boundary for the canonical model routes. */
export type ModelRecordEnrich<TSchema extends z.ZodType = z.ZodType, TRecord = unknown> = {
  schema: TSchema
  run: (record: TRecord, args: RouteHandlerArgs) => unknown | Promise<unknown>
}
