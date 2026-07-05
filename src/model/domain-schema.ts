import { getTableColumns, getTableName, is, Many, One, Table } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { createDrizzleSource } from '../source/drizzle-source'
import type { ModelRuntimeEntity, ModelSource } from '../source/model-source'

const ENTITY_MARK = Symbol.for('@southneuhof/sprindle/entity')

type AnySchema = { parse: (input: unknown) => unknown }

type EntitySchemas = {
  create: AnySchema
  update: AnySchema
  select: AnySchema
}

export type DomainEntity<TTable = unknown, TSchemas extends EntitySchemas = EntitySchemas> = ModelRuntimeEntity<TTable> & {
  [ENTITY_MARK]: true
  schemas: TSchemas
  table: TTable
}

type CreateEntityConfig<TTable, TSchemas extends EntitySchemas> = {
  table: TTable
  schemas: TSchemas
  relations?: never
}

type DomainModule = Record<string, unknown>
type RelationConfig = { table: unknown; name?: string; relations: Record<string, unknown> }

export type DomainRelationField = {
  field: string
  targetEntity: DomainEntity
  isArray: boolean
  mode: 'direct' | 'through'
  sourceColumns: AnyColumn[]
  targetColumns: AnyColumn[]
  throughTable?: unknown
  throughSourceColumns?: AnyColumn[]
  throughTargetColumns?: AnyColumn[]
}

export type DomainSchema = {
  schema: Record<string, unknown>
  relations: Record<string, RelationConfig>
  entities: DomainEntity[]
  relationsByTable: Map<unknown, Record<string, unknown>>
  relationFieldsByEntity: Map<DomainEntity, string[]>
  relationMetadataByEntity: Map<DomainEntity, DomainRelationField[]>
  writeRelationMetadataByEntity: Map<DomainEntity, DomainRelationField[]>
  tableKeyByEntity: Map<DomainEntity, string>
}

export function createEntity<TTable, TSchemas extends EntitySchemas>(config: CreateEntityConfig<TTable, TSchemas>): DomainEntity<TTable, TSchemas> {
  if ('relations' in (config as Record<string, unknown>)) throw new Error('createEntity() does not accept relations.')

  return {
    [ENTITY_MARK]: true,
    name: getTableName(config.table as never),
    table: config.table,
    schemas: config.schemas,
    source: unboundSource(),
  }
}

export function isDomainEntity(value: unknown): value is DomainEntity {
  return Boolean(value && typeof value === 'object' && (value as { [ENTITY_MARK]?: true })[ENTITY_MARK])
}

export function defineDomainSchema(modules: DomainModule[]): DomainSchema {
  const schema: Record<string, unknown> = {}
  const relations: Record<string, RelationConfig> = {}
  const entities: DomainEntity[] = []
  const relationsByTable = new Map<unknown, Record<string, unknown>>()
  const relationFieldsByEntity = new Map<DomainEntity, string[]>()
  const relationMetadataByEntity = new Map<DomainEntity, DomainRelationField[]>()
  const writeRelationMetadataByEntity = new Map<DomainEntity, DomainRelationField[]>()
  const tableKeyByEntity = new Map<DomainEntity, string>()
  const entityByTable = new Map<unknown, DomainEntity>()
  const entityBySelectSchema = new Map<unknown, DomainEntity>()

  for (const module of modules) {
    for (const [key, value] of Object.entries(module)) {
      if (isDrizzleTable(value)) schema[key] = value
      if (isDomainEntity(value)) entities.push(value)
      if (isRelationConfigMap(value)) {
        for (const [relationKey, config] of Object.entries(value)) {
          const previous = relations[relationKey]
          relations[relationKey] = previous ? { ...config, relations: { ...previous.relations, ...config.relations } } : config
        }
      }
    }
  }

  for (const entity of entities) {
    entityByTable.set(entity.table, entity)
    entityBySelectSchema.set(entity.schemas.select, entity)
    const tableKey = Object.entries(schema).find(([, table]) => table === entity.table)?.[0]
    if (!tableKey) throw new Error(`Missing Drizzle table export for entity "${entity.name}".`)
    tableKeyByEntity.set(entity, tableKey)
  }

  for (const relation of Object.values(relations)) {
    relationsByTable.set(relation.table, relation.relations)
  }

  for (const entity of entities) {
    const { readRelations, writeRelations } = validateEntityRelations({ entity, relationsByTable, entityBySelectSchema, entityByTable })
    relationFieldsByEntity.set(
      entity,
      readRelations.map((relation) => relation.field),
    )
    relationMetadataByEntity.set(entity, readRelations)
    writeRelationMetadataByEntity.set(entity, writeRelations)
  }

  return { schema, relations, entities, relationsByTable, relationFieldsByEntity, relationMetadataByEntity, writeRelationMetadataByEntity, tableKeyByEntity }
}

export function bindDomainDatabase(domainSchema: DomainSchema, db: unknown) {
  for (const entity of domainSchema.entities) {
    entity.source = createDrizzleSource({
      db,
      table: entity.table,
      schemas: entity.schemas,
      domainSchema,
      entity,
    })
  }
}

function validateEntityRelations({
  entity,
  relationsByTable,
  entityBySelectSchema,
  entityByTable,
}: {
  entity: DomainEntity
  relationsByTable: Map<unknown, Record<string, unknown>>
  entityBySelectSchema: Map<unknown, DomainEntity>
  entityByTable: Map<unknown, DomainEntity>
}) {
  const readRelations: DomainRelationField[] = []
  const columns = getTableColumns(entity.table as never) as Record<string, unknown>
  const relations = relationsByTable.get(entity.table) ?? {}
  const aliases = new Map(
    Object.entries(relations)
      .map(([key, relation]) => [(relation as { alias?: string }).alias, key] as const)
      .filter(([alias]) => alias),
  )

  for (const [field, schema] of Object.entries(getZodShape(entity.schemas.select))) {
    if (field in columns) continue

    const aliasFor = aliases.get(field)
    if (aliasFor) throw new Error(`Invalid relation field "${field}" on entity "${entity.name}".\n\n"${field}" is a Drizzle alias. Use the relation key "${aliasFor}" in schemas.select.`)

    const nested = getNestedEntitySchema(schema, entityBySelectSchema)
    if (!nested) {
      throw new Error(`Unknown nested object field "${field}" on entity "${entity.name}".\n\nNested relation fields must use another entity's schemas.select.`)
    }

    const relation = relations[field]
    if (!relation) throw new Error(`Missing Drizzle relation for select field "${field}" on entity "${entity.name}".\nAdd a relation named "${field}" in defineRelationsPart().`)

    if (nested.isArray && !is(relation, Many)) {
      throw new Error(`Cardinality mismatch for relation "${field}" on entity "${entity.name}".\n\nDrizzle relation "${field}" is one, but schemas.select.${field} is an array.`)
    }
    if (!nested.isArray && !is(relation, One)) {
      throw new Error(`Cardinality mismatch for relation "${field}" on entity "${entity.name}".\n\nDrizzle relation "${field}" is many, but schemas.select.${field} is not an array.`)
    }
    const targetTable = (relation as { targetTable?: unknown }).targetTable
    if (targetTable !== nested.entity.table) {
      throw new Error(`Target entity mismatch for relation "${field}" on entity "${entity.name}".\n\nDrizzle relation "${field}" targets table "${getTableName(targetTable as never)}".\nschemas.select.${field} uses entity "${nested.entity.name}".`)
    }

    readRelations.push(createRelationField({ field, relation, targetEntity: nested.entity, isArray: nested.isArray, entityName: entity.name }))
  }

  const writeRelations = new Map(readRelations.map((relation) => [relation.field, relation]))
  for (const relation of [
    ...validateWriteSchema({ entity, schemaName: 'create', columns, relations, entityByTable }),
    ...validateWriteSchema({ entity, schemaName: 'update', columns, relations, entityByTable }),
  ]) {
    writeRelations.set(relation.field, relation)
  }

  return { readRelations, writeRelations: [...writeRelations.values()] }
}

function validateWriteSchema({
  entity,
  schemaName,
  columns,
  relations,
  entityByTable,
}: {
  entity: DomainEntity
  schemaName: 'create' | 'update'
  columns: Record<string, unknown>
  relations: Record<string, unknown>
  entityByTable: Map<unknown, DomainEntity>
}) {
  const relationFields: DomainRelationField[] = []
  for (const [field, schema] of Object.entries(getZodShape(entity.schemas[schemaName]))) {
    if (field in columns) continue

    const relation = relations[field]
    if (!relation) throw new Error(`Unknown ${schemaName} field "${field}" on entity "${entity.name}".\n\nNested write fields must match a Drizzle relation.`)

    const isArray = isZodArray(unwrapZod(schema))
    if (isArray && !is(relation, Many)) {
      throw new Error(`Cardinality mismatch for relation "${field}" on entity "${entity.name}".\n\nDrizzle relation "${field}" is one, but schemas.${schemaName}.${field} is an array.`)
    }
    if (!isArray && !is(relation, One)) {
      throw new Error(`Cardinality mismatch for relation "${field}" on entity "${entity.name}".\n\nDrizzle relation "${field}" is many, but schemas.${schemaName}.${field} is not an array.`)
    }

    const targetTable = (relation as { targetTable?: unknown }).targetTable
    const targetEntity = entityByTable.get(targetTable)
    if (!targetEntity) throw new Error(`Target entity missing for relation "${field}" on entity "${entity.name}".`)

    relationFields.push(createRelationField({ field, relation, targetEntity, isArray, entityName: entity.name }))
  }
  return relationFields
}

function createRelationField({
  field,
  relation,
  targetEntity,
  isArray,
  entityName,
}: {
  field: string
  relation: unknown
  targetEntity: DomainEntity
  isArray: boolean
  entityName: string
}): DomainRelationField {
  const throughTable = (relation as { throughTable?: unknown }).throughTable
  const through = (relation as { through?: { source: unknown[]; target: unknown[] } }).through
  return {
    field,
    targetEntity,
    isArray,
    mode: throughTable ? 'through' : 'direct',
    sourceColumns: getRelationColumns(relation, 'sourceColumns', field, entityName),
    targetColumns: getRelationColumns(relation, 'targetColumns', field, entityName),
    ...(throughTable
      ? {
          throughTable,
          throughSourceColumns: getThroughColumns(through?.source, field, entityName),
          throughTargetColumns: getThroughColumns(through?.target, field, entityName),
        }
      : {}),
  }
}

function getRelationColumns(relation: unknown, key: 'sourceColumns' | 'targetColumns', field: string, entityName: string): AnyColumn[] {
  const columns = (relation as { [K in typeof key]?: AnyColumn[] })[key]
  if (!columns?.length) throw new Error(`Missing ${key} for relation "${field}" on entity "${entityName}".`)
  return columns
}

function getThroughColumns(columns: unknown[] | undefined, field: string, entityName: string): AnyColumn[] {
  if (!columns?.length) throw new Error(`Missing through columns for relation "${field}" on entity "${entityName}".`)
  const resolved = columns.map((column) => (column as { _?: { column?: AnyColumn } })._?.column)
  if (resolved.some((column) => !column)) throw new Error(`Invalid through columns for relation "${field}" on entity "${entityName}".`)
  return resolved as AnyColumn[]
}

function getNestedEntitySchema(schema: unknown, entityBySelectSchema: Map<unknown, DomainEntity>) {
  const unwrapped = unwrapZod(schema)
  if (isZodArray(unwrapped)) {
    const entity = entityBySelectSchema.get(unwrapZod(getZodArrayElement(unwrapped)))
    return entity ? { entity, isArray: true } : undefined
  }
  const entity = entityBySelectSchema.get(unwrapped)
  return entity ? { entity, isArray: false } : undefined
}

function unwrapZod(schema: unknown): unknown {
  while (
    getZodDef(schema)?.type === 'optional' ||
    getZodDef(schema)?.type === 'nullable' ||
    getZodDef(schema)?.type === 'lazy' ||
    getZodDef(schema)?.typeName === 'ZodOptional' ||
    getZodDef(schema)?.typeName === 'ZodNullable' ||
    getZodDef(schema)?.typeName === 'ZodLazy'
  ) {
    schema = (schema as { unwrap?: () => unknown }).unwrap?.() ?? (getZodDef(schema)?.getter as (() => unknown) | undefined)?.() ?? getZodDef(schema)?.innerType
  }
  return schema
}

function getZodShape(schema: AnySchema): Record<string, unknown> {
  const shape = (schema as { shape?: unknown }).shape ?? getZodDef(schema)?.shape
  const value = typeof shape === 'function' ? shape() : shape
  if (!value || typeof value !== 'object') throw new Error('schemas.select must be a Zod object.')
  return value as Record<string, unknown>
}

function isZodArray(schema: unknown) {
  const def = getZodDef(schema)
  return def?.type === 'array' || def?.typeName === 'ZodArray'
}

function getZodArrayElement(schema: unknown) {
  const def = getZodDef(schema)
  return def?.element ?? def?.type
}

function getZodDef(schema: unknown): Record<string, unknown> | undefined {
  return ((schema as { _def?: unknown; def?: unknown })?._def ?? (schema as { def?: unknown })?.def) as Record<string, unknown> | undefined
}

function isDrizzleTable(value: unknown): value is Table {
  return is(value, Table)
}

function isRelationConfigMap(value: unknown): value is Record<string, RelationConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isDrizzleTable(value)) return false
  return Object.values(value).some(isRelationConfig)
}

function isRelationConfig(value: unknown): value is RelationConfig {
  return Boolean(
    value &&
      typeof value === 'object' &&
      isDrizzleTable((value as RelationConfig).table) &&
      (value as RelationConfig).relations &&
      typeof (value as RelationConfig).relations === 'object',
  )
}

function unboundSource(): ModelSource {
  const fail = async () => {
    throw new Error('Domain database is not bound. Call bindDomainDatabase() before model actions run.')
  }
  return { list: fail, detail: fail, create: fail, update: fail, delete: fail, materialize: fail }
}
