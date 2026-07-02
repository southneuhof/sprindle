import { defineAction } from './define-action'

export function create() {
  return defineAction({
    method: 'post',
    handler: async ({ c, context }) => {
      const data = await context.entity.source.create({ input: await c.req.json(), context })
      return c.json({ data }, 201)
    },
  })
}
