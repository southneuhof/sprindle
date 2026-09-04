import { defineResourceRoute, type RouteConfigFor } from './define-route'
import { idParamSchema } from '../validation'
import type { ModelRuntimeContext } from '../source'
import type { RouteHandlerArgs } from '../model/route-types'
import { applyModelRecordEnrich, type RecordEnrich } from './record-enrich'

type DetailState = { id: string; where?: unknown }
type DetailArgs = RouteHandlerArgs<ModelRuntimeContext, DetailState>
type DetailConfig = RouteConfigFor<DetailState, ModelRuntimeContext> & {
  enrich?: RecordEnrich<DetailArgs>
}

export function detail(config: DetailConfig = {}) {
  const { enrich, ...hooks } = config
  return defineResourceRoute('detail', {
    method: 'get',
    path: '/:id',
    state: ({ c }): DetailState => ({ id: idParamSchema.parse(c.req.param()).id, where: undefined }),
    action: async (args) => {
      const { c, context, state } = args
      const record = await context.entity.source.detail({ id: state.id, where: state.where, context })
      if (!record) return c.json({ error: 'not_found' }, 404)
      const modelEnriched = await applyModelRecordEnrich(record, args)
      const data = enrich ? (await enrich(modelEnriched, args)) ?? modelEnriched : modelEnriched
      return c.json({ data })
    },
  }, hooks)
}
