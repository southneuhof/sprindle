import { defineAction } from './define-action'

export function create() {
  return defineAction({
    method: 'post',
    handler: async ({ c, context }) => {
      try {
        const data = await context.entity.source.create({ input: await c.req.json(), context })
        return c.json({ data }, 201)
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
