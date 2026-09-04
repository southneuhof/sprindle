import { and, eq, getTableColumns, isNull } from 'drizzle-orm'
import type { AnyColumn, InferSelectModel, SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { HttpError, notFound } from '../errors'
import { getPrimaryKeyEntries } from './drizzle-internals'

/** The slice of the Drizzle transaction handle `lockRow` needs. `never` parameters keep the shape assignable from Drizzle's generic builders. */
type LockDb = {
  select: (fields?: unknown) => {
    from: (table: never) => {
      where: (condition: never) => {
        for: (mode: 'update') => Promise<unknown[]>
      }
    }
  }
}

export type LockRowOptions = {
  /** Every key must equal the locked row's value; a miss answers 409 invalid_transition. */
  require?: Record<string, unknown>
  /** Replaces the default 409 message. */
  failMessage?: string
}

function parseCompositeId(id: unknown): Record<string, unknown> {
  if (id && typeof id === 'object' && !Array.isArray(id)) return id as Record<string, unknown>
  if (typeof id === 'string') {
    const value = JSON.parse(id)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  throw new Error('Composite primary key id must be an object or JSON object string')
}

/**
 * Lock-and-guard read for transactional transitions: SELECT ... FOR UPDATE by
 * primary key with a liveness predicate (`deletedAt IS NULL` when the table
 * has that column). An absent row answers `notFound()`; a `require` guard
 * miss answers 409 `invalid_transition`. The caller owns the transaction.
 */
export async function lockRow<T extends PgTable>(
  db: LockDb,
  table: T,
  id: string,
  options: LockRowOptions = {},
): Promise<InferSelectModel<T>> {
  const primaryKey = getPrimaryKeyEntries(table)
  const values = primaryKey.length === 1 ? { [primaryKey[0].key]: id } : parseCompositeId(id)
  const identity: SQL[] = primaryKey.map(({ key, column }) => eq(column, values[key]))

  const columns = getTableColumns(table as never) as Record<string, AnyColumn>
  const liveness: SQL[] = columns.deletedAt ? [isNull(columns.deletedAt)] : []

  const rows = await db.select().from(table as never).where(and(...identity, ...liveness) as never).for('update')
  const row = rows[0] as InferSelectModel<T> | undefined
  if (!row) throw notFound()

  if (options.require) {
    for (const [key, expected] of Object.entries(options.require)) {
      if ((row as Record<string, unknown>)[key] !== expected) {
        throw new HttpError(409, 'invalid_transition', options.failMessage ?? 'The record is not in the required state.')
      }
    }
  }
  return row
}
