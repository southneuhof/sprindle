import { zValidator } from '@hono/zod-validator'
import { defineRoute } from './define-route'
import { idParamSchema } from '../validation'

type UpdateState = { id: string; input: unknown }

export const update = defineRoute({
  method: 'patch',
  path: '/:id',
  kind: 'update',
  middleware: [zValidator('param', idParamSchema)],
  state: async ({ c }) => ({ id: idParamSchema.parse(c.req.param()).id, input: await c.req.json() }),
  action: async ({ c, context, state }) => {
    try {
      const data = await context.entity.source.update({ id: state.id, input: state.input, context })
      if (!data) return c.json({ error: 'not_found' }, 404)
      return c.json({ data })
    } catch (error) {
      if (isValidationError(error)) return c.json({ error: error.message }, error.status)
      throw error
    }
  },
})

function isValidationError(error: unknown): error is Error & { status: 400 } {
  return Boolean(error && typeof error === 'object' && (error as { status?: unknown }).status === 400)
}
