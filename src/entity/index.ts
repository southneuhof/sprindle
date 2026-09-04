/**
 * Browser-safe entity surface.
 *
 * `./model` re-exports `defineModel`, which pulls in Hono and the route tree. Entity modules only
 * need to pair a table with its schemas, and application code that reads those schemas — a form in
 * the browser, for example — must be able to import them without the server runtime coming along.
 * This subpath exposes exactly that pair and nothing else.
 */
export { createEntity, isDomainEntity } from '../model/domain-schema'
export type { DomainEntity } from '../model/domain-schema'
