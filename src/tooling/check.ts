#!/usr/bin/env node
import { resolve } from 'node:path'
import { createRouteLanguage } from './language.ts'

const root = resolve(process.argv[2] ?? process.cwd())
const routes = process.argv[3] ?? 'routes'
const language = createRouteLanguage(root, routes)
try {
  const diagnostics = language.diagnostics()
  for (const diagnostic of diagnostics) process.stdout.write(`${JSON.stringify(diagnostic)}\n`)
  process.exitCode = diagnostics.length ? 1 : 0
} finally { language.close() }
