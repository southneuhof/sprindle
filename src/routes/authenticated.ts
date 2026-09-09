import { unauthorized } from '../errors'
import type { FileRequestArgs, RouteParameters } from './definition'

/**
 * Authorize hook that requires a resolved identity. Routes are public unless
 * this guard is attached — attach it at model level by default.
 */
export function authenticated() {
  return async (args: FileRequestArgs<RouteParameters, object>) => {
    if (!(await args.identity())) throw unauthorized()
  }
}
