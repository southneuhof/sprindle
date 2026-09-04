import { defineResourceRoute, type RouteConfigFor } from './define-route'
import { idParamSchema } from '../validation'
import type { ModelRuntimeContext } from '../source'
import type { RouteHandlerArgs } from '../model/route-types'
import { applyModelRecordEnrich, type RecordEnrich } from './record-enrich'
import { runDataWrite } from '../model/data-write'

type UpdateState = { id: string; input: Record<string, unknown>; values: Record<string, unknown> | undefined; where?: unknown }
type UpdateArgs = RouteHandlerArgs<ModelRuntimeContext, UpdateState>
type UpdateConfig = RouteConfigFor<UpdateState, ModelRuntimeContext> & {
  enrich?: RecordEnrich<UpdateArgs>
  run?: (args: UpdateArgs) => Promise<Record<string, unknown> | null | undefined> | Record<string, unknown> | null | undefined
}

export function update(config: UpdateConfig = {}) {
  const { enrich, run, ...hooks } = config
  return defineResourceRoute('update', {
    method: 'patch',
    path: '/:id',
    state: async ({ c }): Promise<UpdateState> => ({
      id: idParamSchema.parse(c.req.param()).id,
      input: await c.req.json(),
      values: undefined,
      where: undefined,
    }),
    action: async (args) => {
      const { c, context, state } = args
      const data = run ? await run(args) : await context.entity.source.update({ id: state.id, input: state.input, values: state.values, where: state.where, context })
      if (!data) return c.json({ error: 'not_found' }, 404)
      const modelEnriched = await applyModelRecordEnrich(data, args)
      const enriched = enrich ? (await enrich(modelEnriched, args)) ?? modelEnriched : modelEnriched
      return c.json({ data: enriched })
    },
  }, hooks, (args) => runDataWrite('update', args))
}
