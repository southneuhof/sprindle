#!/usr/bin/env node
import { resolve } from 'node:path'
import { watchRouteManifest } from '../src/tooling/manifest.ts'

const abort = new AbortController()
let watcher
let shutdown

function stop(signal) {
  if (shutdown) return shutdown
  process.exitCode = signal === 'SIGINT' ? 130 : 143
  abort.abort(new Error(`Route watcher received ${signal}.`))
  shutdown = (async () => {
    try { await watcher?.close() } catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`) }
  })()
  return shutdown
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(signal) })

try {
  watcher = await watchRouteManifest(resolve(process.argv[2] ?? process.cwd()), process.argv[3] ?? 'routes', (error) => {
    if (error) process.stderr.write(`${error.stack ?? error.message}\n`)
  }, '.sprindle/routes.mjs', true, { signal: abort.signal })
  if (abort.signal.aborted) await watcher.close()
} catch (error) {
  if (!abort.signal.aborted) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  }
}

if (shutdown) await shutdown
