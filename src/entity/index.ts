/**
 * Browser-safe entity surface.
 *
 * `./model` also exports runtime helpers. Entity modules only
 * need to pair a table with its schemas, and application code that reads those schemas — a form in
 * the browser, for example — must be able to import them without the server runtime coming along.
 * This subpath exposes exactly that pair and nothing else.
 */
import { getTableName } from 'drizzle-orm'
import type { z } from 'zod'
import type { CreateDrizzleSourceRead } from '../source/drizzle-source'
import type { ModelRuntimeEntity, ModelSource } from '../source/model-source'

const ENTITY_MARK = Symbol.for('@southneuhof/sprindle/entity')

type AnySchema = { parse: (input: unknown) => unknown }

type EntitySchemas = {
  create: AnySchema
  update: AnySchema
  select: AnySchema
}

type EntitySelectKey<TSchemas extends EntitySchemas> =
  [TSchemas['select']] extends [z.ZodType]
    ? keyof z.output<TSchemas['select']> & string
    : string;

export type DomainEntity<TTable = unknown, TSchemas extends EntitySchemas = EntitySchemas> = ModelRuntimeEntity<TTable> & {
  [ENTITY_MARK]: true
  schemas: TSchemas
  table: TTable
  read?: CreateDrizzleSourceRead<EntitySelectKey<TSchemas>>
}

type CreateEntityConfig<TTable, TSchemas extends EntitySchemas> = {
  table: TTable
  schemas: TSchemas
  read?: CreateDrizzleSourceRead<EntitySelectKey<TSchemas>>
  relations?: never
}

function unboundSource(): ModelSource {
  const fail = async () => {
    throw new Error('Domain database is not bound. Call bindDomainDatabase() before model routes run.')
  }
  return { list: fail, detail: fail, create: fail, update: fail, delete: fail, materialize: fail }
}

export function createEntity<TTable, const TSchemas extends EntitySchemas>(
  config: CreateEntityConfig<TTable, TSchemas>,
): DomainEntity<TTable, TSchemas> {
  if ('relations' in (config as Record<string, unknown>)) throw new Error('createEntity() does not accept relations.')

  return {
    [ENTITY_MARK]: true,
    name: getTableName(config.table as never),
    table: config.table,
    schemas: config.schemas,
    read: config.read,
    source: unboundSource(),
  } as unknown as DomainEntity<TTable, TSchemas>
}

export function isDomainEntity(value: unknown): value is DomainEntity {
  return Boolean(value && typeof value === 'object' && (value as { [ENTITY_MARK]?: true })[ENTITY_MARK])
}
