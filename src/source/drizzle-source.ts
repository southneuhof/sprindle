import { and, eq, getTableColumns, getTableName, Table } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { PrimaryKeyBuilder } from 'drizzle-orm/pg-core'
import type { DomainEntity, DomainSchema } from '../model/domain-schema'
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
      }
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
  const primaryKeyColumns = primaryKey.map((entry) => entry.column)
  const tableKey = entity && domainSchema?.tableKeyByEntity.get(entity)
  const relationFields = entity ? (domainSchema?.relationFieldsByEntity.get(entity) ?? []) : []
  const withRelations = relationFields.length ? Object.fromEntries(relationFields.map((field) => [field, true])) : undefined
  const wherePrimaryKey = (id: unknown) => {
    const values = primaryKey.length === 1 ? { [primaryKey[0].key]: id } : parseCompositeId(id)
    return and(...primaryKey.map(({ key, column }) => eq(column, values[key])))
  }
  const wherePrimaryKeyObject = (id: unknown) => {
    if (primaryKey.length === 1) return { [primaryKey[0].key]: id }
    return parseCompositeId(id)
  }

  return {
    async list() {
      const rows = tableKey && withRelations ? await database.query?.[tableKey]?.findMany({ with: withRelations }) : await database.select().from(table)
      if (!rows) throw new Error(`Drizzle relational query not found for table "${tableKey}".`)
      return { data: rows.map((row) => schemas.select.parse(row)) }
    },
    async detail({ id }) {
      if (tableKey && withRelations) {
        const row = await database.query?.[tableKey]?.findFirst({ where: wherePrimaryKeyObject(id), with: withRelations })
        return row ? schemas.select.parse(row) : null
      }
      const rows = await database.select().from(table).where(wherePrimaryKey(id)).limit(1)
      return rows[0] ? schemas.select.parse(rows[0]) : null
    },
    async create({ input }) {
      const rows = await database.insert(table).values(schemas.create.parse(input)).returning()
      if (rows[0] && tableKey && withRelations) return this.detail({ id: getReturnedId(rows[0], primaryKeyColumns) as never, context: undefined as never }) as Promise<TRecord>
      return schemas.select.parse(rows[0])
    },
    async update({ id, input }) {
      const rows = await database.update(table).set(schemas.update.parse(input)).where(wherePrimaryKey(id)).returning()
      if (rows[0] && tableKey && withRelations) return this.detail({ id, context: undefined as never }) as Promise<TRecord>
      return rows[0] ? schemas.select.parse(rows[0]) : null
    },
    async delete({ id }) {
      const rows = await database.delete(table).where(wherePrimaryKey(id)).returning()
      return Boolean(rows[0])
    },
  }
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

function getReturnedId(row: unknown, primaryKey: AnyColumn[]) {
  if (!row || typeof row !== 'object') return undefined
  if (primaryKey.length === 1) return (row as Record<string, unknown>)[primaryKey[0].name] as string
  return Object.fromEntries(primaryKey.map((column) => [column.name, (row as Record<string, unknown>)[column.name]]))
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
