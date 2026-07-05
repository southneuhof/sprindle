import { zValidator } from '@hono/zod-validator'
import { defineAction } from './define-action'
import { listQuerySchema } from '../validation'

export function list() {
  return defineAction({
    method: 'get',
    kind: 'list',
    validators: [zValidator('query', listQuerySchema)],
    handler: async ({ c, context }) => {
      const query = listQuerySchema.parse(c.req.query())
      const result = await context.entity.source.list({ query, context })
      const data = Array.isArray(result) ? result : result.data
      const total = Array.isArray(result) ? undefined : result.total
      return c.json({ data, page: query.page, limit: query.limit, ...(total === undefined ? {} : { total }) })
    },
  })
}
