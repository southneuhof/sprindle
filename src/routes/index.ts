export { defineRoute } from './define-route'
export type { DefineRouteConfig, RouteConfigFor } from './define-route'
export { authenticated } from './authenticated'
export { create } from './create'
export { deleteRoute } from './delete'
export { detail } from './detail'
export { list } from './list'
export { update } from './update'
export type { RecordEnrich } from './record-enrich'

import type { Context } from 'hono'

/**
 * Canonical create envelope for custom routes that need 201: the pipeline
 * already serializes plain object returns as 200, so only the create status
 * needs this helper.
 */
export function created<T>(c: Context, data: T) {
  return c.json({ data }, 201)
}
