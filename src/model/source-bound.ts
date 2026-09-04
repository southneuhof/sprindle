const SOURCE_BOUND = Symbol.for('@southneuhof/sprindle/source-bound')

/** Marks a source as database-bound. Used by bindDomainDatabase. */
export function markSourceBound(source: unknown): void {
  ;(source as Record<symbol, boolean>)[SOURCE_BOUND] = true
}

/** True once bindDomainDatabase has attached a live database to the source. */
export function isSourceBound(source: unknown): boolean {
  return Boolean(source && (source as Record<symbol, boolean | undefined>)[SOURCE_BOUND])
}
