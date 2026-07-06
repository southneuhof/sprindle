import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import type { ActionFactoryConfigFor } from './define-action'
import { idParamSchema } from '../validation'

type DetailState = { id: string }

export function detail(config: ActionFactoryConfigFor<DetailState> = {}) {
  return defineAction({
    method: 'get',
    path: '/:id',
    kind: 'detail',
    validators: [zValidator('param', idParamSchema)],
    ...config,
    state: ({ c }) => ({ id: idParamSchema.parse(c.req.param()).id }),
    handler: async ({ c, context, state }) => {
      const record = await context.entity.source.detail({ id: state.id, context })
      if (!record) return c.json({ error: 'not_found' }, 404)
      return c.json({ data: record })
    },
  })
}
