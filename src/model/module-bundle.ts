import type { SprindleInstallable } from '../hono'
import type { DomainPart } from './domain-schema'
import type { RoutePipeline } from './route-types'

export type ModuleBundle = {
  /** Tables/entities/relations owned by the module. Omit for stateless ones. */
  domain?: DomainPart
  /** Hooks applied to every model in this bundle, between install scope and model scope. */
  pipeline?: RoutePipeline
  /** Everything the module mounts. */
  models: readonly SprindleInstallable[]
}

export function defineModule<const T extends ModuleBundle>(bundle: T): T {
  return bundle
}

/** Element union of every model mounted by these bundles (schema-equivalent to the flattened tuple). */
export type BundleModels<T extends readonly ModuleBundle[]> = T[number]['models'][number]
