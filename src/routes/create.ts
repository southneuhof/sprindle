import { defineResourceRoute, type RouteConfigFor } from './define-route'
import type { ModelRuntimeContext } from '../source'
import type { RouteHandlerArgs } from '../model/route-types'
import { applyModelRecordEnrich, type RecordEnrich } from './record-enrich'
import { runDataWrite } from '../model/data-write'

type CreateState = { input: Record<string, unknown>; values: Record<string, unknown> | undefined }
type CreateArgs = RouteHandlerArgs<ModelRuntimeContext, CreateState>
type CreateConfig = RouteConfigFor<CreateState, ModelRuntimeContext> & {
  enrich?: RecordEnrich<CreateArgs>
  run?: (args: CreateArgs) => Promise<Record<string, unknown>> | Record<string, unknown>
}

export function create(config: CreateConfig = {}) {
  const { enrich, run, ...hooks } = config
  return defineResourceRoute('create', {
    method: 'post',
    path: '',
    state: async ({ c }): Promise<CreateState> => ({
      input: await c.req.json(),
      values: undefined,
    }),
    action: async (args) => {
      const { c, context, state } = args
      const data = run ? await run(args) : await context.entity.source.create({ input: state.input, values: state.values, context })
      const modelEnriched = await applyModelRecordEnrich(data, args)
      const enriched = enrich ? (await enrich(modelEnriched, args)) ?? modelEnriched : modelEnriched
      return c.json({ data: enriched }, 201)
    },
  }, hooks, (args) => runDataWrite('create', args))
}
