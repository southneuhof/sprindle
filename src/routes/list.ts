import { defineResourceRoute, type RouteConfigFor } from './define-route'
import { listQuerySchema, normalizeListQuery } from '../validation'
import { validationError } from '../errors'
import type { ModelRuntimeContext } from '../source'
import type { RouteHandlerArgs } from '../model/route-types'
import { applyModelRecordEnrich } from './record-enrich'

type ListState = { query: Record<string, unknown>; where?: unknown }
type ListArgs = RouteHandlerArgs<ModelRuntimeContext, ListState>

/**
 * Post-read decoration for canonical lists: receives the parsed rows plus the
 * handler args (identity, state) and returns replacement rows. Returning void
 * keeps the rows unchanged. Runs after the source read, before the envelope.
 */
export type ListEnrich = (rows: unknown[], args: ListArgs) => Promise<unknown[] | void> | unknown[] | void

/**
 * Declarative query shaping, applied inside the generated state builder
 * before every before-hook. Boolean coercion stays in the source's filter
 * validation; pinned filters belong in `entity.read.pinnedOrder`.
 */
export type ListQueryPolicy = {
  /** Fills only when the client sent no sort (`??=` semantics). */
  defaultSort?: string
  /** Present, non-empty values must be members; otherwise 400 naming the key. */
  enumFilters?: Record<string, readonly string[]>
}

export type ListConfig = RouteConfigFor<ListState, ModelRuntimeContext> & {
  enrich?: ListEnrich
  query?: ListQueryPolicy
  run?: (args: ListArgs) => Promise<{ data: unknown[]; total: number }> | { data: unknown[]; total: number }
}

const applyQueryPolicy = (query: Record<string, unknown>, policy?: ListQueryPolicy) => {
  if (!policy) return
  if (policy.defaultSort && (query.sort == null || query.sort === '')) query.sort = policy.defaultSort
  for (const [key, allowed] of Object.entries(policy.enumFilters ?? {})) {
    const value = query[key]
    if (value === undefined || value === '') continue
    if (!allowed.includes(value as never)) throw validationError(`Query parameter "${key}" must be one of: ${allowed.join(', ')}.`)
  }
}

export function list(config: ListConfig = {}) {
  const { enrich, query: policy, run, ...hooks } = config
  const state = ({ c }): ListState => {
    const query = listQuerySchema.parse(normalizeListQuery(c.req.query()))
    applyQueryPolicy(query, policy)
    return { query, where: undefined }
  }
  return defineResourceRoute('list', {
    method: 'get',
    path: '',
    state,
    action: async (args) => {
      const { c, context, state } = args
      const query = state.query
      let raw: unknown[]
      let total: number
      if (run) {
        const result = await run(args)
        raw = result.data
        total = result.total
      } else {
        const result = await context.entity.source.list({ query, where: state.where, context })
        raw = Array.isArray(result) ? result : result.data
        total = Array.isArray(result) ? raw.length : result.total
      }
      const modelEnriched = await Promise.all(raw.map((record) => applyModelRecordEnrich(record, args)))
      const data = enrich ? ((await enrich(modelEnriched, args)) ?? modelEnriched) : modelEnriched
      return c.json({ data, page: query.page, limit: query.limit, total })
    },
  }, hooks)
}
