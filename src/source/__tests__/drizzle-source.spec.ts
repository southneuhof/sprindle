import { defineRelationsPart } from 'drizzle-orm'
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEntity, defineDomainPart, defineDomainSchema } from '../../model'
import { createDrizzleSource } from '../drizzle-source'

const products = pgTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
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
    select: z.object({ id: z.string(), name: z.string(), variants: z.array(variant.schemas.select) }),
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
