const SOURCE_BOUND = Symbol.for('@southneuhof/sprindle/source-bound')

export function markSourceBound(source: unknown): void {
  ;(source as Record<symbol, boolean>)[SOURCE_BOUND] = true
}

export function isSourceBound(source: unknown): boolean {
  return Boolean(source && (source as Record<symbol, boolean | undefined>)[SOURCE_BOUND])
}
