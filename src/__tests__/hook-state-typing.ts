import { create, deleteRoute, detail, list, update } from '../routes'
import type { RouteAuthorize } from '../model'

export function checkHookStateTypes() {
  const authorize: RouteAuthorize = (args) => {
    // @ts-expect-error authorization runs before route state exists
    return args.state
  }
  void authorize

  detail({
    enrich: (_record, args) => {
      const id: string = args.state.id
      void id
      // @ts-expect-error detail enrichment has no write input
      void args.state.input
    },
  })
  create({
    enrich: (_record, args) => {
      const input: Record<string, unknown> = args.state.input
      const values: Record<string, unknown> | undefined = args.state.values
      void input
      void values
      // @ts-expect-error create enrichment has no path id
      void args.state.id
    },
  })
  update({
    before: ({ state }) => ({ where: state.id }),
    enrich: (_record, args) => {
      const id: string = args.state.id
      const input: Record<string, unknown> = args.state.input
      const values: Record<string, unknown> | undefined = args.state.values
      const where: unknown = args.state.where
      void id
      void input
      void values
      void where
    },
  })
  deleteRoute({
    before: ({ state }) => ({ where: state.id }),
  })

  list({
    before: ({ state }) => {
      const query: Record<string, unknown> = state.query
      void query
      // @ts-expect-error unknown keys are rejected on the typed state
      void state.nope
      return {}
    },
  })
}
