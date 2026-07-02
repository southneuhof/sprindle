import { defineRelationsPart } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEntity, defineDomainSchema } from '../domain-schema'

const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  authorId: text('author_id'),
})

const comments = pgTable('comments', {
  id: text('id').primaryKey(),
  postId: text('post_id'),
})

const user = createEntity({
  table: users,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

const comment = createEntity({
  table: comments,
  schemas: {
    create: z.object({ id: z.string(), postId: z.string().nullable() }),
    update: z.object({ postId: z.string().nullable() }),
    select: z.object({ id: z.string(), postId: z.string().nullable() }),
  },
})

const postRelations = defineRelationsPart({ posts, users, comments }, (r) => ({
  posts: {
    author: r.one.users({
      from: r.posts.authorId,
      to: r.users.id,
    }),
    comments: r.many.comments({
      from: r.posts.id,
      to: r.comments.postId,
    }),
  },
}))

const aliasedPostRelations = defineRelationsPart({ posts, users }, (r) => ({
  posts: {
    author: r.one.users({
      from: r.posts.authorId,
      to: r.users.id,
      alias: 'createdBy',
    }),
  },
}))

const badTargetRelations = defineRelationsPart({ posts, users, comments }, (r) => ({
  posts: {
    author: r.one.comments({
      from: r.posts.authorId,
      to: r.comments.id,
    }),
  },
}))

function postWithSelect(select: z.ZodRawShape) {
  return createEntity({
    table: posts,
    schemas: {
      create: z.object({ id: z.string(), authorId: z.string().nullable() }),
      update: z.object({ authorId: z.string().nullable() }),
      select: z.object({ id: z.string(), authorId: z.string().nullable(), ...select }),
    },
  })
}

function defineWith(post = postWithSelect({ author: user.schemas.select.nullable() }), relations: Record<string, unknown> = postRelations) {
  return defineDomainSchema([{ users, user }, { posts, post, relations }, { comments, comment }])
}

describe('defineDomainSchema', () => {
  it('discovers tables, relation parts, and entities from module exports', () => {
    const post = postWithSelect({
      author: user.schemas.select.nullable(),
      comments: z.array(z.lazy(() => comment.schemas.select)),
    })

    const schema = defineWith(post)

    expect(schema.schema).toMatchObject({ users, posts, comments })
    expect(schema.relations.posts).toBeTruthy()
    expect(schema.entities).toEqual([user, post, comment])
    expect(schema.relationsByTable.has(posts)).toBe(true)
    expect(schema.relationFieldsByEntity.get(post)).toEqual(['author', 'comments'])
  })

  it('rejects createEntity relations input', () => {
    expect(() =>
      createEntity({
        table: posts,
        relations: postRelations,
        schemas: { create: z.object({}), update: z.object({}), select: z.object({ id: z.string() }) },
      } as never),
    ).toThrow('createEntity() does not accept relations.')
  })

  it('rejects missing relation keys', () => {
    const post = postWithSelect({ createdBy: user.schemas.select.nullable() })

    expect(() => defineWith(post)).toThrow('Missing Drizzle relation for select field "createdBy"')
  })

  it('rejects alias-as-field-name', () => {
    const post = postWithSelect({ createdBy: user.schemas.select.nullable() })

    expect(() => defineWith(post, aliasedPostRelations)).toThrow('"createdBy" is a Drizzle alias')
  })

  it('rejects one/many cardinality mismatch', () => {
    const post = postWithSelect({ author: z.array(user.schemas.select) })

    expect(() => defineWith(post)).toThrow('Cardinality mismatch for relation "author"')
  })

  it('rejects target entity mismatch', () => {
    const post = postWithSelect({ author: user.schemas.select.nullable() })

    expect(() => defineWith(post, badTargetRelations)).toThrow('Target entity mismatch for relation "author"')
  })

  it('rejects unknown extra object fields', () => {
    const post = postWithSelect({ displayName: z.object({ value: z.string() }) })

    expect(() => defineWith(post)).toThrow('Unknown nested object field "displayName"')
  })
})
