import type { DefineFileUpdate, RouteParameters, ScopeView } from './definition'
import { fileResource } from './define-route'

export const update: DefineFileUpdate<ScopeView, RouteParameters> = (config = {}) => fileResource('update', config as Record<string, unknown>) as never
