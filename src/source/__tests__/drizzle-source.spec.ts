import { defineRelationsPart, sql } from 'drizzle-orm'
import { PgDialect, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { createEntity, defineDomainPart, defineDomainSchema } from '../../model'
import { createDrizzleSource } from '../drizzle-source'

const sqlText = (fragment: unknown) => new PgDialect().sqlToQuery(fragment as never).sql

const products = pgTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }),
})

const variants = pgTable('variants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const productVariants = pgTable(
  'product_variants',
  {
    productId: text('product_id').notNull(),
    variantId: text('variant_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.variantId] })],
)

const variant = createEntity({
  table: variants,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

const product = createEntity({
  table: products,
  schemas: {
    create: z.object({ id: z.string(), name: z.string(), variants: z.array(z.object({ id: z.string() })).optional() }),
    update: z.object({ name: z.string().optional(), variants: z.array(z.object({ id: z.string() })).optional() }),
    select: z.object({ id: z.string(), name: z.string(), createdAt: z.string().nullable().optional(), variants: z.array(variant.schemas.select) }),
  },
})

const relations = defineRelationsPart({ products, variants, productVariants }, (r) => ({
  products: {
    variants: r.many.variants({
      from: r.products.id.through(r.productVariants.productId),
      to: r.variants.id.through(r.productVariants.variantId),
    }),
  },
}))

const domainSchema = defineDomainSchema([
  defineDomainPart({ tables: { products, productVariants }, entities: [product], relations: [relations] }),
  defineDomainPart({ tables: { variants }, entities: [variant] }),
])

describe('createDrizzleSource', () => {
  it('answers 400 when an equality filter cannot match its column type', async () => {
    const source = createDrizzleSource({
      db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) }) }) }) },
      table: products,
      domainSchema,
      entity: product,
      schemas: product.schemas,
    })
    await expect(source.list({ query: { createdAt: 'banana' }, context: undefined as never })).rejects.toMatchObject({ code: 'validation_error' })
    await source.list({ query: { createdAt: '2026-01-01T00:00:00.000Z' }, context: undefined as never })
  })
  it('writes through-table assignments and materializes target rows', async () => {
    const productRows: Record<string, unknown>[] = []
    let assignmentRows: Record<string, unknown>[] = []
    const variantRows = [
      { id: 'body', name: 'Body' },
      { id: 'soap', name: 'Soap' },
      { id: 'brand-a', name: 'Brand A' },
    ]
    const source = createDrizzleSource({
      db: {
        query: {
          products: {
            findFirst: async () => {
              const row = productRows[0]
              return row
                ? {
                    ...row,
                    variants: assignmentRows.map((assignment) => variantRows.find((variant) => variant.id === assignment.variantId)),
                  }
                : undefined
            },
          },
        },
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [productRows[0]],
              then: (resolve: (value: unknown[]) => void) => resolve(productRows),
            }),
            then: (resolve: (value: unknown[]) => void) => resolve(productRows),
          }),
        }),
        insert: (table: unknown) => ({
          values: (input: unknown) => ({
            returning: async () => {
              if (table === products) {
                productRows.push(input as Record<string, unknown>)
                return [input]
              }
              assignmentRows.push(...(Array.isArray(input) ? input : [input]) as Record<string, unknown>[])
              return Array.isArray(input) ? input : [input]
            },
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({ returning: async () => productRows }),
          }),
        }),
        delete: () => ({
          where: () => ({
            returning: async () => {
              assignmentRows = []
              return []
            },
          }),
        }),
      },
      table: products,
      domainSchema,
      entity: product,
      schemas: product.schemas,
    })

    await source.create({ input: { id: 'product-1', name: 'Body Soap', variants: [{ id: 'body' }, { id: 'soap' }, { id: 'soap' }] }, context: undefined as never })
    expect(assignmentRows).toEqual([
      { productId: 'product-1', variantId: 'body' },
      { productId: 'product-1', variantId: 'soap' },
    ])

    const updated = await source.update({ id: 'product-1', input: { variants: [{ id: 'brand-a' }] }, context: undefined as never })
    expect(updated).toEqual({ id: 'product-1', name: 'Body Soap', variants: [{ id: 'brand-a', name: 'Brand A' }] })
    expect(assignmentRows).toEqual([{ productId: 'product-1', variantId: 'brand-a' }])
  })
})

const owners = pgTable('owners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const children = pgTable('children', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
})

const child = createEntity({
  table: children,
  schemas: {
    create: z.object({ id: z.string() }),
    update: z.object({ id: z.string() }),
    select: z.object({ id: z.string(), ownerId: z.string().nullable() }),
  },
})

const owner = createEntity({
  table: owners,
  schemas: {
    create: z.object({ id: z.string(), name: z.string(), children: z.array(z.object({ id: z.string() })).optional() }),
    update: z.object({ name: z.string().optional(), children: z.array(z.object({ id: z.string() })).optional() }),
    select: z.object({ id: z.string(), name: z.string(), children: z.array(child.schemas.select) }),
  },
})

const ownerRelations = defineRelationsPart({ owners, children }, (r) => ({
  owners: {
    children: r.many.children({ from: r.owners.id, to: r.children.ownerId }),
  },
}))

const ownerDomainSchema = defineDomainSchema([
  defineDomainPart({ tables: { owners, children }, entities: [owner, child], relations: [ownerRelations] }),
])

type Statement = { on: string; kind: string }

/**
 * Mock db that records which db object (`base` or `tx`) each statement ran on,
 * and can be told to throw on the first statement of a given kind.
 */
function createRecordingDb({ supportsTransaction = true, throwOn }: { supportsTransaction?: boolean; throwOn?: string } = {}) {
  const statements: Statement[] = []

  const build = (on: string) => {
    const record = async <T>(kind: string, value: T): Promise<T> => {
      statements.push({ on, kind })
      if (throwOn === kind) throw new Error(`statement "${kind}" failed`)
      return value
    }

    const db: Record<string, unknown> = {
      query: {
        owners: { findFirst: async () => (await record('materialize', { id: 'owner-1', name: 'Owner', children: [{ id: 'child-1', ownerId: 'owner-1' }] })) },
        products: { findFirst: async () => (await record('materialize', { id: 'product-1', name: 'Body Soap', variants: [] })) },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => record('select', [{ id: 'owner-1', name: 'Owner' }]),
            then: (resolve: (value: unknown[]) => void) => record('select', [{ id: 'owner-1', name: 'Owner' }]).then(resolve),
          }),
          then: (resolve: (value: unknown[]) => void) => record('select', [{ id: 'owner-1', name: 'Owner' }]).then(resolve),
        }),
      }),
      insert: () => ({ values: (input: unknown) => ({ returning: async () => record('insert', Array.isArray(input) ? input : [input]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => record('update', [{ id: 'owner-1', name: 'Owner' }]) }) }) }),
      delete: () => ({ where: () => ({ returning: async () => record('delete', []) }) }),
    }

    return db
  }

  const base = build('base')
  if (supportsTransaction) {
    base.transaction = async <T>(fn: (tx: unknown) => Promise<T>) => {
      statements.push({ on: 'base', kind: 'transaction' })
      return fn(build('tx'))
    }
  }

  return { db: base, statements }
}

describe('createDrizzleSource transactions', () => {
  it('runs a failing through-relation create inside a transaction and propagates the error', async () => {
    const { db, statements } = createRecordingDb({ throwOn: 'insert' })
    const source = createDrizzleSource({ db, table: products, domainSchema, entity: product, schemas: product.schemas })

    await expect(
      source.create({ input: { id: 'product-1', name: 'Body Soap', variants: [{ id: 'body' }] }, context: undefined as never }),
    ).rejects.toThrow('statement "insert" failed')

    expect(statements[0]).toEqual({ on: 'base', kind: 'transaction' })
    expect(statements.slice(1).every((statement) => statement.on === 'tx')).toBe(true)
  })

  it('runs every update statement for an array relation on the transaction', async () => {
    const { db, statements } = createRecordingDb()
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    const updated = await source.update({ id: 'owner-1', input: { name: 'Owner', children: [{ id: 'child-1' }] }, context: undefined as never })

    expect(updated).toEqual({ id: 'owner-1', name: 'Owner', children: [{ id: 'child-1', ownerId: 'owner-1' }] })
    expect(statements[0]).toEqual({ on: 'base', kind: 'transaction' })
    expect(statements.slice(1).map((statement) => statement.kind)).toEqual(['update', 'update', 'update', 'materialize'])
    expect(statements.slice(1).every((statement) => statement.on === 'tx')).toBe(true)
  })

  it('falls back to direct statements when the db has no transaction support', async () => {
    const { db, statements } = createRecordingDb({ supportsTransaction: false })
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    const created = await source.create({ input: { id: 'owner-1', name: 'Owner', children: [{ id: 'child-1' }] }, context: undefined as never })

    expect(created).toEqual({ id: 'owner-1', name: 'Owner', children: [{ id: 'child-1', ownerId: 'owner-1' }] })
    expect(statements.every((statement) => statement.on === 'base')).toBe(true)
  })
})

const memberships = pgTable(
  'memberships',
  {
    ownerId: text('owner_id').notNull(),
    childId: text('child_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.childId] })],
)

const membership = createEntity({
  table: memberships,
  schemas: {
    create: z.object({ ownerId: z.string(), childId: z.string() }),
    update: z.object({ childId: z.string() }),
    select: z.object({ ownerId: z.string(), childId: z.string(), owner: owner.schemas.select.nullable() }),
  },
})

const membershipRelations = defineRelationsPart({ memberships, owners, children }, (r) => ({
  owners: {
    children: r.many.children({ from: r.owners.id, to: r.children.ownerId }),
  },
  memberships: {
    owner: r.one.owners({ from: r.memberships.ownerId, to: r.owners.id }),
  },
}))

const membershipDomainSchema = defineDomainSchema([
  defineDomainPart({ tables: { memberships, owners, children }, entities: [membership, owner, child], relations: [membershipRelations] }),
])

const ownerRow = (id: string, name = 'Owner') => ({ id, name, children: [] })

/** Mock db that records the relational-query configs and the count query it was asked to run. */
function createQueryDb(rows: Record<string, unknown>[]) {
  const calls: { findMany: unknown[]; findFirst: unknown[]; countWhere: unknown[] } = { findMany: [], findFirst: [], countWhere: [] }

  const builder = (fields: unknown) => {
    const chain: Record<string, unknown> = {
      where: (condition: unknown) => {
        if (fields) calls.countWhere.push(condition)
        return chain
      },
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      then: (resolve: (value: unknown[]) => void) => resolve(fields ? [{ value: rows.length }] : rows),
    }
    return chain
  }

  const db = {
    query: {
      owners: {
        findMany: async (config?: unknown) => {
          calls.findMany.push(config)
          return rows
        },
        findFirst: async (config?: unknown) => {
          calls.findFirst.push(config)
          return rows[0]
        },
      },
      memberships: {
        findMany: async (config?: unknown) => {
          calls.findMany.push(config)
          return rows
        },
        findFirst: async (config?: unknown) => {
          calls.findFirst.push(config)
          return rows[0]
        },
      },
    },
    select: (fields?: unknown) => ({ from: () => builder(fields) }),
    insert: () => ({ values: () => ({ returning: async () => rows }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => rows }) }) }),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
  }

  return { db, calls }
}

describe('createDrizzleSource list queries', () => {
  it('applies pagination, sorting, filters and search, and counts with the same predicate', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    const result = await source.list({
      query: { page: '2', limit: '5', sort: 'name', order: 'desc', search: 'own', id: 'owner-1' },
      context: undefined as never,
    })

    expect(result).toEqual({ data: [{ id: 'owner-1', name: 'Owner', children: [] }], total: 1 })
    expect(calls.findMany).toHaveLength(1)
    const findManyConfig = calls.findMany[0] as { orderBy?: unknown }
    expect(findManyConfig.orderBy).toBeTypeOf('function')
    const sortTerms = (findManyConfig.orderBy as (table: unknown) => unknown[])(owners) as unknown[]
    expect(sqlText(sortTerms[0])).toContain('"name" desc')
    expect(sqlText(sortTerms[1])).toContain('"id" asc')
    expect(calls.findMany[0]).toMatchObject({
      limit: 5,
      offset: 5,
      where: { AND: [{ id: 'owner-1' }, { OR: [{ id: { ilike: '%own%' } }, { name: { ilike: '%own%' } }] }] },
      with: { children: true },
    })
    expect(calls.countWhere).toHaveLength(1)
  })

  it('appends primary-key tie-break terms after the client sort', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    await source.list({ query: { sort: 'name' }, context: undefined as never })

    const orderBy = (calls.findMany[0] as { orderBy: (table: unknown) => unknown }).orderBy
    const terms = orderBy(owners) as unknown[]
    expect(terms).toHaveLength(2)
    expect(sqlText(terms[0])).toContain('"name" asc')
    expect(sqlText(terms[1])).toContain('"id" asc')
  })

  it('orders unsorted lists by the primary key alone', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    await source.list({ query: {}, context: undefined as never })

    const orderBy = (calls.findMany[0] as { orderBy: (table: unknown) => unknown }).orderBy
    const terms = orderBy(owners) as unknown[]
    expect(terms).toHaveLength(1)
    expect(sqlText(terms[0])).toContain('"id" asc')
  })

  it('appends every composite primary-key column as tie-break terms', async () => {
    const membershipRow = { ownerId: 'owner-1', childId: 'child-1', owner: ownerRow('owner-1') }
    const { db, calls } = createQueryDb([membershipRow])
    const source = createDrizzleSource({ db, table: memberships, domainSchema: membershipDomainSchema, entity: membership, schemas: membership.schemas })

    await source.list({ query: { sort: 'ownerId' }, context: undefined as never })

    const orderBy = (calls.findMany[0] as { orderBy: (table: unknown) => unknown }).orderBy
    const terms = orderBy(memberships) as unknown[]
    expect(terms).toHaveLength(3)
    expect(sqlText(terms[1])).toContain('"owner_id" asc')
    expect(sqlText(terms[2])).toContain('"child_id" asc')
  })

  it('rejects unknown filter keys and unknown sort columns', async () => {
    const { db } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    await expect(source.list({ query: { category: 'tools' }, context: undefined as never })).rejects.toThrow('Unknown query parameter "category".')
    await expect(source.list({ query: { sort: 'category' }, context: undefined as never })).rejects.toThrow('Unknown sort column "category".')
  })

  it('ANDs a server-owned scope with query filters in the row and count predicates', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })
    const scope = sql`${owners.name} <> 'hidden'`

    await source.list({ query: { id: 'owner-1' }, where: scope, context: undefined as never })

    expect(calls.findMany[0]).toMatchObject({ where: { AND: [{ id: 'owner-1' }, { RAW: scope }] }, with: { children: true } })
    expect(calls.countWhere).toHaveLength(1)
    expect(calls.countWhere[0]).toBeDefined()
  })

  it('applies a server-owned scope alone when the query has no filters', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })
    const scope = sql`${owners.name} <> 'hidden'`

    await source.list({ query: {}, where: scope, context: undefined as never })

    expect(calls.findMany[0]).toMatchObject({ where: { RAW: scope } })
    expect(calls.countWhere).toHaveLength(1)
  })

  it('keeps list queries unchanged without a scope channel value', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    const result = await source.list({ query: { id: 'owner-1' }, context: undefined as never })

    expect(result).toEqual({ data: [ownerRow('owner-1')], total: 1 })
    expect(calls.findMany[0]).toMatchObject({ where: { id: 'owner-1' }, with: { children: true } })
  })

  it('treats an empty equality value as absent', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    await source.list({ query: { id: '' }, context: undefined as never })

    expect(calls.findMany[0]).toMatchObject({ with: { children: true } })
    expect(calls.countWhere).toHaveLength(0)
  })

  it('reads detail with one relational query', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    expect(await source.detail({ id: 'owner-1', context: undefined as never })).toEqual({ id: 'owner-1', name: 'Owner', children: [] })
    expect(calls.findFirst).toEqual([{ where: { id: 'owner-1' }, with: { children: true } }])
  })

  it('materializes arrays with one batched query in input order', async () => {
    const { db, calls } = createQueryDb([ownerRow('owner-2', 'Second'), ownerRow('owner-1')])
    const source = createDrizzleSource({ db, table: owners, domainSchema: ownerDomainSchema, entity: owner, schemas: owner.schemas })

    const materialized = await source.materialize([{ id: 'owner-1' }, { id: 'owner-2' }], { context: undefined as never })

    expect(materialized).toEqual([ownerRow('owner-1'), ownerRow('owner-2', 'Second')])
    expect(calls.findMany).toEqual([{ where: { id: { in: ['owner-1', 'owner-2'] } }, with: { children: true } }])
    expect(calls.findFirst).toHaveLength(0)
  })

  it('falls back to per-row materialization for composite primary keys', async () => {
    const membershipRow = { ownerId: 'owner-1', childId: 'child-1', owner: ownerRow('owner-1') }
    const { db, calls } = createQueryDb([membershipRow])
    const source = createDrizzleSource({ db, table: memberships, domainSchema: membershipDomainSchema, entity: membership, schemas: membership.schemas })

    const materialized = await source.materialize([membershipRow, membershipRow], { context: undefined as never })

    expect(materialized).toEqual([membershipRow, membershipRow])
    expect(calls.findFirst).toHaveLength(2)
    expect(calls.findMany).toHaveLength(0)
  })
})

const stamped = pgTable('stamped', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdByUserId: text('created_by_user_id'),
  updatedByUserId: text('updated_by_user_id'),
})

const strictStamped = createEntity({
  table: stamped,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

const looseStamped = createEntity({
  table: stamped,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }).passthrough(),
    update: z.object({ name: z.string().optional() }).passthrough(),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

function createScopedWriteDb() {
  const conditions: { select: unknown[]; update: unknown[]; delete: unknown[] } = { select: [], update: [], delete: [] }
  const row = { id: 'stamped-1', name: 'Hammer' }
  const db = {
    select: () => {
      const builder = {
        from: () => builder,
        where: (condition: unknown) => {
          conditions.select.push(condition)
          return builder
        },
        limit: async () => [row],
      }
      return builder
    },
    update: () => ({
      set: () => ({
        where: (condition: unknown) => {
          conditions.update.push(condition)
          return { returning: async () => [row] }
        },
      }),
    }),
    delete: () => ({
      where: (condition: unknown) => {
        conditions.delete.push(condition)
        return { returning: async () => [row] }
      },
    }),
  }
  return { db, conditions }
}

describe('createDrizzleSource server-owned write scope', () => {
  it('ANDs the primary key and scope for update, empty update, and delete', async () => {
    const { db, conditions } = createScopedWriteDb()
    const source = createDrizzleSource({ db, table: stamped, schemas: strictStamped.schemas })
    const scope = sql`${stamped.name} <> 'hidden'`

    await source.update({ id: 'stamped-1', input: { name: 'Hammer' }, where: scope, context: undefined as never })
    await source.update({ id: 'stamped-1', input: {}, where: scope, context: undefined as never })
    await source.delete({ id: 'stamped-1', where: scope, context: undefined as never })

    expect(sqlText(conditions.update[0])).toContain('"stamped"."id"')
    expect(sqlText(conditions.update[0])).toContain('"stamped"."name"')
    expect(sqlText(conditions.select[0])).toContain('"stamped"."id"')
    expect(sqlText(conditions.select[0])).toContain('"stamped"."name"')
    expect(sqlText(conditions.delete[0])).toContain('"stamped"."id"')
    expect(sqlText(conditions.delete[0])).toContain('"stamped"."name"')
  })
})

/** Mock db that records the exact insert values and update SET payloads; returning returns full rows. */
function createWriteRecordingDb() {
  const inserts: Record<string, unknown>[] = []
  const updates: Record<string, unknown>[] = []
  const rows = new Map<string, Record<string, unknown>>([['stamped-1', { id: 'stamped-1', name: 'Wrench' }]])
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ offset: async () => [] }) }),
        then: (resolve: (value: unknown[]) => void) => resolve([]),
      }),
    }),
    insert: () => ({
      values: (input: unknown) => ({
        returning: async () => {
          const row = input as Record<string, unknown>
          inserts.push({ ...row })
          rows.set(String(row.id), { ...row })
          return [row]
        },
      }),
    }),
    update: () => ({
      set: (input: unknown) => ({
        where: () => ({
          returning: async () => {
            updates.push({ ...(input as Record<string, unknown>) })
            const stored = rows.get('stamped-1') ?? {}
            Object.assign(stored, input)
            return [stored]
          },
        }),
      }),
    }),
  }
  return { db, inserts, updates }
}

describe('createDrizzleSource server-owned write values', () => {
  it('merges values into the inserted row on create', async () => {
    const { db, inserts } = createWriteRecordingDb()
    const source = createDrizzleSource({ db, table: stamped, schemas: strictStamped.schemas })

    await source.create({
      input: { id: 'stamped-1', name: 'Wrench' },
      values: { createdByUserId: 'user-1' },
      context: undefined as never,
    })

    expect(inserts[0]).toEqual({ id: 'stamped-1', name: 'Wrench', createdByUserId: 'user-1' })
  })

  it('merges values into the update SET payload', async () => {
    const { db, updates } = createWriteRecordingDb()
    const source = createDrizzleSource({ db, table: stamped, schemas: strictStamped.schemas })

    await source.update({
      id: 'stamped-1',
      input: { name: 'Hammer' },
      values: { updatedByUserId: 'user-2' },
      context: undefined as never,
    })

    expect(updates[0]).toEqual({ name: 'Hammer', updatedByUserId: 'user-2' })
  })

  it('resolves a client-sent key colliding with values to the values side on create and update', async () => {
    const { db, inserts, updates } = createWriteRecordingDb()
    const source = createDrizzleSource({ db, table: stamped, schemas: looseStamped.schemas })

    await source.create({
      input: { id: 'stamped-1', name: 'Wrench', createdByUserId: 'forger' },
      values: { createdByUserId: 'user-1' },
      context: undefined as never,
    })
    await source.update({
      id: 'stamped-1',
      input: { name: 'Hammer', updatedByUserId: 'forger' },
      values: { updatedByUserId: 'user-2' },
      context: undefined as never,
    })

    expect(inserts[0]).toEqual({ id: 'stamped-1', name: 'Wrench', createdByUserId: 'user-1' })
    expect(updates[0]).toEqual({ name: 'Hammer', updatedByUserId: 'user-2' })
  })

  it('reproduces today payloads when values is omitted', async () => {
    const { db, inserts, updates } = createWriteRecordingDb()
    const source = createDrizzleSource({ db, table: stamped, schemas: strictStamped.schemas })

    await source.create({ input: { id: 'stamped-1', name: 'Wrench' }, context: undefined as never })
    await source.update({ id: 'stamped-1', input: { name: 'Hammer' }, context: undefined as never })

    expect(inserts[0]).toEqual({ id: 'stamped-1', name: 'Wrench' })
    expect(updates[0]).toEqual({ name: 'Hammer' })
  })
})
