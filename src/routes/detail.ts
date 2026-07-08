import { zValidator } from '@hono/zod-validator'
import { defineRoute } from './define-route'
import { idParamSchema } from '../validation'

type DetailState = { id: string }

export const detail = defineRoute({
  method: 'get',
  path: '/:id',
  kind: 'detail',
  middleware: [zValidator('param', idParamSchema)],
  state: ({ c }) => ({ id: idParamSchema.parse(c.req.param()).id }),
  action: async ({ c, context, state }) => {
    const record = await context.entity.source.detail({ id: state.id, context })
    if (!record) return c.json({ error: 'not_found' }, 404)
    return c.json({ data: record })
  },
})
