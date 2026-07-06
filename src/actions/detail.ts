import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import { idParamSchema } from '../validation'

type DetailState = { id: string }

export const detail = defineAction({
  method: 'get',
  path: '/:id',
  kind: 'detail',
  middleware: [zValidator('param', idParamSchema)],
  state: ({ c }) => ({ id: idParamSchema.parse(c.req.param()).id }),
  handler: async ({ c, context, state }) => {
    const record = await context.entity.source.detail({ id: state.id, context })
    if (!record) return c.json({ error: 'not_found' }, 404)
    return c.json({ data: record })
  },
})
