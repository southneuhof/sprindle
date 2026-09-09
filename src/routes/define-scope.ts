import type { DefineFileScope, FileScopeConfig, RouteParameters, ScopeView } from './definition'

export const FILE_SCOPE = Symbol.for('southneuhof.sprindle.file-scope')

export type RuntimeScopeDefinition = {
  readonly [FILE_SCOPE]: true
  readonly config: FileScopeConfig<ScopeView, RouteParameters, Record<string, unknown>, unknown, never, unknown>
}

const runtimeDefineScope = (config: RuntimeScopeDefinition['config']): ScopeView => {
  return { [FILE_SCOPE]: true, config } as unknown as ScopeView
}

export const defineScope = runtimeDefineScope as DefineFileScope<ScopeView, RouteParameters>

export function isFileScope(value: unknown): value is RuntimeScopeDefinition {
  return Boolean(value && typeof value === 'object' && (value as RuntimeScopeDefinition)[FILE_SCOPE])
}
