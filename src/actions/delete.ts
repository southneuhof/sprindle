import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import { idParamSchema } from '../validation'

type DeleteState = { id: string }

export const deleteAction = defineAction({
  method: 'delete',
  path: '/:id',
  kind: 'delete',
  middleware: [zValidator('param', idParamSchema)],
  state: ({ c }) => ({ id: idParamSchema.parse(c.req.param()).id }),
  handler: async ({ c, context, state }) => {
    const deleted = await context.entity.source.delete({ id: state.id, context })
    if (!deleted) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  },
})
