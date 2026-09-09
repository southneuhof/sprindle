import type { DefineFileCreate, RouteParameters, ScopeView } from './definition'
import { fileResource } from './define-route'

export const create: DefineFileCreate<ScopeView, RouteParameters> = (config = {}) => fileResource('create', config as Record<string, unknown>) as never
