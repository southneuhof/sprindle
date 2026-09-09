#!/usr/bin/env node
import { resolve } from 'node:path'
import { watchRouteManifest } from '../src/tooling/manifest.ts'

const watcher = await watchRouteManifest(resolve(process.argv[2] ?? process.cwd()), process.argv[3] ?? 'routes', (error) => {
  if (error) process.stderr.write(`${error.stack ?? error.message}\n`)
})
const close = async () => { await watcher.close(); process.exit() }
process.on('SIGINT', close)
process.on('SIGTERM', close)
