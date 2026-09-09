import type { FileRouteConfig, FileRouteDefinition, RouteParameters } from './definition'
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
  return { [FILE_ROUTE]: true, kind: 'route', config } as unknown as FileRouteDefinition<TBody extends z.ZodType ? { json: z.input<TBody> } : unknown, Awaited<TOutput>>
}

export function fileResource(kind: RuntimeRouteDefinition['kind'], config: Record<string, unknown> = {}) {
  return { [FILE_ROUTE]: true, kind, config } as RuntimeRouteDefinition
}

export function isFileRoute(value: unknown): value is RuntimeRouteDefinition {
  return Boolean(value && typeof value === 'object' && (value as RuntimeRouteDefinition)[FILE_ROUTE])
}
