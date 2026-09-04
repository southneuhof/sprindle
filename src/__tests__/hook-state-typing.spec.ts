import { describe, expect, it } from 'vitest'
import { createEntity, defineModel } from '../model'
import { create, deleteRoute, detail, list, update } from '../routes'
import { createMemorySource } from '../testing'
import type { DomainEntity, RouteAuthorize } from '../model'

function makeEntity(): DomainEntity {
  const entity = createEntity({
    table: { name: 'items' },
    schemas: {
      select: z.object({ id: z.string() }),
      create: z.object({ id: z.string() }),
      update: z.object({}),
    },
  }) as unknown as DomainEntity
  entity.source = createMemorySource<Record<string, unknown>>() as never
  return entity
}

import { z } from 'zod/v4'

describe('factory hook state typing', () => {
  if (false) {
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
  }

  it('gives list hooks a typed query/where state', async () => {
    const model = defineModel({
      path: '/items',
      entity: makeEntity(),
      routes: {
        list: list({
          before: ({ state }) => {
            const q: Record<string, unknown> = state.query
            void q
            // @ts-expect-error unknown keys are rejected on the typed state
            void state.nope
            return {}
          },
        }),
      },
    })
    expect(model.path).toBe('/items')
  })
})
