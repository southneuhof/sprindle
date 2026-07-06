import { defineAction } from './define-action'
import type { ActionFactoryConfigFor } from './define-action'

type CreateState = { input: unknown }

export function create(config: ActionFactoryConfigFor<CreateState> = {}) {
  return defineAction({
    method: 'post',
    kind: 'create',
    ...config,
    state: async ({ c }) => ({ input: await c.req.json() }),
    handler: async ({ c, context, state }) => {
      try {
        const data = await context.entity.source.create({ input: state.input, context })
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
