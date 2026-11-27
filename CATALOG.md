# Sprindle and API framework catalog

Generated from source by `node scripts/generate-framework-catalog.mjs`. Do not edit by hand.

## Route and scope constructors (`@southneuhof/sprindle`)

| Constructor | Options | Source |
|---|---|---|
| `defineScope` | `context`, `identity`, `before`, `authorize`, `validate`, `after`, `error`, `entity`, `enrich` | `packages/sprindle/src/routes/define-scope.ts` |
| `defineRoute` | `authorize`, `before`, `validate`, `after`, `error`, `openapi`, `middleware`, `state`, `action` | `packages/sprindle/src/routes/define-route.ts` |
| `list` | `authorize`, `before`, `validate`, `after`, `error`, `query{defaultSort,defaultOrder,enumFilters}`, `enrich`, `run` | `packages/sprindle/src/routes/define-route.ts` |
| `detail` | `authorize`, `before`, `validate`, `after`, `error`, `param`, `enrich`, `run` | `packages/sprindle/src/routes/define-route.ts` |
| `create` | `authorize`, `before`, `validate`, `after`, `error`, `enrich`, `run` | `packages/sprindle/src/routes/define-route.ts` |
| `update` | `authorize`, `before`, `validate`, `after`, `error`, `param`, `enrich`, `run` | `packages/sprindle/src/routes/define-route.ts` |
| `deleteRoute` | `authorize`, `before`, `validate`, `after`, `error`, `param`, `run` | `packages/sprindle/src/routes/define-route.ts` |

- Additional route helpers: `authenticated()`, `created(c, data)`.

## Entity, source, locking, and errors

- `@southneuhof/sprindle/entity`: `createEntity(config)`, `isDomainEntity(value)`
  - `createEntity({ table, schemas, read })` read options: `pinnedOrder`, `searchColumns`, `virtual`
- `@southneuhof/sprindle/source`: `lockRow<T>(db: LockDb, table: T, id: string, options?: LockRowOptions)` with options `require`, `failMessage`, `where` (adds `deletedAt IS NULL` automatically, throws 404 or 409 `invalid_transition`).
- `@southneuhof/sprindle` errors: `new HttpError(status: number, code: string, message?: string, issues?: ErrorIssue[])`, `validationError(messageOrIssues: string | ErrorIssue[])`, `unauthorized(message?: string)`, `forbidden(message?: string)`, `notFound(message?: string)`

## App API shared helpers (`apps/api/src/`)

| Module | Exports |
|---|---|
| `apps/api/src/identity.ts` | `orgIdentity(args)`, `requireOrgIdentity(args)`, `requirePathParam(args, name)`, `requirePermission(code)` |
| `apps/api/src/schema.ts` | `optionalText`, `uploadKey`, `storedAssetSchema`, `storedAssetInput`, `selectionValues`, `selectionQuery` |
| `apps/api/src/storage/assets.ts` | `assetRequestContext()`, `runWithAssetRequestUrl(url, callback)`, `storedAsset(key, metadata?)`, `projectStoredAssets(value)`, `publicRecord(schema, value)`, `publicRecords(schema, values)`, `storedAssetModel(schema)`, `storedAssetResponse` |
| `apps/api/src/storage/uploads.ts` | `readMultipart(c, options)`, `withUploadedObjects(files, options)`, `streamStoredObject(key, options)` |
| `apps/api/src/soft-delete.ts` | `softDeleteValues(columns, userId, reason?)`, `softDeleteRoute(options)` |
| `apps/api/src/unique-violation.ts` | `isUniqueViolation(error)`, `onError(error, c)` |
| `apps/api/src/audit.ts` | `auditStamp()` |
| `apps/api/src/request-body.ts` | `readJsonBody(c)` |
