# Sprindle reference

Sprindle uses Hono, Drizzle, Zod, and file routes. The route directory is the
only source of HTTP locations.

## File routes

A `+server.ts` file exports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or
`OPTIONS`. Each export uses `defineRoute`, `list`, `detail`, `create`, `update`,
or `deleteRoute` from `@southneuhof/sprindle`. `defineRoute` takes `action` and
has no method or path option.

```ts
// src/routes/health/+server.ts
import { defineRoute } from '@southneuhof/sprindle'

export const GET = defineRoute({ action: () => ({ ok: true }) })
```

Normal directory names add URL segments. `(group)` names do not add a segment.
`[id]` adds `:id`. Static names can contain dots. `detail({})`, `update({})`,
and `deleteRoute({})` use `id`. Use `param: 'userId'` for another declared
parameter.

The nearest `+scope.ts` can supply `context`, `entity`, `enrich`, `identity`,
and pipeline hooks. Context fields from a child replace fields with the same
name from a parent. The runtime creates context for each request. It resolves
identity at most once. A parent authorization failure stops child context work.

```ts
// src/routes/(authenticated)/products/+scope.ts
import { authenticated, defineScope } from '@southneuhof/sprindle'
import { product } from '../../products/products.entity'

export default defineScope({ entity: product, authorize: authenticated() })
```

Canonical resource operations use the entity in the nearest scope. Their wire
contracts are:

| Helper | Method | Success |
|---|---|---|
| `list` | GET | 200 `{ data, page, limit, total }` |
| `detail` | GET | 200 `{ data }` or 404 |
| `create` | POST | 201 `{ data }` |
| `update` | PATCH | 200 `{ data }` or 404 |
| `deleteRoute` | DELETE | 200 `{ ok: true }` or 404 |

`run` changes persistence while the helper keeps parsing, status, enrichment,
and the response envelope. Scope enrichment converts a source record to its
public record first. Route enrichment receives that public record.

The operation order is scope context and authorization, route authorization,
state parsing, server write values, `before`, `validate`, action, and operation
`after`. Errors unwind through only the scopes that were entered. Hono
middleware owns headers, logging, cleanup, and other work for all responses.

GET supplies HEAD when no HEAD export exists. An explicit HEAD export takes
priority. Unsupported methods return 405 with `Allow`. Missing paths return 404.

## Domains and sources

`createEntity` joins a table to create, update, and select Zod schemas.
`defineDomainPart` groups tables and entities. Applications pass ordinary
domain parts to `defineDomainSchema` and `bindDomainDatabase`. Domain ownership
does not depend on route files.

`ModelSource` supplies `list`, `detail`, `create`, `update`, `delete`, and
`materialize`. The Drizzle source keeps relation writes and the result read in
one transaction. Canonical hooks can set `state.where` for server read or write
scope and `state.values` for server-owned create or update values.

## Build, OpenAPI, and client types

The hidden route tooling reads the directory once and builds one executable
manifest before server startup. Production loads that artifact and does not
scan source or load the compiler. The same directory model supplies batch and
editor types, OpenAPI paths, and the private SDK contract. A developer uses the
normal project commands and does not run a generator or import a generated file.

Use `generateOpenApi(manifest, info)` or `generateInstalledOpenApi(info)`.
Custom JSON routes can set `openapi.requestBody` to their Zod input schema.

## Errors and request context

`validationError`, `unauthorized`, `forbidden`, and `notFound` produce the
standard `{ error, message?, issues? }` envelope. Unknown errors return
`internal_error` and are logged. `requestContext()` assigns and returns an
`x-request-id`.
