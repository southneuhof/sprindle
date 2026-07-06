import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import type { ActionFactoryConfigFor } from './define-action'
import { listQuerySchema } from '../validation'

type ListState = { query: Record<string, unknown> }

export function list(config: ActionFactoryConfigFor<ListState> = {}) {
  return defineAction({
    method: 'get',
    kind: 'list',
    validators: [zValidator('query', listQuerySchema)],
    ...config,
    state: ({ c }) => ({ query: listQuerySchema.parse(c.req.query()) }),
    handler: async ({ c, context, state }) => {
      const query = state.query
      const result = await context.entity.source.list({ query, context })
      const data = Array.isArray(result) ? result : result.data
      const total = Array.isArray(result) ? undefined : result.total
      return c.json({ data, page: query.page, limit: query.limit, ...(total === undefined ? {} : { total }) })
    },
  })
}
