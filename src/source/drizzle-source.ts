import { and, eq, getTableColumns, getTableName, inArray, notInArray, Table } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { PrimaryKeyBuilder } from 'drizzle-orm/pg-core'
import type { DomainEntity, DomainRelationField, DomainSchema } from '../model/domain-schema'
import type { ModelRuntimeEntity, ModelSource } from './model-source'

const tableSymbols = (Table as unknown as { Symbol: Record<'ExtraConfigBuilder' | 'ExtraConfigColumns', symbol> }).Symbol

type DrizzleDb = {
  query?: Record<
    string,
    {
      findMany: (config?: unknown) => Promise<unknown[]>
      findFirst: (config?: unknown) => Promise<unknown | undefined>
    }
  >
  select: () => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        limit: (limit: number) => Promise<unknown[]>
      } & PromiseLike<unknown[]>
    } & PromiseLike<unknown[]>
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
}

type ValidationError = Error & { status: 400; code: 'validation_error' }
type RelationWrite = { relation: DomainRelationField; value: unknown }

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
}

export function createDrizzleSource<TRecord, TCreate, TUpdate>({
  db,
  table,
  domainSchema,
  entity,
  schemas,
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
  const wherePrimaryKey = (id: unknown) => {
    const values = primaryKey.length === 1 ? { [primaryKey[0].key]: id } : parseCompositeId(id)
    return and(...primaryKey.map(({ key, column }) => eq(column, values[key])))
  }
  const wherePrimaryKeyObject = (id: unknown) => {
    if (primaryKey.length === 1) return { [primaryKey[0].key]: id }
    return parseCompositeId(id)
  }

  const materialize = async (input: unknown | unknown[]): Promise<TRecord | TRecord[]> => {
    if (Array.isArray(input)) return Promise.all(input.map((row) => materializeOne(row)))
    return materializeOne(input)
  }
  const materializeOne = async (row: unknown): Promise<TRecord> => {
    if (!tableKey || !withRelations) return schemas.select.parse(row)
    const id = getRowId(row, primaryKey)
    const hydrated = await database.query?.[tableKey]?.findFirst({ where: wherePrimaryKeyObject(id), with: withRelations })
    if (!hydrated) throw new Error(`Record not found while materializing table "${tableKey}".`)
    return schemas.select.parse(hydrated)
  }

  return {
    async list() {
      const rows = await database.select().from(table)
      if (!rows) throw new Error(`Drizzle relational query not found for table "${tableKey}".`)
      return { data: (await materialize(rows)) as TRecord[] }
    },
    async detail({ id }) {
      const rows = await database.select().from(table).where(wherePrimaryKey(id)).limit(1)
      return rows[0] ? ((await materialize(rows[0])) as TRecord) : null
    },
    async create({ input }) {
      const { row, relations } = splitRelationInput(schemas.create.parse(input), relationByField)
      applyOneRelationValues(row, relations, tableColumns)
      const rows = await database.insert(table).values(row).returning()
      if (rows[0]) {
        const id = getReturnedId(rows[0], primaryKey)
        await applyManyRelationValues(database, id, relations, primaryKey, tableColumns)
        return (await materialize(rows[0])) as TRecord
      }
      return schemas.select.parse(rows[0])
    },
    async update({ id, input }) {
      const { row, relations } = splitRelationInput(schemas.update.parse(input), relationByField)
      applyOneRelationValues(row, relations, tableColumns)
      const rows = hasKeys(row)
        ? await database.update(table).set(row).where(wherePrimaryKey(id)).returning()
        : await database.select().from(table).where(wherePrimaryKey(id)).limit(1)
      if (rows[0]) {
        await applyManyRelationValues(database, id, relations, primaryKey, tableColumns)
        return (await materialize(rows[0])) as TRecord
      }
      return rows[0] ? schemas.select.parse(rows[0]) : null
    },
    async delete({ id }) {
      const rows = await database.delete(table).where(wherePrimaryKey(id)).returning()
      return Boolean(rows[0])
    },
    async materialize(input) {
      return materialize(input)
    },
  }
}

function hasKeys(value: unknown) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length)
}

function splitRelationInput(input: unknown, relationByField: Map<string, DomainRelationField>) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { row: input, relations: [] as RelationWrite[] }

  const row: Record<string, unknown> = {}
  const relations: RelationWrite[] = []
  for (const [key, value] of Object.entries(input)) {
    const relation = relationByField.get(key)
    if (relation) relations.push({ relation, value })
    else row[key] = value
  }
  return { row, relations }
}

function applyOneRelationValues(row: unknown, relations: RelationWrite[], tableColumns: Record<string, AnyColumn>) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return
  for (const { relation, value } of relations) {
    if (relation.isArray) continue
    const sourceColumn = onlyColumn(relation.sourceColumns, relation.field)
    const sourceKey = getColumnKey(tableColumns, sourceColumn)
    if (value == null && sourceColumn.notNull) throw validationError(`Relation "${relation.field}" cannot be null because "${sourceKey}" is not nullable.`)
    ;(row as Record<string, unknown>)[sourceKey] = value == null ? null : getInputColumnValue(relation.targetEntity.table, onlyColumn(relation.targetColumns, relation.field), value, relation.field)
  }
}

async function applyManyRelationValues(
  database: DrizzleDb,
  ownerId: unknown,
  relations: RelationWrite[],
  primaryKey: { key: string; column: AnyColumn }[],
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
  primaryKey: { key: string; column: AnyColumn }[],
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

function getOwnerColumnValue(ownerId: unknown, primaryKey: { key: string; column: AnyColumn }[], ownerKey: string) {
  if (primaryKey.length === 1) return ownerId
  return parseCompositeId(ownerId)[ownerKey]
}

function unique(values: unknown[]) {
  return [...new Set(values)]
}

function validationError(message: string): ValidationError {
  return Object.assign(new Error(message), { status: 400 as const, code: 'validation_error' as const })
}

export function getPrimaryKeyColumns(table: unknown): AnyColumn[] {
  return getPrimaryKeyEntries(table).map((entry) => entry.column)
}

function getPrimaryKeyEntries(table: unknown): { key: string; column: AnyColumn }[] {
  const columns = getTableColumns(table as never) as Record<string, AnyColumn>
  const inline = Object.entries(columns)
    .filter(([, column]) => column.primary)
    .map(([key, column]) => ({ key, column }))
  if (inline.length) return inline

  const extraConfigBuilder = (table as { [tableSymbols.ExtraConfigBuilder]?: (columns: unknown) => unknown })[tableSymbols.ExtraConfigBuilder]
  const extraConfigColumns = (table as { [tableSymbols.ExtraConfigColumns]?: unknown })[tableSymbols.ExtraConfigColumns]
  const extraConfig = extraConfigBuilder?.(extraConfigColumns) ?? []
  const primaryKey = (Array.isArray(extraConfig) ? extraConfig : Object.values(extraConfig)).find((item) => item instanceof PrimaryKeyBuilder) as
    | { columns: { name: string }[] }
    | undefined
  const names = primaryKey?.columns.map((column) => column.name) ?? []
  if (names.length) {
    return names.map((name) => {
      const entry = Object.entries(columns).find(([, column]) => column.name === name)
      if (!entry) throw new Error(`Primary key column "${name}" not found for table "${getTableName(table as never)}"`)
      return { key: entry[0], column: entry[1] }
    })
  }

  throw new Error(`Primary key not found for table "${getTableName(table as never)}"`)
}

function parseCompositeId(id: unknown): Record<string, unknown> {
  if (id && typeof id === 'object' && !Array.isArray(id)) return id as Record<string, unknown>
  if (typeof id === 'string') {
    const value = JSON.parse(id)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  throw new Error('Composite primary key id must be an object or JSON object string')
}

function getReturnedId(row: unknown, primaryKey: { key: string; column: AnyColumn }[]) {
  return getRowId(row, primaryKey)
}

function getRowId(row: unknown, primaryKey: { key: string; column: AnyColumn }[]) {
  if (!row || typeof row !== 'object') return undefined
  if (primaryKey.length === 1) return ((row as Record<string, unknown>)[primaryKey[0].key] ?? (row as Record<string, unknown>)[primaryKey[0].column.name]) as string
  return Object.fromEntries(primaryKey.map(({ key, column }) => [key, (row as Record<string, unknown>)[key] ?? (row as Record<string, unknown>)[column.name]]))
}

export function createDrizzleModel<TTable, TRecord, TCreate, TUpdate>({
  table,
  ...config
}: CreateDrizzleSourceConfig<TRecord, TCreate, TUpdate> & { table: TTable }): ModelRuntimeEntity<TTable> {
  return {
    name: getTableName(table as never),
    table,
    source: createDrizzleSource({ ...config, table }),
  }
}

export function createDrizzleModelFactory(db: unknown) {
  return <TTable, TRecord, TCreate, TUpdate>(config: Omit<CreateDrizzleSourceConfig<TRecord, TCreate, TUpdate>, 'db'> & { table: TTable }) =>
    createDrizzleModel({ ...config, db })
}
