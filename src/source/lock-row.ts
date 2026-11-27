import { and, getTableColumns, isNull } from 'drizzle-orm'
import type { AnyColumn, InferSelectModel, SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { HttpError, notFound } from '../errors'
import { getPrimaryKeyEntries, primaryKeyConditions } from './drizzle-internals'

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
  failMessage?: string
  where?: SQL
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
  const identity = primaryKeyConditions(getPrimaryKeyEntries(table), id)

  const columns = getTableColumns(table as never) as Record<string, AnyColumn>
  const liveness: SQL[] = columns.deletedAt ? [isNull(columns.deletedAt)] : []
  const scope: SQL[] = options.where ? [options.where] : []

  const rows = await db.select().from(table as never).where(and(...identity, ...liveness, ...scope) as never).for('update')
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
