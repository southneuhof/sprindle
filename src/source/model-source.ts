import type { Context } from 'hono'
import type { RoutePipeline } from '../model/route-types'
import type { ModelRecordEnrich } from '../model/record-enrich'

export type ModelRuntimeEntity<TTable = unknown> = {
  name: string
  table?: TTable
  source: ModelSource
}

/** The app's single answer to "who is calling"; installed through `installSprindle` options. */
export type IdentityResolver = (c: Context) => unknown | Promise<unknown>

export type ModelRuntimeContext<TTable = unknown, TEnrich extends ModelRecordEnrich<any, any> | undefined = ModelRecordEnrich<any, any> | undefined> = {
  name: string
  entity: ModelRuntimeEntity<TTable>
  enrich?: TEnrich
  identity?: IdentityResolver
  /** Merged composition pipeline (install + bundle + model scopes); assigned at install time. */
  pipeline?: RoutePipeline
}

export type SourceListResult<TRecord> = {
  data: TRecord[]
  total: number
}

export type ModelSource<TRecord = unknown> = {
  /**
   * `where` is the server-owned read-scope channel: a SQL predicate filled by
   * `before` hooks through `state.where`. The source ANDs it into every list
   * read after its own query plan; clients cannot reach it.
   */
  list: (args: { query: Record<string, unknown>; where?: unknown; context: ModelRuntimeContext }) => Promise<SourceListResult<TRecord> | TRecord[]>
  /** `where` mirrors the list channel on single-row reads: no row matches -> null. */
  detail: (args: { id: string; where?: unknown; context: ModelRuntimeContext }) => Promise<TRecord | null | undefined>
  create: (args: { input: unknown; values?: Record<string, unknown>; context: ModelRuntimeContext }) => Promise<TRecord>
  /** `where` is a server-owned write scope ANDed with the primary-key predicate. */
  update: (args: { id: string; input: unknown; values?: Record<string, unknown>; where?: unknown; context: ModelRuntimeContext }) => Promise<TRecord | null | undefined>
  /** A row outside `where` is hidden and returns the canonical not-found result. */
  delete: (args: { id: string; where?: unknown; context: ModelRuntimeContext }) => Promise<boolean | TRecord | null | undefined>
  materialize: (input: unknown | unknown[], args: { context: ModelRuntimeContext }) => Promise<TRecord | TRecord[]>
}
