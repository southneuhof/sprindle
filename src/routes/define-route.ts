import type { DefineFileCreate, DefineFileDelete, DefineFileDetail, DefineFileList, DefineFileUpdate, FileRouteConfig, FileRouteDefinition, RouteParameters, ScopeView } from './definition'
import type { z } from 'zod/v4'

export const FILE_ROUTE = Symbol.for('southneuhof.sprindle.file-route')

export type RuntimeRouteDefinition = FileRouteDefinition<unknown, unknown, string> & {
  readonly [FILE_ROUTE]: true
  readonly kind: 'route' | 'list' | 'detail' | 'create' | 'update' | 'delete'
  readonly config: Record<string, unknown>
}

export function defineRoute<TState extends object = {}, TOutput = Response | object, TBody extends z.ZodType | undefined = undefined>(
  config: FileRouteConfig<RouteParameters, Record<string, unknown>, TState, TOutput> & { openapi?: { requestBody?: TBody } },
): FileRouteDefinition<TBody extends z.ZodType ? { json: z.input<TBody> } : unknown, Awaited<TOutput>> {
  return fileRoute('route', config)
}

function fileRoute<TKind extends RuntimeRouteDefinition['kind']>(kind: TKind, config: object) {
  return { [FILE_ROUTE]: true, kind, config }
}

export const create: DefineFileCreate<ScopeView, RouteParameters> = (config = {}) => fileRoute('create', config)
export const deleteRoute: DefineFileDelete<ScopeView, RouteParameters> = (config = {}) => fileRoute('delete', config)
export const detail: DefineFileDetail<ScopeView, RouteParameters> = (config = {}) => fileRoute('detail', config)
export const list: DefineFileList<ScopeView, RouteParameters> = (config = {}) => fileRoute('list', config)
export const update: DefineFileUpdate<ScopeView, RouteParameters> = (config = {}) => fileRoute('update', config)

export function isFileRoute(value: unknown): value is RuntimeRouteDefinition {
  return Boolean(value && typeof value === 'object' && (value as RuntimeRouteDefinition)[FILE_ROUTE])
}
