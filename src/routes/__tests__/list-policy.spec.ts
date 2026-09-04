import { describe, expect, it } from 'vitest'
import { list } from '../list'
import { sprindleOnError } from '../../hono'
import { defineModel } from '../../model'
import { createTestEntity, testApp } from '../../testing'

type Item = { id: string; name: string; categoryCode: string }

const seed: Item[] = [
  { id: 'b', name: 'Beta', categoryCode: 'measuring-instruments' },
  { id: 'a', name: 'Alpha', categoryCode: 'heavy-equipments' },
]

const buildApp = (listConfig: Parameters<typeof list>[0], observed: Record<string, unknown> = {}) => {
  const entity = createTestEntity<Item>({ name: 'policy-items', rows: seed })
  const model = defineModel({
    path: '/policy-items',
    entity,
    routes: {
      list: list({
        before: ({ state }) => {
          observed.sort = state.query.sort
          return undefined
        },
        ...listConfig,
      }),
    },
  })
  return testApp([model] as const).onError(sprindleOnError)
}

describe('list query policy', () => {
  it('fills the default sort when the client sends none, before before-hooks run', async () => {
    const observed: Record<string, unknown> = {}
    const app = buildApp({ query: { defaultSort: 'name' } }, observed)

    const response = await app.request('/policy-items/list')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Item[] }
    expect(body.data.map((row) => row.id)).toEqual(['a', 'b'])
    expect(observed.sort).toBe('name')
  })

  it('keeps a client-sent sort over the default', async () => {
    const observed: Record<string, unknown> = {}
    const app = buildApp({ query: { defaultSort: 'name' } }, observed)

    const response = await app.request('/policy-items/list?sort=categoryCode')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Item[] }
    expect(body.data.map((row) => row.id)).toEqual(['a', 'b'])
    expect(observed.sort).toBe('categoryCode')
  })

  it('accepts a member enum value and filters on it', async () => {
    const app = buildApp({ query: { enumFilters: { categoryCode: ['heavy-equipments', 'measuring-instruments'] } } })

    const response = await app.request('/policy-items/list?categoryCode=heavy-equipments')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Item[] }
    expect(body.data.map((row) => row.id)).toEqual(['a'])
  })

  it('answers 400 naming the key for a non-member enum value', async () => {
    const app = buildApp({ query: { enumFilters: { categoryCode: ['heavy-equipments'] } } })

    const response = await app.request('/policy-items/list?categoryCode=invalid')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'validation_error', message: 'Query parameter "categoryCode" must be one of: heavy-equipments.' })
  })

  it('treats an empty enum value as absent', async () => {
    const app = buildApp({ query: { enumFilters: { categoryCode: ['heavy-equipments'] } } })

    expect((await app.request('/policy-items/list?categoryCode=')).status).toBe(200)
  })
})
