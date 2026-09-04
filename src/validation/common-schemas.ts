import { z } from 'zod/v4'
import { validationError } from '../errors'

export const listQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().optional(),
    sort: z.string().optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  // Every other key is an equality filter; the source validates it against the table columns.
  .catchall(z.string())

/** Treat an empty form control as an absent list-query value. */
export function normalizeListQuery<T extends Record<string, unknown>>(query: T): T {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== '')) as T
}

export const idParamSchema = z.object({
  id: z.string().min(1),
})

/** Default virtual-param validator: the value must be a string. */
export function requireStringParam(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw validationError(`Query parameter "${field}" must be a string.`)
  return raw
}
