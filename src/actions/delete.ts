import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import { idParamSchema } from '../validation'

export function deleteAction() {
  return defineAction({
    method: 'delete',
    path: '/:id',
    validators: [zValidator('param', idParamSchema)],
    handler: async ({ c, context }) => {
      const deleted = await context.entity.source.delete({ id: idParamSchema.parse(c.req.param()).id, context })
      if (!deleted) return c.json({ error: 'not_found' }, 404)
      return c.json({ ok: true })
    },
  })
}
