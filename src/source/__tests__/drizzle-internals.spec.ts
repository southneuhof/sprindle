import { describe, expect, it } from 'vitest'
import { defineRelationsPart } from 'drizzle-orm'
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineDomainPart, defineDomainSchema } from '../../model'
import { getPrimaryKeyEntries, resolveThroughColumn } from '../drizzle-internals'

/**
 * Canary for drizzle-orm private-API access. If this fails after a drizzle bump,
 * fix `drizzle-internals.ts` — nothing else touches those internals.
 */

const singleKey = pgTable('single_key', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const compositeKey = pgTable(
  'composite_key',
  {
    leftId: text('left_id').notNull(),
    rightId: text('right_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leftId, t.rightId] })],
)

const keyless = pgTable('keyless', {
  name: text('name').notNull(),
})

describe('drizzle internals', () => {
  it('reads inline primary keys', () => {
    expect(getPrimaryKeyEntries(singleKey).map((entry) => entry.key)).toEqual(['id'])
  })

  it('reads composite primary keys declared in the extra config', () => {
    expect(getPrimaryKeyEntries(compositeKey).map((entry) => entry.key)).toEqual(['leftId', 'rightId'])
  })

  it('fails loudly for a table without a primary key', () => {
    expect(() => getPrimaryKeyEntries(keyless)).toThrow('Primary key not found for table "keyless"')
  })

  it('unwraps through-column references while building a domain schema', () => {
    const owners = pgTable('owners', { id: text('id').primaryKey(), name: text('name').notNull() })
    const tags = pgTable('tags', { id: text('id').primaryKey(), name: text('name').notNull() })
    const ownerTags = pgTable(
      'owner_tags',
      { ownerId: text('owner_id').notNull(), tagId: text('tag_id').notNull() },
      (t) => [primaryKey({ columns: [t.ownerId, t.tagId] })],
    )

    const tag = createEntity({
      table: tags,
      schemas: { create: z.object({ id: z.string() }), update: z.object({ name: z.string() }), select: z.object({ id: z.string(), name: z.string() }) },
    })
    const owner = createEntity({
      table: owners,
      schemas: {
        create: z.object({ id: z.string(), name: z.string() }),
        update: z.object({ name: z.string() }),
        select: z.object({ id: z.string(), name: z.string(), tags: z.array(tag.schemas.select) }),
      },
    })

    const relations = defineRelationsPart({ owners, tags, ownerTags }, (r) => ({
      owners: {
        tags: r.many.tags({ from: r.owners.id.through(r.ownerTags.ownerId), to: r.tags.id.through(r.ownerTags.tagId) }),
      },
    }))

    const schema = defineDomainSchema([defineDomainPart({ tables: { owners, tags, ownerTags }, entities: [owner, tag], relations: [relations] })])
    const relation = schema.writeRelationMetadataByEntity.get(owner)?.find((candidate) => candidate.field === 'tags')

    expect(relation?.mode).toBe('through')
    expect(relation?.throughSourceColumns?.map((column) => column.name)).toEqual(['owner_id'])
    expect(relation?.throughTargetColumns?.map((column) => column.name)).toEqual(['tag_id'])
    expect(resolveThroughColumn({ _: { column: singleKey.id } })?.name).toBe('id')
  })
})
