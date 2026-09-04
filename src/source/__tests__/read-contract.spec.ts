import { aliasedTable, defineRelationsPart, desc, getTableName, gte, sql } from 'drizzle-orm'
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { validationError } from '../../errors'
import { createEntity, defineDomainPart, defineDomainSchema } from '../../model'
import type { AliasSafeColumns, CreateDrizzleSourceRead } from '../drizzle-source'
import { createDrizzleSource } from '../drizzle-source'

const reports = pgTable('read_contract_reports', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  note: text('note'),
  createdAt: text('created_at').notNull(),
})

const reportLinks = pgTable(
  'read_contract_links',
  {
    reportId: text('report_id').notNull(),
    linkId: text('link_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.reportId, table.linkId] })],
)

const link = createEntity({
  table: reportLinks,
  schemas: {
    create: z.object({ reportId: z.string(), linkId: z.string() }),
    update: z.object({ linkId: z.string() }),
    select: z.object({ reportId: z.string(), linkId: z.string() }),
  },
})

const report = createEntity({
  table: reports,
  schemas: {
    create: z.object({ id: z.string(), name: z.string(), createdAt: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string(), note: z.string().nullable(), createdAt: z.string(), links: z.array(link.schemas.select) }),
  },
})

const relations = defineRelationsPart({ reports, reportLinks }, (r) => ({
  reports: {
    links: r.many.reportLinks({ from: r.reports.id, to: r.reportLinks.reportId }),
  },
}))

const domainSchema = defineDomainSchema([
  defineDomainPart({ tables: { reports, reportLinks }, entities: [report, link], relations: [relations] }),
])

const rows = [{ id: 'report-1', name: 'Alpha', note: null, createdAt: '2026-01-01', links: [] }]
const sqlText = (condition: unknown) => new PgDialect().sqlToQuery(condition as never).sql

function createRecordingDb({ relational = true }: { relational?: boolean } = {}) {
  const calls: { findMany: unknown[]; countWhere: unknown[]; countFromNames: string[]; orderByArgs: unknown[][] } = {
    findMany: [],
    countWhere: [],
    countFromNames: [],
    orderByArgs: [],
  }
  const builder = (fields: unknown) => {
    const chain: Record<string, unknown> = {
      where: (condition: unknown) => {
        if (fields) calls.countWhere.push(condition)
        return chain
      },
      orderBy: (...columns: unknown[]) => {
        calls.orderByArgs.push(columns)
        return chain
      },
      limit: () => chain,
      offset: () => chain,
      then: (resolve: (value: unknown[]) => void) => resolve(fields ? [{ value: rows.length }] : rows),
    }
    return chain
  }
  const db = {
    ...(relational
      ? {
          query: {
            reports: {
              findMany: async (config?: unknown) => {
                calls.findMany.push(config)
                return rows
              },
              findFirst: async () => rows[0],
            },
          },
        }
      : {}),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (fields) calls.countFromNames.push(getTableName(table as never))
        return builder(fields)
      },
    }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
  }
  return { db, calls }
}

const monthVirtual = {
  validate: (raw: unknown, field: string) => {
    if (typeof raw !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw validationError(`${field} must use YYYY-MM.`)
    return raw
  },
  where: async (value: unknown, columns: AliasSafeColumns) => {
    await Promise.resolve()
    return gte(columns.createdAt, `${String(value)}-01`)
  },
}

const buildSource = (db: unknown, read?: CreateDrizzleSourceRead) =>
  createDrizzleSource({ db, table: reports, domainSchema, entity: report, schemas: report.schemas, read })

describe('createDrizzleSource read contract', () => {
  it('pins order and ignores client sort and order', async () => {
    const relational = createRecordingDb()
    await buildSource(relational.db, { pinnedOrder: [desc(reports.createdAt)] }).list({ query: { sort: 'nope', order: 'desc' }, context: undefined as never })

    const orderBy = (relational.calls.findMany[0] as { orderBy: (table: unknown) => unknown }).orderBy
    const fragments = orderBy(aliasedTable(reports, 'd0')) as unknown[]
    expect(sqlText(fragments[0])).toBe('"d0"."created_at" desc')

    const plain = createRecordingDb({ relational: false })
    await buildSource(plain.db, { pinnedOrder: [desc(reports.createdAt)] }).list({ query: { sort: 'nope' }, context: undefined as never })
    expect(sqlText(plain.calls.orderByArgs[0][0])).toBe('"read_contract_reports"."created_at" desc')
  })

  it('narrows search columns and keeps empty search inert', async () => {
    const { db, calls } = createRecordingDb()
    const source = buildSource(db, { searchColumns: ['note'] })

    await source.list({ query: { search: 'alpha' }, context: undefined as never })
    expect(calls.findMany[0]).toMatchObject({ where: { OR: [{ note: { ilike: '%alpha%' } }] } })
    expect(sqlText(calls.countWhere[0])).toContain('"note"')
    expect(sqlText(calls.countWhere[0])).not.toContain('"name"')

    await source.list({ query: { search: '' }, context: undefined as never })
    expect(calls.findMany[1]).toMatchObject({ where: undefined })
  })

  it('validates virtual values, preserves unknown-key errors, and composes async alias-safe SQL', async () => {
    const { db, calls } = createRecordingDb()
    const source = buildSource(db, { virtual: { month: monthVirtual } })

    await expect(source.list({ query: { month: '2026-13' }, context: undefined as never })).rejects.toThrow('month must use YYYY-MM.')
    await expect(source.list({ query: { month: 202601 }, context: undefined as never })).rejects.toThrow('month must use YYYY-MM.')
    await expect(source.list({ query: { month: '2026-01', bogus: 'x' }, context: undefined as never })).rejects.toThrow('Unknown query parameter "bogus".')

    await source.list({
      query: { month: '2026-01', id: 'report-1' },
      where: (table: typeof reports) => sql`${table.name} <> 'hidden'`,
      context: undefined as never,
    })

    expect(calls.countFromNames).toEqual(['d0'])
    expect(sqlText(calls.countWhere[0])).toContain('"d0"."created_at"')
    expect(sqlText(calls.countWhere[0])).toContain('"d0"."name"')
    const outer = (calls.findMany[0] as { where: { AND: Array<{ AND?: unknown[]; RAW?: unknown }> } }).where
    expect(outer.AND[0].AND).toEqual([{ id: 'report-1' }, expect.anything()])
    expect(sqlText((outer.AND[0].AND as { RAW: unknown }[])[1].RAW)).toContain('"d0"."created_at"')
  })

  it('lets a declared search virtual replace native search', async () => {
    const { db, calls } = createRecordingDb()
    const source = buildSource(db, { searchColumns: ['name'], virtual: { search: { where: () => sql`true` } } })

    await source.list({ query: { search: 'ignored' }, context: undefined as never })
    expect(calls.findMany[0]).toMatchObject({ where: { RAW: expect.anything() } })
  })
})
