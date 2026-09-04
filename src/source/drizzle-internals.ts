/**
 * The only place that touches drizzle-orm's private surfaces.
 *
 * Private APIs used, and why:
 * - `Table.Symbol.ExtraConfigBuilder` / `Table.Symbol.ExtraConfigColumns` — the only way to read a
 *   table's composite `primaryKey({ columns })` declaration; drizzle exposes no public accessor.
 * - `column._.column` — unwraps the column reference a relation's `.through(...)` produces.
 *
 * Upgrade protocol: on any drizzle-orm bump, run `drizzle-internals.spec.ts` (the canary) FIRST.
 * If it is red, fix only this file — nothing else may reach into drizzle internals.
 */
import { getTableColumns, getTableName, Table } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { PrimaryKeyBuilder } from 'drizzle-orm/pg-core'

const tableSymbols = (Table as unknown as { Symbol: Record<'ExtraConfigBuilder' | 'ExtraConfigColumns', symbol> }).Symbol

export function getPrimaryKeyEntries(table: unknown): { key: string; column: AnyColumn }[] {
  const columns = getTableColumns(table as never) as Record<string, AnyColumn>
  const inline = Object.entries(columns)
    .filter(([, column]) => column.primary)
    .map(([key, column]) => ({ key, column }))
  if (inline.length) return inline

  const extraConfigBuilder = (table as { [tableSymbols.ExtraConfigBuilder]?: (columns: unknown) => unknown })[tableSymbols.ExtraConfigBuilder]
  const extraConfigColumns = (table as { [tableSymbols.ExtraConfigColumns]?: unknown })[tableSymbols.ExtraConfigColumns]
  const extraConfig = extraConfigBuilder?.(extraConfigColumns) ?? []
  const primaryKey = (Array.isArray(extraConfig) ? extraConfig : Object.values(extraConfig)).find((item) => item instanceof PrimaryKeyBuilder) as
    | { columns: { name: string }[] }
    | undefined
  const names = primaryKey?.columns.map((column) => column.name) ?? []
  if (names.length) {
    return names.map((name) => {
      const entry = Object.entries(columns).find(([, column]) => column.name === name)
      if (!entry) throw new Error(`Primary key column "${name}" not found for table "${getTableName(table as never)}"`)
      return { key: entry[0], column: entry[1] }
    })
  }

  throw new Error(`Primary key not found for table "${getTableName(table as never)}"`)
}

export function resolveThroughColumn(column: unknown): AnyColumn | undefined {
  return (column as { _?: { column?: AnyColumn } })._?.column
}
