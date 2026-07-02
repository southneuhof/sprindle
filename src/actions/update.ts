import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import { idParamSchema } from '../validation'

export function update() {
  return defineAction({
    method: 'patch',
    path: '/:id',
    validators: [zValidator('param', idParamSchema)],
    handler: async ({ c, context }) => {
      const data = await context.entity.source.update({ id: idParamSchema.parse(c.req.param()).id, input: await c.req.json(), context })
      if (!data) return c.json({ error: 'not_found' }, 404)
      return c.json({ data })
    },
  })
}
