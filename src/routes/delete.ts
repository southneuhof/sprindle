import { zValidator } from '@hono/zod-validator'
import { defineRoute } from './define-route'
import { idParamSchema } from '../validation'

type DeleteState = { id: string }

export const deleteRoute = defineRoute({
  method: 'delete',
  path: '/:id',
  kind: 'delete',
  middleware: [zValidator('param', idParamSchema)],
  state: ({ c }) => ({ id: idParamSchema.parse(c.req.param()).id }),
  action: async ({ c, context, state }) => {
    const deleted = await context.entity.source.delete({ id: state.id, context })
    if (!deleted) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  },
})
