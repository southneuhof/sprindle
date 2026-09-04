import { defineResourceRoute, type RouteConfigFor } from './define-route'
import { idParamSchema } from '../validation'
import type { ModelRuntimeContext } from '../source'
import type { RouteHandlerArgs } from '../model/route-types'

type DeleteState = { id: string; where?: unknown }
type DeleteArgs = RouteHandlerArgs<ModelRuntimeContext, DeleteState>
type DeleteConfig = RouteConfigFor<DeleteState, ModelRuntimeContext> & {
  run?: (args: DeleteArgs) => Promise<void> | void
}

export function deleteRoute(config: DeleteConfig = {}) {
  const { run, ...hooks } = config
  return defineResourceRoute('delete', {
    method: 'delete',
    path: '/:id',
    state: ({ c }): DeleteState => ({ id: idParamSchema.parse(c.req.param()).id, where: undefined }),
    action: async (args) => {
      const { c, context, state } = args
      if (run) await run(args)
      else if (!await context.entity.source.delete({ id: state.id, where: state.where, context })) return c.json({ error: 'not_found' }, 404)
      return c.json({ ok: true })
    },
  }, hooks)
}
