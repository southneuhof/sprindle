# Sprindle reference

Sprindle is a thin layer over [Hono](https://hono.dev) and [Drizzle](https://orm.drizzle.team):
you declare tables, schemas, canonical resource constructors, and custom HTTP routes; Sprindle
mounts routes, applies a fixed request pipeline, and keeps one wire contract. It does not hide Hono — every escape hatch is a Hono
handler or middleware.

Line references point at `packages/sprindle/src`.

## Vocabulary

### entity — `createEntity({ table, schemas })`

`model/domain-schema.ts:62` — pairs a Drizzle table with its `create` / `update` / `select` Zod
schemas. The entity's name is the Drizzle table name. `defineEntitySchemas` (`:76`) is an identity
helper that keeps schema literals narrowly typed.

```ts
import { createEntity } from '@southneuhof/sprindle/model'

export const product = createEntity({
  table: products,
  schemas: { create: productCreate, update: productUpdate, select: productSelect },
})
```

Boot errors: `createEntity() does not accept relations.` (`:65`) — relations belong to a domain part.

### domain part / domain schema — `defineDomainPart`, `defineDomainSchema`, `bindDomainDatabase`

`model/domain-schema.ts:80`, `:88`, and the binder used by `apps/api/src/db.ts`. A domain part groups
tables, entities and Drizzle relation parts; `defineDomainSchema` merges the parts, validates them and
derives relation metadata; `bindDomainDatabase` attaches the live database to every entity source.

Boot errors are remediation messages — read them whole. Examples: `Unknown nested object field "<field>"
on entity "<name>". Nested relation fields must use another entity's schemas.select.` (`:175`) and
missing-relation / missing-through-column errors (`:275`–`:286`).

### module bundle — `defineModule({ domain?, models })`

`model/module-bundle.ts` — one registration unit per application module. The
bundle carries its domain part beside the models it mounts, so an application
registers each module exactly once. `installSprindle(app, modules)` mounts
bundles directly (preserving every element type, so client types — `hc<AppType>`
— are identical to a literal tuple); domain parts collected from the same
bundles feed `defineDomainSchema` and `bindDomainDatabase`.

```ts
export const modules = [
  defineModule({ domain: uomsDomain, models: [uomModel] }),
  defineModule({ models: [healthRoute] }),
] as const

installSprindle(app, modules, { identity })
defineDomainSchema(modules.flatMap((module) => (module.domain ? [module.domain] : [])))
```

### model — `defineModel({ path, entity, routes, ...hooks })`

`model/define-model.ts:29`. Compiles a route tree into a Hono sub-app and builds the runtime context
(`{ name, entity, pipeline }`) every route handler receives. Model-level pipeline hooks apply to every
route in the model.

### route — `defineRoute` and canonical constructors

`routes/define-route.ts`. `defineRoute({ method, path, action })` describes one custom HTTP
contract. A custom JSON write can add `openapi: { requestBody: zodSchema }`; this documents the
existing runtime parser and does not replace it. It has no resource operation field. The canonical constructors are `list()`, `detail()`,
`create()`, `update()`, and `deleteRoute()`; each owns its method, path, input parsing, response
status, envelope, and canonical not-found behavior. Each accepts pipeline hooks that merge with the
constructor's own.

When a canonical constructor needs domain work, use its narrow `run` callback. The callback returns
records/data only: `list` returns `{ data, total }`, `create` returns one record, `update` returns a
record or `undefined` for not found, and `deleteRoute` returns `void` and throws `notFound()` when
needed. The constructor still owns the HTTP response.

Run ownership: the constructor owns method, path, input parsing, success status, response envelope,
and the documented callback return shape. `run` owns the custom persistence it performs. A
create/update run applies `state.values` after client input; a scoped list/update/delete run applies
`state.where` when that route uses it. Update returns `undefined` for not found; delete throws
`notFound()` when its custom write affects no valid row. Sprindle cannot enforce these source
semantics for arbitrary SQL. Focused domain tests must prove the custom persistence rules.

Canonical constructors must be nested in `defineModel`, where an entity is bound. Only true custom
routes with an explicit path can be top-level installables.

Route-tree nesting becomes URL segments (`model/route-tree.ts:30`): a key `nested: { ping }` under a
model mounted at `/items` is served at `/items/nested/ping`. Canonical URLs:

| Constructor | Method | Path |
|---|---|---|
| list | GET | `/<model>/list` |
| detail | GET | `/<model>/detail/:id` |
| create | POST | `/<model>/create` |
| update | PATCH | `/<model>/update/:id` |
| delete | DELETE | `/<model>/delete/:id` |

### source — `ModelSource`

`source/model-source.ts` — six methods: `list`, `detail`, `create`, `update`, `delete`, `materialize`.
`createDrizzleSource` (`source/drizzle-source.ts`) is the Drizzle implementation; `createMemorySource`
(`testing/memory-source.ts`) is the in-memory one used by tests. Any object satisfying the contract can
back a model.

Drizzle source guarantees:

- `create` and `update` run their write, relation writes and the post-write re-read inside one
  transaction when the database supports it (`drizzle-source.ts:46`, `:162`).
- `list` and `detail` issue one relational query (plus one `COUNT` for lists); array materialization
  batches into a single `in` query for single-column primary keys.
- Every canonical list ends with the primary-key order terms, so rows that tie on the visible
  sort stay deterministic between queries.

### lockRow — lock-and-guard read for transactional transitions

`source/lock-row.ts`. `lockRow(db, table, id, { require?, failMessage? })` runs
`SELECT ... FOR UPDATE` by primary key (with `deletedAt IS NULL` when the table has that column)
inside the caller's transaction. An absent row throws `notFound()`; a failed `require` guard throws
409 `invalid_transition` (message overridable). On success it returns the locked row.

```ts
const report = await lockRow(tx, qualityInspections, id, {
  require: { statusCode: 'on-progress', stepCode: 'complete-report' },
  failMessage: 'The inspection is not ready for item verification.',
})
```

### pipeline

`routes/pipeline.ts:9`. Order per request:

```
authorize(install) → authorize(bundle) → authorize(model) → authorize(route)
  → state initializer
  → dataWrite(create/update, canonical only)
  → before(install) → before(bundle) → before(model) → before(route)
  → validate(install) → validate(bundle) → validate(model) → validate(route)
  → action
  → after(route) → after(model) → after(bundle) → after(install)
  ─ on throw ─→ error(route) → error(model) → error(bundle) → error(install)
             → error contract → rethrow
```

Install scope comes from `installSprindle`'s `pipeline`
option; bundle scope from a module bundle's own `pipeline`. Composition never
changes stage order — it only adds hooks to each stage.

`before` hooks return a patch merged into `args.state`. `authorize` returning a value answers 403;
returning a `Response` answers with it; throwing an `HttpError` answers with that error's status.
`validate` returning issues answers 400. `after` hooks may replace the response.

Model record enrichment: `defineModel` accepts `enrich: { schema, run }` as the
shared public-record boundary. Its `run(record, args)` result is parsed by `schema`
before the normal response envelope. It applies to canonical `list`, `detail`,
`create`, and `update` records; list rows are mapped one by one. It does not apply
to `delete` or custom `defineRoute` routes. Keep the function free of per-row
database or remote-storage I/O. Route-level `enrich(record, args)` remains the
operation-specific seam and runs after model enrichment. A missing record returns
the normal 404 and does not call either hook. Use `after` only when the full HTTP
response (such as headers, status, or the complete envelope) is the extension surface.

Server-owned write values: a `before` hook on a create/update route may set `state.values`, a bag of
column values the canonical factories forward to the source (`routes/create.ts`, `routes/update.ts`).
The source applies it after schema validation with server precedence — `values` wins over any
conflicting client key (`source/drizzle-source.ts`). Install-scope server values use the `dataWrite`
option with one callback. It receives the narrow `operation` value (`create` or `update`) and returns
values; only canonical constructors invoke it. It is a write-stage value, not route metadata.
Custom `defineRoute` routes, even when their state has a `values` property, do not invoke it. Clients
cannot reach the bag: factories fill it from hooks and the data-write callback, never from request
JSON, and write schemas reject unknown keys anyway.

Server-owned read scope: the canonical list and detail factories reserve `state.where`
(`routes/list.ts`, `routes/detail.ts`). A `before` hook on either route may return `{ where }` — a
SQL predicate, or a `(table, operators) =>
SQL` factory when a relational source must bind the predicate to its aliased base table; memory
sources take a row predicate. The source ANDs it into every list read after building its own query
plan from the query string, and into every detail read after the primary-key predicate — a scoped-away
row answers null, which maps to 404 (`source/drizzle-source.ts`, `testing/memory-source.ts`), so no
client filter can unset or widen it. Fill it from identity/scope derivations only; never put
client-derived values into this channel.

Server-owned write scope: the canonical update and delete factories reserve
`state.where` (`routes/update.ts`, `routes/delete.ts`). A `before` hook may return
`{ where }`, but request JSON, query, and path values never fill this field. The
Drizzle source ANDs the predicate with the primary-key condition in the same
update or delete statement; memory sources test the row predicate before changing
the row. A scoped-away row returns the same null/false result as a missing row,
which maps to the normal 404. Relation writes run only after the scoped base row
exists.

Declarative list read: a Drizzle source (or its domain entity) may set `read`:

```ts
read: {
  pinnedOrder: [desc(table.createdAt)],
  searchColumns: ['number', 'location'],
  virtual: {
    startMonth: {
      validate: (raw, field) => validateMonth(raw, field),
      where: (value, columns) => gte(columns.createdAt, `${String(value)}-01`),
    },
  },
}
```

`pinnedOrder` replaces client `sort` and `order`; the client keys are ignored. `searchColumns`
limits `search` to named base-table columns. A declared virtual parameter is removed before
equality-filter validation, then its validator and `where` builder run. The default validator
requires a string and answers `Query parameter "<field>" must be a string.`. The builder result
ANDs with equality filters and the server-owned scope. Builders may be async. Their `columns`
argument is the alias-safe base-table column map for the active read, including relational reads.
Memory sources accept the same three capabilities with a row comparator, row keys, and row
predicate.

Handler args (`model/route-types.ts:16`): `{ c, context, state, identity }`.
Authorization hooks receive `{ c, context, identity }` and cannot access
parsed route state. Error hooks may receive no `state` when authorization or state
creation fails.

### identity and guards

`installSprindle(app, installables, { identity })` installs one resolver answering "who is calling"
(`hono/index.ts`). `args.identity()` is lazy and memoized per request. Routes are **public unless
`authenticated()` is attached** — attach it at model level by default:

```ts
import { authenticated, list } from '@southneuhof/sprindle/routes'

defineModel({ path: '/products', entity: product, authorize: [authenticated()], routes: { list: list() } })
```

`authenticated()` throws `unauthorized()` (401) before any custom authorize hook can answer 403.

## Wire contracts

| Constructor | Success | Status |
|---|---|---|
| list | `{ data: Select[], page, limit, total }` | 200 |
| detail / update | `{ data: Select }` | 200 |
| create | `{ data: Select }` | 201 |
| delete | `{ ok: true }` | 200 |

Errors use one envelope: `{ error: <code>, message?: string, issues?: [{ field?, message }] }`
(`errors.ts`, rendered in `routes/pipeline.ts:32` and `hono/index.ts` `sprindleOnError`). Constructors:
`validationError(messageOrIssues)` 400, `unauthorized()` 401, `forbidden()` 403, `notFound()` 404, or
`new HttpError(status, code, message?, issues?)`. Zod failures are rendered as `validation_error` with
field issues. Anything else becomes `{ error: 'internal_error' }` 500 — the original message is logged,
never returned.

### List query parameters

| Param | Meaning |
|---|---|
| `page`, `limit` | pagination; `limit` max 100, default 20 |
| `search` | case-insensitive substring across the table's string columns |
| `sort`, `order` | column key and `asc` (default) / `desc` |
| anything else | equality filter on that column |

Before parsing, Sprindle removes values that are exactly the empty string. This makes an empty HTML
`select` value mean no filter. The same normalization runs at both list source entry points, so direct
source callers have the same behavior. Use `normalizeListQuery` for custom routes that parse the raw
request query themselves. It does not trim whitespace.

Unknown non-empty filter keys and unknown sort columns fail with 400 naming the key
(`source/drizzle-source.ts:97`, `:102`).

## Request context and logging

`requestContext()` (`hono/index.ts`) assigns `x-request-id` (honoring an inbound one) and echoes it on
the response. `installSprindle`'s `logger` option accepts any `{ info, warn, error }` object
(pino-compatible); `consoleLogger` is the default. Framework 500s log
`{ requestId, method, path, err }`.

## Extending

- **Custom routes** — `defineRoute({ method, path, action })` returns a true HTTP route usable inside
  a model's tree or as a top-level installable (top-level routes must declare a path). It has its
  declared input/output shape and does not claim a canonical resource contract.
- **Raw Hono** — `middleware: [...]` on any route definition takes ordinary Hono middleware.
- **Other backends** — implement `ModelSource` and hand it to `defineModel` through an entity.
- **OpenAPI** — `@southneuhof/sprindle/openapi` exports `generateOpenApi(installables, info)` and
  `openapiRoute(installables, info)`. Custom JSON writes declare their Zod request schema with
  `openapi.requestBody`.
- **Tests** — `@southneuhof/sprindle/testing` exports `createMemorySource`, `createTestEntity`,
  `testApp`.

## Design rules

- **Thin over Hono.** Sprindle mounts Hono routes and never wraps the `Context`.
- **Types over codegen.** Client types come from `hc<AppType>` inference; there is no generator.
- **Fail loud at boot.** Schema and relation mistakes throw during `defineDomainSchema`, with the fix in
  the message.
- **Closed vocabulary.** Public names come from, in order: existing framework vocabulary, Vue/HTML/
  TypeScript standard vocabulary, then plain English. Coined compounds are rejected in review, and
  domain words (`role`, `parent`, `mapping`) never appear in framework APIs.
