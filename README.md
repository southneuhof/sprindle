# @southneuhof/sprindle

Sprindle is the backend framework used by Carta. It builds on [Hono](https://hono.dev), [Drizzle ORM](https://orm.drizzle.team), and Zod to provide filesystem routing, resource operations, validation, persistence contracts, and consistent HTTP responses.

Application-specific business logic stays in the application. Hono, Drizzle, and ordinary TypeScript remain available when Sprindle's standard path does not fit.

## Getting started

Sprindle is normally used inside a [Carta](https://github.com/southneuhof/carta) application, where the package and route tooling are already configured.

API routes live under:

```text
apps/api/src/routes/
```

A route is a `+server.ts` file whose exported name defines the HTTP method:

```ts
// src/routes/health/+server.ts
import { defineRoute } from '@southneuhof/sprindle'

export const GET = defineRoute({
  action: () => ({ ok: true }),
})
```

This creates:

```text
GET /health
```

The file location defines the URL. `defineRoute` does not take a path or method.

## File routes

Directories map to URL segments:

```text
src/routes/
├── health/
│   └── +server.ts
└── items/
    ├── +server.ts
    └── [id]/
        └── +server.ts
```

This can expose:

```text
GET    /health
GET    /items
POST   /items
GET    /items/:id
PATCH  /items/:id
DELETE /items/:id
```

Parenthesized directories group routes without adding a URL segment:

```text
(authenticated)/
```

Bracketed directories define parameters:

```text
[id]/ → :id
```

## Scopes

A `+scope.ts` file supplies shared behavior to the routes below it.

```ts
// src/routes/(authenticated)/items/+scope.ts
import { authenticated, defineScope } from '@southneuhof/sprindle'
import { item } from '../../../items/items.entity'

export default defineScope({
  entity: item,
  authorize: authenticated(),
})
```

Scopes can provide an entity, context, authorization, identity resolution, enrichment, and request hooks.

Child routes inherit the nearest applicable scopes.

## Resource routes

Sprindle provides standard operations for database-backed resources:

```ts
import {
  create,
  deleteRoute,
  detail,
  list,
  update,
} from '@southneuhof/sprindle'
```

A collection route can be:

```ts
// src/routes/(authenticated)/items/+server.ts
import { create, list } from '@southneuhof/sprindle'

export const GET = list()
export const POST = create()
```

A record route can be:

```ts
// src/routes/(authenticated)/items/[id]/+server.ts
import {
  deleteRoute,
  detail,
  update,
} from '@southneuhof/sprindle'

export const GET = detail()
export const PATCH = update()
export const DELETE = deleteRoute()
```

The standard response contracts are:

| Operation       | Success                            |
| --------------- | ---------------------------------- |
| `list()`        | `200 { data, page, limit, total }` |
| `detail()`      | `200 { data }` or `404`            |
| `create()`      | `201 { data }`                     |
| `update()`      | `200 { data }` or `404`            |
| `deleteRoute()` | `200 { ok: true }` or `404`        |

Applications expose only the operations they need.

## Entities

An entity connects a Drizzle table to its Zod schemas.

```ts
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'
import {
  createEntity,
  defineDomainPart,
} from '@southneuhof/sprindle/model'

export const items = pgTable('items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

export const item = createEntity({
  table: items,
  schemas: {
    select: z.object({
      id: z.string(),
      name: z.string(),
    }),
    create: z.object({
      id: z.string(),
      name: z.string(),
    }),
    update: z.object({
      name: z.string().optional(),
    }),
  },
})

export const itemsDomain = defineDomainPart({
  tables: { items },
  entities: [item],
})
```

Entities do not define URLs. Routes and domain ownership are separate.

Applications combine their domain parts and bind them to a database:

```ts
import {
  bindDomainDatabase,
  defineDomainSchema,
} from '@southneuhof/sprindle/model'

const domain = defineDomainSchema([
  itemsDomain,
])

bindDomainDatabase(domain, db)
```

The bound entity then uses Sprindle's Drizzle-backed source for its standard operations.

## Custom routes

Use `defineRoute()` when an endpoint does not fit the standard resource operations.

```ts
import { defineRoute } from '@southneuhof/sprindle'

export const POST = defineRoute({
  action: async ({ context }) => {
    const result = await performOperation(context)

    return { data: result }
  },
})
```

Custom routes still inherit their surrounding scopes.

Use them for workflows, reports, exports, commands, or any endpoint with its own HTTP contract.

## Errors

Sprindle provides standard helpers such as:

```text
validationError
unauthorized
forbidden
notFound
```

Known HTTP errors use:

```json
{
  "error": "error_code",
  "message": "Optional message",
  "issues": []
}
```

Unhandled errors return:

```json
{
  "error": "internal_error"
}
```

## OpenAPI and route tooling

Sprindle can generate OpenAPI 3.1 documents from the route manifest:

```ts
import {
  generateInstalledOpenApi,
} from '@southneuhof/sprindle/openapi'

const document = generateInstalledOpenApi(c, {
  title: 'Example API',
  version: '1.0.0',
})
```

Sprindle also ships tooling for building, checking, and developing filesystem routes. Carta wires this into its normal development, build, and type-check commands.

Application code does not import generated route artifacts directly.

## Package exports

| Import                             | Purpose                                      |
| ---------------------------------- | -------------------------------------------- |
| `@southneuhof/sprindle`            | errors, models, routes, sources, validation  |
| `@southneuhof/sprindle/hono`       | Hono integration and route manifests         |
| `@southneuhof/sprindle/model`      | entities and domain schemas                  |
| `@southneuhof/sprindle/entity`     | browser-safe entity/schema surface           |
| `@southneuhof/sprindle/routes`     | file routes, scopes, and resource operations |
| `@southneuhof/sprindle/source`     | persistence contracts and Drizzle source     |
| `@southneuhof/sprindle/validation` | shared validation schemas                    |
| `@southneuhof/sprindle/openapi`    | OpenAPI generation                           |
| `@southneuhof/sprindle/testing`    | application testing helpers                  |
| `@southneuhof/sprindle/tooling`    | route tooling APIs                           |

## What stays in the application

Sprindle leaves application and deployment policy to the consumer, including file storage, background jobs, caching, rate limits, health checks, security headers, audit policy, seed data, and exports.

Use Hono, Drizzle, or application services for these concerns.

See [docs/recipes.md](docs/recipes.md) for examples.

## Documentation

* [Reference](docs/reference.md) covers routes, scopes, entities, sources, lifecycle, OpenAPI, errors, and tooling.
* [Recipes](docs/recipes.md) covers behavior intentionally left to applications.

Sprindle is developed in the [Carta monorepo](https://github.com/southneuhof/carta).
