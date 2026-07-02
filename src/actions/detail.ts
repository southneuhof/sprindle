import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import { idParamSchema } from '../validation'

export function detail() {
  return defineAction({
    method: 'get',
    path: '/:id',
    validators: [zValidator('param', idParamSchema)],
    handler: async ({ c, context }) => {
      const record = await context.entity.source.detail({ id: idParamSchema.parse(c.req.param()).id, context })
      if (!record) return c.json({ error: 'not_found' }, 404)
      return c.json({ data: record })
    },
  })
}
