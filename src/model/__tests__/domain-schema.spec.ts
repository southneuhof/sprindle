import { defineRelationsPart } from 'drizzle-orm'
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
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

const tags = pgTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const postTags = pgTable(
  'post_tags',
  {
    postId: text('post_id').notNull(),
    tagId: text('tag_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
)

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

const tag = createEntity({
  table: tags,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string() }),
    select: z.object({ id: z.string(), name: z.string() }),
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

const postTagRelations = defineRelationsPart({ posts, users, tags, postTags }, (r) => ({
  posts: {
    tags: r.many.tags({
      from: r.posts.id.through(r.postTags.postId),
      to: r.tags.id.through(r.postTags.tagId),
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

function postWithWriteSchemas(select: z.ZodRawShape, create: z.ZodRawShape, update: z.ZodRawShape = create) {
  return createEntity({
    table: posts,
    schemas: {
      create: z.object({ id: z.string(), authorId: z.string().nullable(), ...create }),
      update: z.object({ authorId: z.string().nullable(), ...update }),
      select: z.object({ id: z.string(), authorId: z.string().nullable(), ...select }),
    },
  })
}

function defineWith(post = postWithSelect({ author: user.schemas.select.nullable() }), relations: Record<string, unknown> = postRelations) {
  return defineDomainSchema([{ users, user }, { posts, post, relations }, { comments, comment }, { tags, tag }, { postTags }])
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
    expect(schema.entities).toEqual([user, post, comment, tag])
    expect(schema.relationsByTable.has(posts)).toBe(true)
    expect(schema.relationFieldsByEntity.get(post)).toEqual(['author', 'comments'])
    expect(schema.relationMetadataByEntity.get(post)).toMatchObject([
      { field: 'author', isArray: false, targetEntity: user },
      { field: 'comments', isArray: true, targetEntity: comment },
    ])
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

  it('accepts create and update relation fields that match select relations', () => {
    const post = postWithWriteSchemas(
      { author: user.schemas.select.nullable(), comments: z.array(comment.schemas.select) },
      { author: z.object({ id: z.string() }).nullable().optional(), comments: z.array(z.object({ id: z.string() })).optional() },
    )

    expect(defineWith(post).relationFieldsByEntity.get(post)).toEqual(['author', 'comments'])
  })

  it('accepts write-only relation fields missing from select relations', () => {
    const post = postWithWriteSchemas({ author: user.schemas.select.nullable() }, { comments: z.array(z.object({ id: z.string() })).optional() })

    expect(defineWith(post).writeRelationMetadataByEntity.get(post)).toMatchObject([{ field: 'author' }, { field: 'comments' }])
  })

  it('rejects create and update relation cardinality mismatches', () => {
    const post = postWithWriteSchemas({ comments: z.array(comment.schemas.select) }, { comments: z.object({ id: z.string() }).optional() })

    expect(() => defineWith(post)).toThrow('Drizzle relation "comments" is many')
  })

  it('infers through relation metadata for many-to-many writes', () => {
    const post = postWithWriteSchemas({ tags: z.array(tag.schemas.select) }, { tags: z.array(z.object({ id: z.string() })).optional() })

    expect(defineWith(post, postTagRelations).writeRelationMetadataByEntity.get(post)).toMatchObject([
      {
        field: 'tags',
        isArray: true,
        mode: 'through',
        targetEntity: tag,
        throughTable: postTags,
      },
    ])
  })
})
