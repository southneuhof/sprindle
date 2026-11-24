import { aliasedTable, and, asc, count, desc, eq, getTableColumns, getTableName, ilike, inArray, mapColumnsInSQLToAlias, notInArray, operators, or } from 'drizzle-orm'
import type { AnyColumn, SQL } from 'drizzle-orm'
import type { DomainEntity } from '../entity'
import type { DomainRelationField, DomainSchema } from '../model/domain-schema'
import { validationError } from '../errors'
import { normalizeListQuery } from '../validation'
import { getPrimaryKeyEntries, primaryKeyConditions, primaryKeyValues, type PrimaryKeyEntry } from './drizzle-internals'
import { sourceListFilterEntries, sourceListOptions, sourceVirtualParameters } from './list-query'
import type { ModelSource } from './model-source'

type SelectBuilder = {
  where: (condition: unknown) => SelectBuilder
  orderBy: (...columns: unknown[]) => SelectBuilder
  limit: (limit: number) => SelectBuilder
  offset: (offset: number) => SelectBuilder
} & PromiseLike<unknown[]>

type DrizzleDb = {
  query?: Record<
    string,
    {
      findMany: (config?: unknown) => Promise<unknown[]>
      findFirst: (config?: unknown) => Promise<unknown | undefined>
    }
  >
  select: (fields?: unknown) => {
    from: (table: unknown) => SelectBuilder
  }
  insert: (table: unknown) => {
    values: (input: unknown) => {
      returning: () => Promise<unknown[]>
    }
  }
  update: (table: unknown) => {
    set: (input: unknown) => {
      where: (condition: unknown) => {
        returning: () => Promise<unknown[]>
      }
    }
  }
  delete: (table: unknown) => {
    where: (condition: unknown) => {
      returning: () => Promise<unknown[]>
    }
  }
  transaction?: <T>(fn: (tx: DrizzleDb) => Promise<T>) => Promise<T>
}

async function withTransaction<T>(database: DrizzleDb, fn: (tx: DrizzleDb) => Promise<T>): Promise<T> {
  return database.transaction ? database.transaction(fn) : fn(database)
}

type RelationWrite = { relation: DomainRelationField; value: unknown }

/** Columns bound to the active base-table alias used by a list read. */
export type AliasSafeColumns = Record<string, AnyColumn>

export type CreateDrizzleSourceVirtualParam = {
  validate?: (raw: unknown, field: string) => unknown
  where: (value: unknown, columns: AliasSafeColumns) => SQL | Promise<SQL>
}

export type CreateDrizzleSourceRead<TKey extends string = string> = {
  pinnedOrder?: SQL[] | ((columns: AliasSafeColumns) => SQL[])
  searchColumns?: readonly TKey[]
  virtual?: Record<string, CreateDrizzleSourceVirtualParam>
}

export type CreateDrizzleSourceConfig<TRecord, TCreate, TUpdate> = {
  db: unknown
  table: unknown
  domainSchema?: DomainSchema
  entity?: DomainEntity
  schemas: {
    create: { parse: (input: unknown) => TCreate }
    update: { parse: (input: unknown) => TUpdate }
    select: { parse: (input: unknown) => TRecord }
  }
  read?: CreateDrizzleSourceRead
}

export function createDrizzleSource<TRecord, TCreate, TUpdate>({
  db,
  table,
  domainSchema,
  entity,
  schemas,
  read,
}: CreateDrizzleSourceConfig<TRecord, TCreate, TUpdate>): ModelSource<TRecord> {
  const database = db as DrizzleDb
  const primaryKey = getPrimaryKeyEntries(table)
  const tableColumns = getTableColumns(table as never) as Record<string, AnyColumn>
  const tableKey = entity && domainSchema?.tableKeyByEntity.get(entity)
  const readRelations = entity ? (domainSchema?.relationMetadataByEntity.get(entity) ?? []) : []
  const writeRelations = entity ? (domainSchema?.writeRelationMetadataByEntity.get(entity) ?? readRelations) : []
  const readRelationFields = readRelations.map((relation) => relation.field)
  const relationByField = new Map(writeRelations.map((relation) => [relation.field, relation]))
  const withRelations = readRelationFields.length ? Object.fromEntries(readRelationFields.map((field) => [field, true])) : undefined
  const wherePrimaryKey = (id: unknown) => and(...primaryKeyConditions(primaryKey, id))

  const stringColumns = Object.entries(tableColumns).filter(([, column]) => column.dataType === 'string')
  const searchColumnKeys = read?.searchColumns
    ? read.searchColumns.map((key) => {
        if (!(key in tableColumns)) throw validationError(`Unknown search column "${key}".`)
        return key
      })
    : stringColumns.map(([key]) => key)
  const virtualParams = read?.virtual ?? {}
  const virtualKeys = new Set(Object.keys(virtualParams))

  const buildListPlan = (query: Record<string, unknown>, columns: Record<string, AnyColumn>, alias: string | undefined, virtualConditions: SQL[]) => {
    const pinnedOrder = read?.pinnedOrder
    const { limit, offset, search, order, sort } = sourceListOptions(query, virtualKeys, Boolean(pinnedOrder))
    if (sort && !(sort in columns)) throw validationError(`Unknown sort column "${sort}".`)
    const ordering = { pinnedOrder, order, sort }
    const filters = collectListFilters(query, columns, virtualKeys)
    const { conditions, objectConditions } = buildListConditions(filters, search, searchColumnKeys, virtualConditions, columns)

    return {
      limit,
      offset,
      where: conditions.length ? and(...conditions) : undefined,
      objectWhere: combineObjectConditions(objectConditions),
      // Every canonical list ends with the primary-key terms, so rows that
      // tie on the visible sort stay deterministic between queries.
      orderByColumns: resolveOrderColumns(ordering, columns, alias, primaryKey),
      relationalOrderBy: (relationalTable: unknown) => resolveOrderColumns(ordering, getTableColumns(relationalTable as never) as Record<string, AnyColumn>, getTableName(relationalTable as never), primaryKey),
    }
  }

  const selectRows = () => database.select().from(table)

  const countRows = async (where: unknown, source = table) => {
    const builder = database.select({ value: count() }).from(source)
    const rows = await (where ? builder.where(where) : builder)
    const value = (rows[0] as { value?: unknown } | undefined)?.value
    return Number(value ?? 0)
  }

  const relationalReader = (reader: DrizzleDb) => (tableKey && withRelations ? reader.query?.[tableKey] : undefined)

  const materialize = async (input: unknown | unknown[], reader: DrizzleDb = database): Promise<TRecord | TRecord[]> => {
    if (!Array.isArray(input)) return materializeOne(input, reader)
    const relational = relationalReader(reader)
    // Composite primary keys cannot be batched with a single `in` predicate; they stay per-row (rare).
    if (!relational || primaryKey.length !== 1) return Promise.all(input.map((row) => materializeOne(row, reader)))

    const primaryKeyKey = primaryKey[0].key
    const ids = input.map((row) => getRowId(row, primaryKey))
    const hydrated = await relational.findMany({ where: { [primaryKeyKey]: { in: ids } }, with: withRelations })
    const byId = new Map(hydrated.map((row) => [(row as Record<string, unknown>)[primaryKeyKey], row]))
    return ids.map((id) => {
      const row = byId.get(id)
      if (!row) throw new Error(`Record not found while materializing table "${tableKey}".`)
      return schemas.select.parse(row)
    })
  }
  const materializeOne = async (row: unknown, reader: DrizzleDb = database): Promise<TRecord> => {
    if (!tableKey || !withRelations) return schemas.select.parse(row)
    const id = getRowId(row, primaryKey)
    const hydrated = await reader.query?.[tableKey]?.findFirst({ where: primaryKeyValues(primaryKey, id), with: withRelations })
    if (!hydrated) throw new Error(`Record not found while materializing table "${tableKey}".`)
    return schemas.select.parse(hydrated)
  }

  return {
    async list({ query, where: scopeWhere }) {
      const requested = normalizeListQuery(query ?? {})
      const relational = relationalReader(database)
      const presentVirtuals = sourceVirtualParameters(requested, virtualParams)

      // Drizzle's relational reader aliases its root table as d0. Build a
      // virtual condition against that same alias so awaited builders remain
      // valid in both the count query and the relational query.
      const planAlias = relational && presentVirtuals.length ? RELATIONAL_ROOT_ALIAS : undefined
      const planTable = planAlias ? aliasedTable(table as never, planAlias) : table
      const planColumns = getTableColumns(planTable as never) as Record<string, AnyColumn>
      const virtualConditions = await Promise.all(presentVirtuals.map(({ param, value }) => param.where(value, planColumns)))
      const plan = buildListPlan(requested, planColumns, planAlias, virtualConditions)
      // Server-owned read scope: ANDed after the plan, so nothing in the query
      // can unset it. A scope is either a SQL predicate or a
      // `(table, operators) => SQL` factory. Factories serve relational reads,
      // which alias their base table: the source invokes the factory against
      // the real table for counting/builder reads and hands the factory itself
      // to the relational query as a RAW filter, so Drizzle binds it to the
      // aliased row.
      const where = and(plan.where as never, evaluateScope(scopeWhere, planTable) as never)
      const total = await countRows(where, planTable)

      if (relational) {
        const objectWhere = withRelationalScope(plan.objectWhere, scopeWhere)
        const rows = await relational.findMany({ where: objectWhere, orderBy: plan.relationalOrderBy, limit: plan.limit, offset: plan.offset, with: withRelations })
        return { data: rows.map((row) => schemas.select.parse(row)), total }
      }

      let builder = selectRows()
      if (where) builder = builder.where(where)
      if (plan.orderByColumns) builder = builder.orderBy(...plan.orderByColumns)
      const rows = await builder.limit(plan.limit).offset(plan.offset)
      return { data: rows.map((row) => schemas.select.parse(row)), total }
    },
    async detail({ id, where: scopeWhere }) {
      const scopeSql = evaluateScope(scopeWhere, table)
      const relational = relationalReader(database)
      if (relational) {
        const where = withRelationalScope(primaryKeyValues(primaryKey, id), scopeWhere)
        const hydrated = await relational.findFirst({ where, with: withRelations })
        return hydrated ? schemas.select.parse(hydrated) : null
      }
      const rows = await selectRows().where(and(wherePrimaryKey(id), scopeSql as never)).limit(1)
      return rows[0] ? schemas.select.parse(rows[0]) : null
    },
    async create({ input, inputParsed, values = {} }) {
      const parsed = inputParsed ? input as TCreate : schemas.create.parse(input)
      const { row, relations } = splitRelationInput({ ...parsed, ...values }, relationByField)
      applyOneRelationValues(row, relations, tableColumns)
      return withTransaction(database, async (tx) => {
        const rows = await tx.insert(table).values(row).returning()
        if (rows[0]) {
          const id = getRowId(rows[0], primaryKey)
          await applyManyRelationValues(tx, id, relations, primaryKey, tableColumns)
          return (await materialize(rows[0], tx)) as TRecord
        }
        return schemas.select.parse(rows[0])
      })
    },
    async update({ id, input, inputParsed, values = {}, where: scopeWhere }) {
      const parsed = inputParsed ? input as TUpdate : schemas.update.parse(input)
      const { row, relations } = splitRelationInput({ ...parsed, ...values }, relationByField)
      applyOneRelationValues(row, relations, tableColumns)
      return withTransaction(database, async (tx) => {
        const where = and(wherePrimaryKey(id), evaluateScope(scopeWhere, table) as never)
        const rows = Object.keys(row).length
          ? await tx.update(table).set(row).where(where).returning()
          : await tx.select().from(table).where(where).limit(1)
        if (rows[0]) {
          await applyManyRelationValues(tx, id, relations, primaryKey, tableColumns)
          return (await materialize(rows[0], tx)) as TRecord
        }
        return null
      })
    },
    async delete({ id, where: scopeWhere }) {
      const rows = await database.delete(table).where(and(wherePrimaryKey(id), evaluateScope(scopeWhere, table) as never)).returning()
      return Boolean(rows[0])
    },
    async materialize(input) {
      return materialize(input)
    },
  }
}

const RELATIONAL_ROOT_ALIAS = 'd0'

function evaluateScope(scope: unknown, table: unknown): unknown {
  return typeof scope === 'function' ? scope(table, operators) : scope
}

function withRelationalScope(where: Record<string, unknown> | undefined, scope: unknown) {
  if (!scope) return where
  const raw = { RAW: scope }
  return where ? { AND: [where, raw] } : raw
}

type ListOrdering = {
  pinnedOrder: CreateDrizzleSourceRead['pinnedOrder']
  order: 'asc' | 'desc'
  sort: string | undefined
}

function collectListFilters(query: Record<string, unknown>, columns: Record<string, AnyColumn>, virtualKeys: Set<string>) {
  return sourceListFilterEntries(query, virtualKeys).map(([key, value]) => {
    if (!(key in columns)) throw validationError(`Unknown query parameter "${key}".`)
    return { key, value: coerceFilterValue(key, columns[key], value) }
  })
}

function buildListConditions(filters: { key: string; value: unknown }[], search: string | undefined, searchColumnKeys: string[], virtualConditions: SQL[], columns: Record<string, AnyColumn>) {
  const hasSearch = Boolean(search && searchColumnKeys.length)
  const searchCondition = hasSearch ? or(...searchColumnKeys.map((key) => ilike(columns[key], `%${search}%`))) : undefined
  const searchObject = hasSearch ? { OR: searchColumnKeys.map((key) => ({ [key]: { ilike: `%${search}%` } })) } : undefined
  return {
    conditions: [
      ...filters.map(({ key, value }) => eq(columns[key], value)),
      ...(searchCondition ? [searchCondition] : []),
      ...virtualConditions,
    ],
    objectConditions: [
      ...filters.map(({ key, value }) => ({ [key]: value })),
      ...(searchObject ? [searchObject] : []),
      ...virtualConditions.map((condition) => ({ RAW: condition })),
    ],
  }
}

function combineObjectConditions(conditions: Record<string, unknown>[]) {
  if (conditions.length === 0) return undefined
  if (conditions.length === 1) return conditions[0]
  return { AND: conditions }
}

function resolveOrderColumns(
  ordering: ListOrdering,
  columns: Record<string, AnyColumn>,
  alias: string | undefined,
  primaryKey: readonly PrimaryKeyEntry[],
) {
  const visibleOrder = ordering.pinnedOrder
    ? resolvePinnedOrder(ordering.pinnedOrder, columns, alias)
    : ordering.sort
      ? [ordering.order === 'desc' ? desc(columns[ordering.sort]) : asc(columns[ordering.sort])]
      : []
  return [...visibleOrder, ...primaryKey.map(({ key }) => asc(columns[key]))]
}

/**
 * Equality filters arrive as HTTP strings; coerce them to the column's type so
 * impossible values answer a 400 naming the key instead of a Postgres cast
 * error surfacing as 500.
 */
function coerceFilterValue(key: string, column: AnyColumn, raw: unknown): unknown {
  if (raw === null) return null
  const value = typeof raw === 'string' ? raw.trim() : raw
  const kind = column.dataType as string
  if (kind.startsWith('boolean')) {
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
    throw validationError(`Query parameter "${key}" must be true or false.`)
  }
  if (kind.startsWith('number') || kind.startsWith('bigint')) {
    const parsed = Number(value)
    if (value === '' || Number.isNaN(parsed)) throw validationError(`Query parameter "${key}" must be a number.`)
    return parsed
  }
  if (kind.startsWith('string')) {
    // String-mode timestamps/dates still carry strings; reject values that
    // cannot be a date instead of letting Postgres fail the query.
    if (/Date|Timestamp/.test(column.columnType)) {
      const parsed = new Date(value as string)
      if (!value || Number.isNaN(parsed.getTime())) throw validationError(`Query parameter "${key}" must be a date.`)
    }
    return value
  }
  return value
}

function resolvePinnedOrder(pinnedOrder: NonNullable<CreateDrizzleSourceRead['pinnedOrder']>, columns: AliasSafeColumns, alias?: string) {
  if (typeof pinnedOrder === 'function') return pinnedOrder(columns)
  return alias ? pinnedOrder.map((fragment) => mapColumnsInSQLToAlias(fragment, alias)) : pinnedOrder
}

function splitRelationInput(input: object, relationByField: Map<string, DomainRelationField>) {
  const row: Record<string, unknown> = {}
  const relations: RelationWrite[] = []
  for (const [key, value] of Object.entries(input)) {
    const relation = relationByField.get(key)
    if (relation) relations.push({ relation, value })
    else row[key] = value
  }
  return { row, relations }
}

function applyOneRelationValues(row: Record<string, unknown>, relations: RelationWrite[], tableColumns: Record<string, AnyColumn>) {
  for (const { relation, value } of relations) {
    if (relation.isArray) continue
    const sourceColumn = onlyColumn(relation.sourceColumns, relation.field)
    const sourceKey = getColumnKey(tableColumns, sourceColumn)
    if (value == null && sourceColumn.notNull) throw validationError(`Relation "${relation.field}" cannot be null because "${sourceKey}" is not nullable.`)
    row[sourceKey] = value == null ? null : getInputColumnValue(relation.targetEntity.table, onlyColumn(relation.targetColumns, relation.field), value, relation.field)
  }
}

async function applyManyRelationValues(
  database: DrizzleDb,
  ownerId: unknown,
  relations: RelationWrite[],
  primaryKey: readonly PrimaryKeyEntry[],
  tableColumns: Record<string, AnyColumn>,
) {
  for (const { relation, value } of relations) {
    const field = relation.field
    if (!relation.isArray) continue
    if (!Array.isArray(value)) throw validationError(`Relation "${field}" must be an array.`)

    if (relation.mode === 'through') {
      await applyThroughManyRelationValue(database, ownerId, relation, value, primaryKey, tableColumns)
      continue
    }

    const ownerColumn = onlyColumn(relation.sourceColumns, field)
    const childFkColumn = onlyColumn(relation.targetColumns, field)
    const childPk = onlyEntry(getPrimaryKeyEntries(relation.targetEntity.table), field)
    const ownerValue = getOwnerColumnValue(ownerId, primaryKey, getColumnKey(tableColumns, ownerColumn))
    const childFkKey = getColumnKey(getTableColumns(relation.targetEntity.table as never) as Record<string, AnyColumn>, childFkColumn)
    const selectedIds = unique(value.map((item) => getInputColumnValue(relation.targetEntity.table, childPk.column, item, field)))

    if (!selectedIds.length) {
      if (childFkColumn.notNull) throw validationError(`Relation "${field}" cannot be cleared because "${childFkKey}" is not nullable.`)
      await database.update(relation.targetEntity.table).set({ [childFkKey]: null }).where(eq(childFkColumn, ownerValue)).returning()
      continue
    }

    if (childFkColumn.notNull) {
      const rows = await database.select().from(relation.targetEntity.table).where(eq(childFkColumn, ownerValue))
      const staleRows = rows.filter((row) => !selectedIds.includes((row as Record<string, unknown>)[childPk.key]))
      if (staleRows.length) throw validationError(`Relation "${field}" cannot remove existing rows because "${childFkKey}" is not nullable.`)
    } else {
      await database
        .update(relation.targetEntity.table)
        .set({ [childFkKey]: null })
        .where(and(eq(childFkColumn, ownerValue), notInArray(childPk.column, selectedIds)))
        .returning()
    }

    await database
      .update(relation.targetEntity.table)
      .set({ [childFkKey]: ownerValue })
      .where(inArray(childPk.column, selectedIds))
      .returning()
  }
}

async function applyThroughManyRelationValue(
  database: DrizzleDb,
  ownerId: unknown,
  relation: DomainRelationField,
  value: unknown[],
  primaryKey: readonly PrimaryKeyEntry[],
  tableColumns: Record<string, AnyColumn>,
) {
  if (!relation.throughTable || !relation.throughSourceColumns || !relation.throughTargetColumns) throw validationError(`Relation "${relation.field}" through metadata is incomplete.`)

  const ownerColumn = onlyColumn(relation.sourceColumns, relation.field)
  const targetColumn = onlyColumn(relation.targetColumns, relation.field)
  const throughSourceColumn = onlyColumn(relation.throughSourceColumns, relation.field)
  const throughTargetColumn = onlyColumn(relation.throughTargetColumns, relation.field)
  const throughColumns = getTableColumns(relation.throughTable as never) as Record<string, AnyColumn>
  const throughSourceKey = getColumnKey(throughColumns, throughSourceColumn)
  const throughTargetKey = getColumnKey(throughColumns, throughTargetColumn)
  const ownerValue = getOwnerColumnValue(ownerId, primaryKey, getColumnKey(tableColumns, ownerColumn))
  const selectedIds = unique(value.map((item) => getInputColumnValue(relation.targetEntity.table, targetColumn, item, relation.field)))

  await database.delete(relation.throughTable).where(eq(throughSourceColumn, ownerValue)).returning()
  if (selectedIds.length) {
    await database
      .insert(relation.throughTable)
      .values(selectedIds.map((selectedId) => ({ [throughSourceKey]: ownerValue, [throughTargetKey]: selectedId })))
      .returning()
  }
}

function onlyColumn(columns: AnyColumn[], field: string) {
  if (columns.length !== 1) throw validationError(`Relation "${field}" writes only support single-column relations.`)
  return columns[0]
}

function onlyEntry<T>(entries: T[], field: string) {
  if (entries.length !== 1) throw validationError(`Relation "${field}" writes only support single-column primary keys.`)
  return entries[0]
}

function getColumnKey(columns: Record<string, AnyColumn>, column: AnyColumn) {
  const entry = Object.entries(columns).find(([, candidate]) => candidate === column || candidate.name === column.name)
  if (!entry) throw validationError(`Column "${column.name}" not found in table metadata.`)
  return entry[0]
}

function getInputColumnValue(table: unknown, column: AnyColumn, input: unknown, field: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationError(`Relation "${field}" value must be an object.`)
  const key = getColumnKey(getTableColumns(table as never) as Record<string, AnyColumn>, column)
  if (!(key in input)) throw validationError(`Relation "${field}" value must include "${key}".`)
  return (input as Record<string, unknown>)[key]
}

function getOwnerColumnValue(ownerId: unknown, primaryKey: readonly PrimaryKeyEntry[], ownerKey: string) {
  if (primaryKey.length === 1) return ownerId
  return primaryKeyValues(primaryKey, ownerId)[ownerKey]
}

function unique(values: unknown[]) {
  return [...new Set(values)]
}

function getRowId(row: unknown, primaryKey: readonly PrimaryKeyEntry[]) {
  if (!row || typeof row !== 'object') return undefined
  if (primaryKey.length === 1) return ((row as Record<string, unknown>)[primaryKey[0].key] ?? (row as Record<string, unknown>)[primaryKey[0].column.name]) as string
  return Object.fromEntries(primaryKey.map(({ key, column }) => [key, (row as Record<string, unknown>)[key] ?? (row as Record<string, unknown>)[column.name]]))
}
