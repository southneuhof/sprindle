import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import chokidar from 'chokidar'
import { watchRouteManifest } from '../dist-tooling/index.js'
import { stop } from 'esbuild'

test('watcher works with a low file limit', { timeout: 60_000 }, async () => {
  if (process.platform === 'darwin') {
    const probe = new chokidar.FSWatcher()
    assert.equal(probe.options.useFsEvents, true, 'Chokidar must use the native fsevents backend on macOS.')
    await probe.close()
  }
  const root = mkdtempSync(join(tmpdir(), 'sprindle-watcher-resource-'))
  try {
    mkdirSync(join(root, 'routes', 'health'), { recursive: true })
    for (let index = 0; index < 160; index += 1) mkdirSync(join(root, 'routes', `empty-${index}`), { recursive: true })
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    const route = join(root, 'routes', 'health', '+server.ts')
    writeFileSync(route, `export const GET = () => 'healthy'`)
    const callbacks = []
    const watcher = await watchRouteManifest(root, 'routes', (error) => callbacks.push(error), '.sprindle/routes.mjs', false, { declarations: false })
    try {
      assert.equal(callbacks.length, 1)
      assert.equal(callbacks[0], undefined)
      writeFileSync(route, `export const POST = () => 'changed'`)
      const deadline = Date.now() + 10_000
      while (callbacks.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(callbacks.length >= 2, 'The watcher must report the route edit.')
      assert.equal(callbacks.at(-1), undefined)
    } finally {
      await watcher.close()
      await stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
