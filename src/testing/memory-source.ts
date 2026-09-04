import { validationError } from '../errors'
import { normalizeListQuery, requireStringParam } from '../validation'
import type { ModelRuntimeContext, ModelSource, SourceListResult } from '../source'

export type MemorySourceRead<TRecord> = {
  pinnedOrder?: (left: TRecord, right: TRecord) => number
  searchColumns?: (keyof TRecord & string)[]
  virtual?: Record<string, { validate?: (raw: unknown, field: string) => unknown; where: (value: unknown, row: TRecord) => boolean | Promise<boolean> }>
}

type MemoryWriteScope<TRecord> = (row: TRecord) => boolean | Promise<boolean>

export type MemorySource<TRecord> = Omit<ModelSource<TRecord>, 'list' | 'detail' | 'update' | 'delete'> & {
  rows: TRecord[]
  list: (args: { query: Record<string, unknown>; where?: (row: TRecord) => boolean; context: ModelRuntimeContext }) => Promise<SourceListResult<TRecord>>
  detail: (args: { id: string; where?: (row: TRecord) => boolean; context: ModelRuntimeContext }) => Promise<TRecord | null>
  update: (args: { id: string; input: unknown; values?: Record<string, unknown>; where?: MemoryWriteScope<TRecord>; context: ModelRuntimeContext }) => Promise<TRecord | null>
  delete: (args: { id: string; where?: MemoryWriteScope<TRecord>; context: ModelRuntimeContext }) => Promise<boolean>
}

const RESERVED_LIST_QUERY_KEYS = new Set(['page', 'limit', 'search', 'sort', 'order'])

type MemoryListOptions<TRecord> = {
  source: Record<string, unknown>
  page: number
  limit: number
  search: string | undefined
  pinnedOrder: MemorySourceRead<TRecord>['pinnedOrder']
  order: 'asc' | 'desc'
  sort: string | undefined
  fields: Set<string>
}

function memoryListOptions<TRecord extends Record<string, unknown>>(
  query: Record<string, unknown>,
  rows: TRecord[],
  virtualKeys: Set<string>,
  pinnedOrder: MemorySourceRead<TRecord>['pinnedOrder'],
): MemoryListOptions<TRecord> {
  const source = normalizeListQuery(query)
  const page = toPositiveInteger(source.page, 1)
  const limit = toPositiveInteger(source.limit, 20)
  const search = virtualKeys.has('search') ? undefined : typeof source.search === 'string' && source.search.length ? source.search.toLowerCase() : undefined
  const order = source.order === 'desc' ? 'desc' : 'asc'
  const sort = pinnedOrder || source.sort == null || source.sort === '' ? undefined : String(source.sort)
  const fields = new Set(rows.flatMap((row) => Object.keys(row)))
  if (sort && !fields.has(sort)) throw validationError(`Unknown sort column "${sort}".`)
  return { source, page, limit, search, pinnedOrder, order, sort, fields }
}

function memoryVirtualTests<TRecord extends Record<string, unknown>>(
  source: Record<string, unknown>,
  virtualParams: NonNullable<MemorySourceRead<TRecord>['virtual']>,
) {
  const presentVirtuals: { test: (row: TRecord) => Promise<boolean> }[] = []
  for (const [field, param] of Object.entries(virtualParams)) {
    const raw = source[field]
    if (raw === undefined) continue
    const value = param.validate ? param.validate(raw, field) : requireStringParam(raw, field)
    presentVirtuals.push({ test: async (row) => param.where(value, row) })
  }
  return presentVirtuals
}

function memoryFilters(source: Record<string, unknown>, virtualKeys: Set<string>, fields: Set<string>) {
  const filters = Object.entries(source).filter(([key, value]) => !RESERVED_LIST_QUERY_KEYS.has(key) && !virtualKeys.has(key) && value !== undefined)
  for (const [key] of filters) {
    if (!fields.has(key)) throw validationError(`Unknown query parameter "${key}".`)
  }
  return filters
}

async function filterMemoryRows<TRecord extends Record<string, unknown>>(
  rows: TRecord[],
  filters: [string, unknown][],
  virtuals: { test: (row: TRecord) => Promise<boolean> }[],
) {
  const matched: TRecord[] = []
  for (const row of rows) {
    if (!filters.every(([key, value]) => String(row[key]) === String(value))) continue
    let passes = true
    for (const { test } of virtuals) {
      if (!(await test(row))) {
        passes = false
        break
      }
    }
    if (passes) matched.push(row)
  }
  return matched
}

function filterMemorySearch<TRecord extends Record<string, unknown>>(
  rows: TRecord[],
  search: string | undefined,
  searchColumns: (keyof TRecord & string)[] | undefined,
) {
  if (!search) return rows
  return rows.filter((row) =>
    Object.entries(row)
      .filter(([key, value]) => typeof value === 'string' && (!searchColumns || searchColumns.includes(key as keyof TRecord & string)))
      .some(([, value]) => (value as string).toLowerCase().includes(search)),
  )
}

function sortMemoryRows<TRecord extends Record<string, unknown>>(
  rows: TRecord[],
  pinnedOrder: MemorySourceRead<TRecord>['pinnedOrder'],
  sort: string | undefined,
  order: 'asc' | 'desc',
  idKey: keyof TRecord & string,
) {
  const tieBreak = (left: TRecord, right: TRecord) => compare(String(left[idKey]), String(right[idKey]))
  if (pinnedOrder) return rows.sort((left, right) => pinnedOrder(left, right) || tieBreak(left, right))
  if (!sort) return rows
  return [...rows].sort((left, right) => compare(left[sort], right[sort]) * (order === 'desc' ? -1 : 1) || tieBreak(left, right))
}

/**
 * In-memory `ModelSource` mirroring the Drizzle source's list semantics, so app
 * tests can run without a database. Keep both implementations in step.
 */
export function createMemorySource<TRecord extends Record<string, unknown>>(
  config: { rows?: TRecord[]; id?: keyof TRecord & string; read?: MemorySourceRead<TRecord> } = {},
): MemorySource<TRecord> {
  const rows = config.rows ? [...config.rows] : []
  const idKey = config.id ?? ('id' as keyof TRecord & string)
  const indexOf = (id: string) => rows.findIndex((row) => String(row[idKey]) === String(id))
  const searchColumns = config.read?.searchColumns

  return {
    rows,
    async list({ query, where: scopeWhere }): Promise<SourceListResult<TRecord>> {
      const virtualParams = config.read?.virtual ?? {}
      const virtualKeys = new Set(Object.keys(virtualParams))
      const options = memoryListOptions(query ?? {}, rows, virtualKeys, config.read?.pinnedOrder)
      const presentVirtuals = memoryVirtualTests(options.source, virtualParams)
      const filters = memoryFilters(options.source, virtualKeys, options.fields)
      let matched = await filterMemoryRows(rows, filters, presentVirtuals)
      // Server-owned read scope, mirroring the Drizzle source's AND-after-plan
      // semantics. Memory sources receive a row predicate instead of SQL.
      if (scopeWhere) matched = matched.filter(scopeWhere)
      matched = filterMemorySearch(matched, options.search, searchColumns)
      // Primary-key tie-break, mirroring the Drizzle source: rows that tie on
      // the visible sort stay deterministic between queries.
      matched = sortMemoryRows(matched, options.pinnedOrder, options.sort, options.order, idKey)

      const offset = (options.page - 1) * options.limit
      return { data: matched.slice(offset, offset + options.limit), total: matched.length }
    },
    async detail({ id, where: scopeWhere }) {
      const row = rows[indexOf(id)]
      if (!row) return null
      // Server-owned read scope on single-row reads, mirroring the Drizzle
      // source: a hidden row answers null, which routes map to 404.
      if (scopeWhere && !scopeWhere(row)) return null
      return row
    },
    async create({ input, values = {} }) {
      const record = { ...(input as TRecord), ...values }
      if (record[idKey] == null) (record as Record<string, unknown>)[idKey] = crypto.randomUUID()
      rows.push(record)
      return record
    },
    async update({ id, input, values = {}, where: scopeWhere }) {
      const index = indexOf(id)
      if (index < 0) return null
      if (scopeWhere && !(await scopeWhere(rows[index]))) return null
      const merged = { ...rows[index], ...(input as Partial<TRecord>), ...values }
      rows[index] = merged
      return merged
    },
    async delete({ id, where: scopeWhere }) {
      const index = indexOf(id)
      if (index < 0) return false
      if (scopeWhere && !(await scopeWhere(rows[index]))) return false
      rows.splice(index, 1)
      return true
    },
    async materialize(input) {
      return input as TRecord | TRecord[]
    },
  }
}

function toPositiveInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function compare(left: unknown, right: unknown) {
  if (left === right) return 0
  if (left == null) return -1
  if (right == null) return 1
  return String(left) < String(right) ? -1 : 1
}
