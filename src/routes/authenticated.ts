import { unauthorized } from '../errors'
import type { RouteAuthorize, RouteHandlerArgs } from '../model/route-types'

/**
 * Authorize hook that requires a resolved identity. Routes are public unless
 * this guard is attached — attach it at model level by default.
 */
export function authenticated<TArgs extends RouteHandlerArgs = RouteHandlerArgs>(): RouteAuthorize<TArgs> {
  return async (args) => {
    if (!(await args.identity())) throw unauthorized()
  }
}
