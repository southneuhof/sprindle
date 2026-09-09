import type { DefineFileList, RouteParameters, ScopeView } from './definition'
import { fileResource } from './define-route'

export const list: DefineFileList<ScopeView, RouteParameters> = (config = {}) => fileResource('list', config as Record<string, unknown>) as never
