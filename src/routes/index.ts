export { create, defineRoute, deleteRoute, detail, isFileRoute, list, update } from './define-route'
export { defineScope, isFileScope } from './define-scope'
export { authenticated } from './authenticated'
export type { RecordEnrich } from './record-enrich'
export type * from './definition'

import type { Context } from 'hono'

/**
 * Canonical create envelope for custom routes that need 201: the pipeline
 * already serializes plain object returns as 200, so only the create status
 * needs this helper.
 */
export function created<T>(c: Context, data: T) {
  return c.json({ data }, 201)
}
