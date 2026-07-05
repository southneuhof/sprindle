import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import { idParamSchema } from '../validation'

export function update() {
  return defineAction({
    method: 'patch',
    path: '/:id',
    validators: [zValidator('param', idParamSchema)],
    handler: async ({ c, context }) => {
      try {
        const data = await context.entity.source.update({ id: idParamSchema.parse(c.req.param()).id, input: await c.req.json(), context })
        if (!data) return c.json({ error: 'not_found' }, 404)
        return c.json({ data })
      } catch (error) {
        if (isValidationError(error)) return c.json({ error: error.message }, error.status)
        throw error
      }
    },
  })
}

function isValidationError(error: unknown): error is Error & { status: 400 } {
  return Boolean(error && typeof error === 'object' && (error as { status?: unknown }).status === 400)
}
