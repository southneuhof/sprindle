import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { validationError } from '../errors'
import { installSprindle, requestContext, sprindleOnError } from '../hono'
import { defineModel } from '../model'
import { authenticated, list } from '../routes'
import { createMemorySource } from '../testing'
import { createTestEntity } from '../testing/test-entity'

type Report = { id: string; title: string; note: string; createdAt: string }

const reportRows: Report[] = [
  { id: 'report-1', title: 'Pump check', note: 'seal worn', createdAt: '2026-01-05' },
  { id: 'report-2', title: 'Valve check', note: 'pump leak', createdAt: '2026-02-10' },
]

const source = createMemorySource<Report>({
  rows: reportRows,
  read: {
    pinnedOrder: (left, right) => right.createdAt.localeCompare(left.createdAt),
    searchColumns: ['title'],
    virtual: {
      month: {
        validate: (raw, field) => {
          if (typeof raw !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw validationError(`${field} must use YYYY-MM.`)
          return raw
        },
        where: async (value, row) => {
          await Promise.resolve()
          return row.createdAt.startsWith(String(value))
        },
      },
    },
  },
})

const entity = createTestEntity<Report>({
  name: 'read-contract-reports',
  rows: source.rows,
  schemas: {
    create: z.object({}),
    update: z.object({}),
    select: z.object({}),
  },
})
entity.source = source as never

const app = installSprindle(
  new Hono().onError(sprindleOnError).use('*', requestContext()),
  [
    defineModel({
      path: '/read-contract-reports',
      entity,
      authorize: [authenticated()],
      routes: { list: list() },
    }),
  ] as const,
  { identity: () => ({ id: 'user-1' }) },
)

describe('declarative read contract over HTTP', () => {
  it('composes pinned order, narrowed search and a virtual param', async () => {
    const response = await app.request('/read-contract-reports/list?search=pump&month=2026-01&sort=note&order=desc')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: [reportRows[0]],
      page: 1,
      limit: 20,
      total: 1,
    })
  })

  it('keeps virtual validation and unknown-key errors', async () => {
    const invalid = await app.request('/read-contract-reports/list?month=2026-13')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'validation_error', message: 'month must use YYYY-MM.' })

    const unknown = await app.request('/read-contract-reports/list?bogus=x')
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ error: 'validation_error', message: 'Unknown query parameter "bogus".' })
  })

  it('treats empty form values as absent before source validation', async () => {
    const response = await app.request('/read-contract-reports/list?title=&bogus=')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: [reportRows[1], reportRows[0]],
      page: 1,
      limit: 20,
      total: 2,
    })
  })
})
