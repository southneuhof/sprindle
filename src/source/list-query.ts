import { requireStringParam } from '../validation/common-schemas'

const reservedKeys = new Set(['page', 'limit', 'search', 'sort', 'order'])

function positiveInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function sourceListOptions(
  query: Record<string, unknown>,
  virtualKeys: ReadonlySet<string>,
  hasPinnedOrder: boolean,
) {
  const page = positiveInteger(query.page, 1)
  const limit = positiveInteger(query.limit, 20)
  const search = !virtualKeys.has('search') && typeof query.search === 'string' && query.search.length ? query.search : undefined
  const order: 'asc' | 'desc' = query.order === 'desc' ? 'desc' : 'asc'
  const sort = hasPinnedOrder || query.sort == null || query.sort === '' ? undefined : String(query.sort)
  return { limit, offset: (page - 1) * limit, search, order, sort }
}

export function sourceListFilterEntries(query: Record<string, unknown>, virtualKeys: ReadonlySet<string>) {
  return Object.entries(query).filter(([key, value]) => !reservedKeys.has(key) && !virtualKeys.has(key) && value !== undefined)
}

export function sourceVirtualParameters<TParam extends { validate?: (raw: unknown, field: string) => unknown }>(
  query: Record<string, unknown>,
  parameters: Record<string, TParam>,
) {
  const present: { param: TParam; value: unknown }[] = []
  for (const [field, param] of Object.entries(parameters)) {
    const raw = query[field]
    if (raw === undefined) continue
    const value = param.validate ? param.validate(raw, field) : requireStringParam(raw, field)
    present.push({ param, value })
  }
  return present
}
