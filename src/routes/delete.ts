import type { DefineFileDelete, RouteParameters, ScopeView } from './definition'
import { fileResource } from './define-route'

export const deleteRoute: DefineFileDelete<ScopeView, RouteParameters> = (config = {}) => fileResource('delete', config as Record<string, unknown>) as never
