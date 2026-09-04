import type { ModelRoute, HttpMethod } from './route-types'
import type { ModelRuntimeContext } from '../source'

const RESOURCE_ROUTE = Symbol('SPRINDLE_RESOURCE_ROUTE')

export type ResourceOperation = 'list' | 'detail' | 'create' | 'update' | 'delete'

export const RESOURCE_STATUS = {
  list: { success: 200, errors: [400, 401, 403, 500] },
  detail: { success: 200, errors: [400, 401, 403, 404, 500] },
  create: { success: 201, errors: [400, 401, 403, 409, 422, 500] },
  update: { success: 200, errors: [400, 401, 403, 404, 409, 422, 500] },
  delete: { success: 200, errors: [400, 401, 403, 404, 500] },
} as const satisfies Record<ResourceOperation, { success: number; errors: readonly number[] }>

export type ResourceRoute<
  TContext extends ModelRuntimeContext = ModelRuntimeContext,
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
  TOperation extends ResourceOperation = ResourceOperation,
> = ModelRoute<TContext, TMethod, TPath, TInput, TOutput> & {
  readonly [RESOURCE_ROUTE]: TOperation
}

type ResourceRouteWithOperation = ModelRoute & { readonly [RESOURCE_ROUTE]: ResourceOperation }

export function markResourceRoute<
  TContext extends ModelRuntimeContext,
  TMethod extends HttpMethod,
  TPath extends string,
  TInput extends Record<string, unknown>,
  TOutput,
  TResource extends ResourceOperation,
>(route: ModelRoute<TContext, TMethod, TPath, TInput, TOutput>, resource: TResource): ResourceRoute<TContext, TMethod, TPath, TInput, TOutput, TResource> {
  return Object.assign(route, { [RESOURCE_ROUTE]: resource }) as ResourceRoute<TContext, TMethod, TPath, TInput, TOutput, TResource>
}

export function isResourceRoute(value: unknown): value is ResourceRouteWithOperation {
  return typeof value === 'object' && value !== null && RESOURCE_ROUTE in value
}

export function resourceOperation(route: ModelRoute): ResourceOperation | undefined {
  return isResourceRoute(route) ? route[RESOURCE_ROUTE] : undefined
}
