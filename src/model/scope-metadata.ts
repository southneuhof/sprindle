import { isFileScope, type RuntimeScopeDefinition } from '../routes/define-scope'
import type { ModelRuntimeContext } from '../source'

type EntitySchema = { parse(input: unknown): unknown }
type RuntimeEntity = ModelRuntimeContext['entity'] & {
  schemas: Record<'create' | 'update' | 'select', EntitySchema>
}

export type ScopeMetadata = {
  name: string
  entity?: RuntimeEntity
  enrich?: RuntimeScopeDefinition['config']['enrich']
  enrichContext?: Record<string, unknown>
  enrichIdentity?: () => Promise<unknown>
}

export function applyScopeMetadata(
  runtime: ScopeMetadata,
  config: RuntimeScopeDefinition['config'],
  fallbackName: string,
  context?: Record<string, unknown>,
  identity?: ScopeMetadata['enrichIdentity'],
): ScopeMetadata {
  const entity = config.entity as RuntimeEntity | undefined
  if (entity) runtime = { name: entity.name ?? fallbackName, entity }
  if (config.enrich) runtime = { ...runtime, enrich: config.enrich, enrichContext: context, enrichIdentity: identity }
  return runtime
}

export function resolveScopeMetadata(scopes: readonly unknown[], fallbackName: string): ScopeMetadata {
  let runtime: ScopeMetadata = { name: fallbackName }
  for (const scope of scopes) {
    if (isFileScope(scope)) runtime = applyScopeMetadata(runtime, scope.config, fallbackName)
  }
  return runtime
}
