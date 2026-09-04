import { PgDialect, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { HttpError, notFound } from '../../errors'
import { lockRow } from '../lock-row'

const reports = pgTable('lock_reports', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  statusCode: text('status_code').notNull(),
  stepCode: text('step_code').notNull(),
  deletedAt: text('deleted_at'),
})

const tagged = pgTable('lock_tagged', {
  tagId: text('tag_id').notNull(),
  itemId: text('item_id').notNull(),
}, (t) => [primaryKey({ columns: [t.tagId, t.itemId] })])

const sqlText = (condition: unknown) => new PgDialect().sqlToQuery(condition as never).sql

function createLockDb(rows: Record<string, unknown>[]) {
  const calls: { where: unknown[]; modes: string[] } = { where: [], modes: [] }
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          calls.where.push(condition)
          return {
            for: async (mode: 'update') => {
              calls.modes.push(mode)
              return rows
            },
          }
        },
      }),
    }),
  }
  return { db, calls }
}

describe('lockRow', () => {
  it('locks by primary key with a liveness predicate on soft-delete columns', async () => {
    const row = { id: 'r-1', name: 'Alpha', statusCode: 'open', stepCode: 'report', deletedAt: null }
    const { db, calls } = createLockDb([row])

    const locked = await lockRow(db, reports, 'r-1')

    expect(locked).toEqual(row)
    expect(calls.modes).toEqual(['update'])
    expect(calls.where).toHaveLength(1)
    const rendered = sqlText(calls.where[0])
    expect(rendered).toContain('"id"')
    expect(rendered).toContain('deleted_at')
    expect(rendered).toContain('is null')
  })

  it('answers notFound when the row is absent or soft-deleted', async () => {
    const { db } = createLockDb([])

    await expect(lockRow(db, reports, 'missing')).rejects.toThrow(notFound())
  })

  it('answers the default 409 invalid_transition on a guard miss', async () => {
    const row = { id: 'r-1', name: 'Alpha', statusCode: 'open', stepCode: 'report', deletedAt: null }
    const { db } = createLockDb([row])

    const error = await lockRow(db, reports, 'r-1', { require: { statusCode: 'on-progress' } }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(HttpError)
    const http = error as HttpError
    expect(http.status).toBe(409)
    expect(http.code).toBe('invalid_transition')
    expect(http.message).toBe('The record is not in the required state.')
  })

  it('uses the caller-provided failure message and returns the row on a guard hit', async () => {
    const row = { id: 'r-1', name: 'Alpha', statusCode: 'on-progress', stepCode: 'verify', deletedAt: null }
    const { db } = createLockDb([row])

    const locked = await lockRow(db, reports, 'r-1', {
      require: { statusCode: 'on-progress', stepCode: 'verify' },
      failMessage: 'The inspection is not ready for item verification.',
    })

    expect(locked).toEqual(row)
    const miss = await lockRow(db, reports, 'r-1', { require: { stepCode: 'report' }, failMessage: 'Not at report stage.' }).catch((value: unknown) => value)
    expect((miss as HttpError).message).toBe('Not at report stage.')
  })

  it('skips the liveness predicate when the table has no deletedAt column', async () => {
    const row = { tagId: 't-1', itemId: 'i-1' }
    const { db, calls } = createLockDb([row])

    const locked = await lockRow(db, tagged, JSON.stringify({ tagId: 't-1', itemId: 'i-1' }))

    expect(locked).toEqual(row)
    expect(sqlText(calls.where[0])).not.toContain('deleted_at')
  })
})
