import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const declarationSource = `
import { createEntity, isDomainEntity } from '@southneuhof/sprindle/entity'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod/v4'

const accounts = pgTable('accounts', { id: text('id').primaryKey() })
const account = createEntity({
  table: accounts,
  schemas: {
    create: z.object({ id: z.string() }),
    update: z.object({ id: z.string().optional() }),
    select: z.object({ id: z.string() }),
  },
})

export const declaration = account
export const recognized = isDomainEntity(account)
`

const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]))

describe('entity entry', () => {
  it('bundles declarations for browsers without backend runtime modules', async () => {
    const result = await build({
      stdin: {
        contents: declarationSource,
        resolveDir: resolve(import.meta.dirname, '../../..'),
        sourcefile: 'portable-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'portableEntry',
      write: false,
      metafile: true,
    })
    const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll('\\', '/'))
    const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports)
    const graphPaths = [...inputs, ...imports.map(({ path }) => path.replaceAll('\\', '/'))]
    const bundle = result.outputFiles[0]?.text ?? ''

    expect(inputs.filter((path) => /^src\/(?:source|model)\//.test(path))).toEqual([])
    expect(imports.filter(({ external }) => external)).toEqual([])
    expect(graphPaths.some((path) => /(?:^|\/)hono(?:\/|$)/.test(path))).toBe(false)
    expect(graphPaths.some((path) => /(?:^|\/)(?:pg|pg-pool|postgres|postgres-js|mysql2|better-sqlite3)(?:\/|$)/.test(path))).toBe(false)
    expect(imports.some(({ path }) => nodeBuiltins.has(path.replace(/^node:/, '').split('/')[0]))).toBe(false)
    const entry = runInNewContext(`${bundle}\nportableEntry`)
    expect(entry.recognized).toBe(true)
    expect(entry.declaration.name).toBe('accounts')
    expect(entry.declaration.schemas.create.safeParse({ id: 'account-1' }).success).toBe(true)
    expect(entry.declaration.schemas.create.safeParse({}).success).toBe(false)
  })
})
