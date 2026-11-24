import { validationError } from '../errors'
import { normalizeListQuery } from '../validation'
import { sourceListFilterEntries, sourceListOptions, sourceVirtualParameters } from '../source/list-query'
import type { ModelRuntimeContext, ModelSource, SourceListResult } from '../source/model-source'

type MemoryVirtualParameter<TRecord> = {
  validate?: (raw: unknown, field: string) => unknown
  where: (value: unknown, row: TRecord) => boolean | Promise<boolean>
}

export type MemorySourceRead<TRecord> = {
  pinnedOrder?: (left: TRecord, right: TRecord) => number
  searchColumns?: (keyof TRecord & string)[]
  virtual?: Record<string, MemoryVirtualParameter<TRecord>>
}

type MemoryWriteScope<TRecord> = (row: TRecord) => boolean | Promise<boolean>

export type MemorySource<TRecord> = Omit<ModelSource<TRecord>, 'list' | 'detail' | 'update' | 'delete'> & {
  rows: TRecord[]
  list: (args: { query: Record<string, unknown>; where?: (row: TRecord) => boolean; context: ModelRuntimeContext }) => Promise<SourceListResult<TRecord>>
  detail: (args: { id: string; where?: (row: TRecord) => boolean; context: ModelRuntimeContext }) => Promise<TRecord | null>
  update: (args: { id: string; input: unknown; values?: Record<string, unknown>; where?: MemoryWriteScope<TRecord>; context: ModelRuntimeContext }) => Promise<TRecord | null>
  delete: (args: { id: string; where?: MemoryWriteScope<TRecord>; context: ModelRuntimeContext }) => Promise<boolean>
}

function memoryFilters(source: Record<string, unknown>, virtualKeys: Set<string>, fields: Set<string>) {
  const filters = sourceListFilterEntries(source, virtualKeys)
  for (const [key] of filters) {
    if (!fields.has(key)) throw validationError(`Unknown query parameter "${key}".`)
  }
  return filters
}

async function filterMemoryRows<TRecord extends Record<string, unknown>>(
  rows: TRecord[],
  filters: [string, unknown][],
  virtuals: { param: MemoryVirtualParameter<TRecord>; value: unknown }[],
) {
  const matched: TRecord[] = []
  for (const row of rows) {
    if (!filters.every(([key, value]) => String(row[key]) === String(value))) continue
    let passes = true
    for (const { param, value } of virtuals) {
      if (!(await param.where(value, row))) {
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
      const source = normalizeListQuery(query ?? {})
      const pinnedOrder = config.read?.pinnedOrder
      const { limit, offset, search, sort, order } = sourceListOptions(source, virtualKeys, Boolean(pinnedOrder))
      const fields = new Set(rows.flatMap((row) => Object.keys(row)))
      if (sort && !fields.has(sort)) throw validationError(`Unknown sort column "${sort}".`)
      const presentVirtuals = sourceVirtualParameters(source, virtualParams)
      const filters = memoryFilters(source, virtualKeys, fields)
      let matched = await filterMemoryRows(rows, filters, presentVirtuals)
      // Server-owned read scope, mirroring the Drizzle source's AND-after-plan
      // semantics. Memory sources receive a row predicate instead of SQL.
      if (scopeWhere) matched = matched.filter(scopeWhere)
      matched = filterMemorySearch(matched, search?.toLowerCase(), searchColumns)
      matched = sortMemoryRows(matched, pinnedOrder, sort, order, idKey)

      return { data: matched.slice(offset, offset + limit), total: matched.length }
    },
    async detail({ id, where: scopeWhere }) {
      const row = rows[indexOf(id)]
      if (!row) return null
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

function compare(left: unknown, right: unknown) {
  if (left === right) return 0
  if (left == null) return -1
  if (right == null) return 1
  return String(left) < String(right) ? -1 : 1
}
