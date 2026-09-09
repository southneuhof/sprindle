import type { DefineFileDetail, RouteParameters, ScopeView } from './definition'
import { fileResource } from './define-route'

export const detail: DefineFileDetail<ScopeView, RouteParameters> = (config = {}) => fileResource('detail', config as Record<string, unknown>) as never
