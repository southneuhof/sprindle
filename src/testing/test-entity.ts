import { Hono } from 'hono'
import { z } from 'zod/v4'
import { installSprindle, type SprindleInstallOptions, type SprindleInstallable } from '../hono'
import { createMemorySource } from './memory-source'
import type { ModelRuntimeEntity } from '../source'

export type TestEntitySchemas = { create: z.ZodType; update: z.ZodType; select: z.ZodType }

export type TestEntity<TRecord extends Record<string, unknown> = Record<string, unknown>> = ModelRuntimeEntity & {
  schemas: TestEntitySchemas
  rows: TRecord[]
}

/** A ready-to-mount entity backed by the memory source, with passthrough schemas by default. */
export function createTestEntity<TRecord extends Record<string, unknown> = Record<string, unknown>>(
  config: { name?: string; schemas?: Partial<TestEntitySchemas>; rows?: TRecord[]; id?: keyof TRecord & string } = {},
): TestEntity<TRecord> {
  const passthrough = z.looseObject({})
  const source = createMemorySource<TRecord>({ rows: config.rows, id: config.id })

  return {
    name: config.name ?? 'items',
    source,
    rows: source.rows,
    schemas: {
      create: config.schemas?.create ?? passthrough,
      update: config.schemas?.update ?? passthrough,
      select: config.schemas?.select ?? passthrough,
    },
  } as TestEntity<TRecord>
}

/** `installSprindle` on a fresh Hono app — go straight to `app.request(...)`. */
export function testApp<const TInstallables extends readonly SprindleInstallable[]>(
  installables: TInstallables,
  options?: SprindleInstallOptions,
) {
  return installSprindle(new Hono(), installables as never, options)
}
