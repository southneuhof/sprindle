# @southneuhof/sprindle

> This repository is a read-only mirror of the package source from
> https://github.com/southneuhof/carta.
>
> Please open issues and pull requests against the Carta monorepo.

Backend framework primitives for South Neuhof information systems. Sprindle is a thin layer over
[Hono](https://hono.dev) and [Drizzle](https://orm.drizzle.team): declare a table, its Zod schemas,
canonical resource constructors, and true custom HTTP routes. Sprindle mounts the routes, runs a fixed
request pipeline, and holds one wire contract for payloads and errors.

## Philosophy

- **Thin over Hono** — Sprindle mounts Hono routes; middleware and custom handlers stay ordinary Hono.
- **Types over codegen** — clients get types from `hc<AppType>` inference; there is no generator.
- **Fail loud at boot** — schema and relation mistakes throw while the app builds, with the fix in the
  message.
- **One contract** — every canonical route answers the same envelopes, every error the same shape.
- **Closed vocabulary** — existing, platform, or plain-English names only; no coined nouns.

## Example

```ts
import { Hono } from 'hono'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import { createEntity, defineModel } from '@southneuhof/sprindle/model'
import { authenticated, create, detail, list, update } from '@southneuhof/sprindle/routes'
import { installSprindle, requestContext, sprindleNotFound, sprindleOnError } from '@southneuhof/sprindle/hono'

export const items = pgTable('items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

export const item = createEntity({
  table: items,
  schemas: {
    create: z.object({ id: z.string(), name: z.string() }),
    update: z.object({ name: z.string().optional() }),
    select: z.object({ id: z.string(), name: z.string() }),
  },
})

export const itemModel = defineModel({
  path: '/items',
  entity: item,
  enrich: {
    schema: z.object({ id: z.string(), name: z.string(), label: z.string() }),
    run: (record) => ({ ...record, label: record.name.toUpperCase() }),
  },
  authorize: [authenticated()],
  routes: { list: list(), detail: detail(), create: create(), update: update() },
})

export const app = installSprindle(
  new Hono().onError(sprindleOnError).notFound(sprindleNotFound).use('*', requestContext()),
  [itemModel] as const,
  { identity: (c) => resolveSession(c) },
)

export type AppType = typeof app
```

That serves `GET /items/list`, `GET /items/detail/:id`, `POST /items/create` and
`PATCH /items/update/:id`, each behind a session check, answering `{ data, page, limit, total }` on
lists and `{ error, message?, issues? }` on failures.

Constructor `run` callbacks keep the HTTP contract but own the custom persistence they perform.
Create/update runs apply `state.values` after client input; scoped list/update/delete runs apply
`state.where` when used. Update returns `undefined` for not found; delete throws `notFound()` when
no valid row is affected. Sprindle cannot enforce these source rules for arbitrary SQL, so add a
focused domain test.

## Subpaths

| Import | Contents |
|---|---|
| `@southneuhof/sprindle` | errors (`HttpError`, `validationError`, …) plus model/routes/source/validation re-exports |
| `.../model` | `createEntity`, `defineDomainPart`, `defineDomainSchema`, `defineModel` |
| `.../routes` | `defineRoute`, canonical route factories, `authenticated()` |
| `.../source` | `ModelSource`, `createDrizzleSource` |
| `.../hono` | `installSprindle`, `requestContext`, `sprindleOnError`, `sprindleNotFound` |
| `.../validation` | `listQuerySchema`, `idParamSchema` |
| `.../testing` | `createMemorySource`, `createTestEntity`, `testApp` |
| `.../openapi` | `generateOpenApi`, `openapiRoute` |

## Documentation

- [Reference](docs/reference.md) — vocabulary, request lifecycle, wire contracts, extension points.
- [Recipes](docs/recipes.md) — what is deliberately app-level, and how to build it.
