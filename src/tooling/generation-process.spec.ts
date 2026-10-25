import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { compileRouteManifest } from './manifest.ts'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sprindle-generation-process-'))
  roots.push(root)
  mkdirSync(join(root, 'routes', 'health'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(resolve(import.meta.dirname, '../../../../apps/api/node_modules/tsx'), join(root, 'node_modules/tsx'), 'dir')
  symlinkSync(resolve(import.meta.dirname, '../../node_modules/typescript'), join(root, 'node_modules/typescript'), 'dir')
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, include: ['routes/**/*.ts'] }))
  writeFileSync(join(root, 'routes/health/+server.ts'), `export const GET=()=>'/health'`)
  const blockFile = join(root, '.block-runtime-probe')
  const markerFile = join(root, '.runtime-probe')
  const blockWorkerFile = join(root, '.block-generation-worker')
  const generatorMarker = join(root, '.blocked-generation-worker')
  const workerMarker = join(root, '.generation-worker')
  const preloadFile = join(root, 'block-runtime-probe.mjs')
  writeFileSync(preloadFile, [
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs'",
    "import { spawn } from 'node:child_process'",
    "const isGenerationWorker = String(process.argv[1] ?? '').endsWith('/generation-worker.ts') || String(process.argv[1] ?? '').endsWith('/generation-worker.js')",
    "if (isGenerationWorker) appendFileSync(process.env.SPRINDLE_GENERATION_WORKER_MARKER, JSON.stringify({ pid: process.pid, ppid: process.ppid }) + '\\n')",
    "if (isGenerationWorker && existsSync(process.env.SPRINDLE_GENERATION_BLOCK_WORKER_FILE)) { const ownerFile = `${process.cwd()}/.sprindle/generation.lock/owner.json`; const poll = setInterval(() => { if (!existsSync(ownerFile)) return; const owner = JSON.parse(readFileSync(ownerFile, 'utf8')); if (owner.pid !== process.pid) return; clearInterval(poll); const descendant = spawn(process.execPath, ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); appendFileSync(process.env.SPRINDLE_GENERATION_BLOCKED_WORKER_MARKER, JSON.stringify({ pid: process.pid, ppid: process.ppid, ownerPid: owner.pid, descendantPid: descendant.pid }) + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }, 10) }",
    "if (process.execArgv.some((value) => value.includes('sprindle-resolution:')) && existsSync(process.env.SPRINDLE_GENERATION_BLOCK_FILE)) appendFileSync(process.env.SPRINDLE_GENERATION_MARKER_FILE, JSON.stringify({ pid: process.pid, ppid: process.ppid }) + '\\n'), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
    '',
  ].join('\n'))
  return { root, blockFile, markerFile, blockWorkerFile, generatorMarker, workerMarker, preloadFile }
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function stopOwnedProcess(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    return
  }
  try { process.kill(pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

function waitForClose(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolveClose) => {
    const timer = setTimeout(() => {
      child.off('close', finish)
      resolveClose(false)
    }, timeoutMs)
    function finish() {
      clearTimeout(timer)
      resolveClose(true)
    }
    child.once('close', finish)
  })
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs: number, output: () => string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Timed out waiting for ${description}.\n${output()}`)
}

async function waitForAsync(predicate: () => Promise<boolean>, description: string, timeoutMs: number, output: () => string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Timed out waiting for ${description}.\n${output()}`)
}

function startWatcher(root: string, blockFile: string, markerFile: string, workerMarker: string, preloadFile: string, generationTimeoutMs?: number) {
  const manifest = pathToFileURL(resolve(import.meta.dirname, './manifest.ts')).href
  const timeoutOption = generationTimeoutMs === undefined ? '' : `,generationTimeoutMs:${generationTimeoutMs}`
  const code = [
    `import { watchRouteManifest } from ${JSON.stringify(manifest)}`,
    'let watcher',
    'const controller=new AbortController()',
    "const stop=()=>{controller.abort();if(!watcher)return;void watcher.close().then(()=>{process.stdout.write('CLOSED\\n')},error=>{process.stderr.write(String(error)+'\\n');process.exitCode=1})}",
    "process.on('SIGTERM',stop)",
    `watcher=await watchRouteManifest(process.cwd(),'routes',error=>{if(error)process.stderr.write(error.stack??error.message)},'.sprindle/routes.mjs',false,{signal:controller.signal${timeoutOption}})`,
    "process.stdout.write('READY\\n')",
  ].join(';')
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preloadFile).href}`].filter(Boolean).join(' '),
      SPRINDLE_GENERATION_BLOCK_FILE: blockFile,
      SPRINDLE_GENERATION_MARKER_FILE: markerFile,
      SPRINDLE_GENERATION_BLOCK_WORKER_FILE: join(root, '.block-generation-worker'),
      SPRINDLE_GENERATION_BLOCKED_WORKER_MARKER: join(root, '.blocked-generation-worker'),
      SPRINDLE_GENERATION_WORKER_MARKER: workerMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.setEncoding('utf8').on('data', (value) => output += value)
  child.stderr?.setEncoding('utf8').on('data', (value) => output += value)
  return { child, output: () => output }
}

function recordedRecords(file: string) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; ppid?: number; descendantPid?: number })
}

function recordedPids(file: string) {
  return recordedRecords(file).map(({ pid }) => pid)
}

async function cleanupWatcher(child: ChildProcess, workerMarker: string, markerFile: string, output: () => string, generatorMarker?: string) {
  const workerRecords = recordedRecords(workerMarker)
  const relatedPids = workerRecords.flatMap(({ ppid }) => ppid && ppid !== child.pid ? [ppid] : [])
  const descendantPids = recordedRecords(generatorMarker ?? '').flatMap(({ descendantPid }) => descendantPid ? [descendantPid] : [])
  const pids = [...new Set([child.pid, ...recordedPids(workerMarker), ...relatedPids, ...recordedPids(markerFile), ...recordedPids(generatorMarker ?? ''), ...descendantPids].filter((pid): pid is number => pid !== undefined))]
  for (const pid of pids) stopOwnedProcess(pid, 'SIGKILL')
  await waitForClose(child, 5000)
  await waitFor(() => pids.every((pid) => !isAlive(pid)), 'the owned watcher and generation processes to exit', 5000, output)
}

test('SIGTERM stops a watcher while its owned runtime resolver is blocked', { timeout: 20_000 }, async () => {
  const { root, blockFile, markerFile, workerMarker, preloadFile } = fixture()
  const watcher = startWatcher(root, blockFile, markerFile, workerMarker, preloadFile)
  const { child, output } = watcher
  try {
    await waitFor(() => output().includes('READY'), 'the watcher to compile and become ready', 15_000, output)
    writeFileSync(blockFile, 'block')
    writeFileSync(join(root, 'routes/health/+server.ts'), `import { basename } from 'node:path';export const GET=()=>basename('/health')`)
    await waitFor(() => existsSync(markerFile), 'the runtime probe to reach the controlled block', 15_000, output)
    const probe = JSON.parse(readFileSync(markerFile, 'utf8').trim()) as { pid: number; ppid: number }
    const lockOwner = JSON.parse(readFileSync(join(root, '.sprindle/generation.lock/owner.json'), 'utf8')) as { pid: number }
    expect(probe.ppid).toBe(lockOwner.pid)
    const started = Date.now()
    child.kill('SIGTERM')
    const closed = await waitForClose(child, 5000)
    expect(closed, `watcher did not stop within 5 seconds after SIGTERM (${Date.now() - started} ms).\n${output()}`).toBe(true)
    expect(output()).toContain('CLOSED')
  } finally {
    await cleanupWatcher(child, workerMarker, markerFile, output)
  }
})

test('watcher disconnect stops a synchronous generation owner and its descendants', { timeout: 30_000 }, async () => {
  const { root, blockFile, markerFile, blockWorkerFile, generatorMarker, workerMarker, preloadFile } = fixture()
  rmSync(join(root, 'routes/health'), { recursive: true, force: true })
  const reports = join(root, 'routes/public/reports')
  mkdirSync(reports, { recursive: true })
  const route = join(reports, '+server.ts')
  writeFileSync(route, `export const GET=()=>'/reports'`)
  const watcher = startWatcher(root, blockFile, markerFile, workerMarker, preloadFile)
  const { child, output } = watcher
  const target = join(root, '.sprindle/routes.mjs')
  try {
    await waitFor(() => output().includes('READY'), 'the watcher to publish its initial route', 15_000, output)
    const initial = await import(`${pathToFileURL(target).href}?before-disconnect`)
    expect(initial.default.map((entry: { httpPath: string }) => entry.httpPath)).toContain('/public/reports')
    const previousRuntime = readFileSync(target, 'utf8')
    writeFileSync(blockWorkerFile, 'block')
    const movedRoute = join(reports, 'create/+server.ts')
    mkdirSync(join(reports, 'create'), { recursive: true })
    writeFileSync(movedRoute, `export const GET=()=>'/changed'`)
    rmSync(route)
    await waitFor(() => existsSync(generatorMarker), 'the generation worker to block while owning the lock', 15_000, () => `${output()}\ngate=${existsSync(blockWorkerFile)}\nworkers=${existsSync(workerMarker) ? readFileSync(workerMarker, 'utf8') : 'missing'}\nlock=${existsSync(join(root, '.sprindle/generation.lock/owner.json')) ? readFileSync(join(root, '.sprindle/generation.lock/owner.json'), 'utf8') : 'missing'}`)
    const blocked = JSON.parse(readFileSync(generatorMarker, 'utf8').trim()) as { pid: number; ppid: number; ownerPid: number; descendantPid: number }
    const lockOwner = JSON.parse(readFileSync(join(root, '.sprindle/generation.lock/owner.json'), 'utf8')) as { pid: number }
    expect(blocked.pid).toBe(lockOwner.pid)
    expect(blocked.ppid).not.toBe(child.pid)
    expect(isAlive(blocked.ppid)).toBe(true)
    expect(blocked.ownerPid).toBe(blocked.pid)
    expect(isAlive(blocked.descendantPid)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(previousRuntime)
    const started = Date.now()
    child.kill('SIGKILL')
    const closed = await waitForClose(child, 5000)
    expect(closed, `watcher did not stop within 5 seconds after forced parent exit (${Date.now() - started} ms).\n${output()}`).toBe(true)
    await waitFor(() => !isAlive(blocked.pid) && !isAlive(blocked.ppid) && !isAlive(blocked.descendantPid), 'the generation supervisor, owner, and descendant to exit', 5000, () => `${output()}\nsupervisor ${blocked.ppid} alive=${isAlive(blocked.ppid)}; generator ${blocked.pid} alive=${isAlive(blocked.pid)}; descendant ${blocked.descendantPid} alive=${isAlive(blocked.descendantPid)}`)
    expect(readFileSync(target, 'utf8')).toBe(previousRuntime)
    await expect(compileRouteManifest(root, 'routes', '.sprindle/routes.mjs', false)).resolves.toBe(target)
    expect(existsSync(join(root, '.sprindle/generation.lock'))).toBe(false)
    expect(readFileSync(target, 'utf8')).not.toBe(previousRuntime)
    const recovered = await import(`${pathToFileURL(target).href}?after-disconnect`)
    expect(recovered.default.map((entry: { httpPath: string }) => entry.httpPath)).toContain('/public/reports/create')
    expect(recovered.default.map((entry: { handlers: { GET: () => string } }) => entry.handlers.GET())).toContain('/changed')
  } finally {
    await cleanupWatcher(child, workerMarker, markerFile, output, generatorMarker)
  }
})

test('a timed out generation stops before a later route edit publishes', { timeout: 60_000 }, async () => {
  const { root, blockFile, markerFile, workerMarker, preloadFile } = fixture()
  rmSync(join(root, 'routes/health'), { recursive: true, force: true })
  const reports = join(root, 'routes/public/reports')
  mkdirSync(reports, { recursive: true })
  const route = join(reports, '+server.ts')
  writeFileSync(route, `export const GET=()=>'/reports'`)
  const watcher = startWatcher(root, blockFile, markerFile, workerMarker, preloadFile, 12_000)
  const { child, output } = watcher
  const target = join(root, '.sprindle/routes.mjs')
  try {
    await waitFor(() => output().includes('READY'), 'the watcher to publish its initial route', 15_000, output)
    const initial = await import(`${pathToFileURL(target).href}?initial`)
    expect(initial.default.map((entry: { httpPath: string }) => entry.httpPath)).toContain('/public/reports')
    const previousRuntime = readFileSync(target, 'utf8')
    writeFileSync(blockFile, 'block')
    writeFileSync(route, `import { basename } from 'node:path';export const GET=()=>basename('/reports')`)
    await waitFor(() => existsSync(markerFile), 'the resolver to block while holding generation ownership', 10_000, output)
    const probe = JSON.parse(readFileSync(markerFile, 'utf8').trim()) as { pid: number; ppid: number }
    const lockOwner = JSON.parse(readFileSync(join(root, '.sprindle/generation.lock/owner.json'), 'utf8')) as { pid: number }
    expect(probe.ppid).toBe(lockOwner.pid)
    await waitFor(() => output().includes('timed out after 12000 ms'), 'the watcher to report the generation timeout', 15_000, output)
    expect(output()).toContain(target)
    expect(output()).toContain(root)
    await waitFor(() => !isAlive(lockOwner.pid) && !isAlive(probe.pid), 'the timed out generator and resolver to exit', 5000, () => `${output()}\ngenerator ${lockOwner.pid} alive=${isAlive(lockOwner.pid)}; resolver ${probe.pid} alive=${isAlive(probe.pid)}`)
    expect(readFileSync(target, 'utf8')).toBe(previousRuntime)
    const nested = join(reports, 'create')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, '+server.ts'), `export const GET=()=>'/create'`)
    rmSync(route)
    await waitForAsync(async () => {
      const generated = await import(`${pathToFileURL(target).href}?recovered=${Date.now()}`)
      return generated.default.some((entry: { httpPath: string }) => entry.httpPath === '/public/reports/create')
    }, 'a later route edit to publish /public/reports/create', 15_000, output)
  } finally {
    child.kill('SIGTERM')
    await waitForClose(child, 5000)
    await cleanupWatcher(child, workerMarker, markerFile, output)
  }
})

test('watcher shutdown preserves an aged lock owned by a live process', { timeout: 20_000 }, async () => {
  const { root, blockFile, markerFile, workerMarker, preloadFile } = fixture()
  const lock = join(root, '.sprindle/generation.lock')
  mkdirSync(lock, { recursive: true })
  const owner = { pid: process.pid, token: 'live-test-owner' }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner))
  utimesSync(lock, new Date(0), new Date(0))
  const watcher = startWatcher(root, blockFile, markerFile, workerMarker, preloadFile)
  const { child, output } = watcher
  try {
    await waitFor(() => recordedPids(workerMarker).length > 0, 'the watcher to start its generation process', 10_000, output)
    await waitFor(() => isAlive(recordedPids(workerMarker)[0]!), 'the generation process to wait on the lock', 1000, output)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toEqual(owner)
    expect(existsSync(join(root, '.sprindle/source'))).toBe(false)
  } finally {
    child.kill('SIGTERM')
    await waitForClose(child, 5000)
    await cleanupWatcher(child, workerMarker, markerFile, output)
  }
  expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toEqual(owner)
})

test('a direct runtime resolver call can cancel its blocked Node probe', { timeout: 20_000 }, async () => {
  const { root, blockFile, markerFile, workerMarker, preloadFile } = fixture()
  const abortFile = join(root, '.abort-runtime-probe')
  const route = join(root, 'routes/health/+server.ts')
  const resolution = pathToFileURL(resolve(import.meta.dirname, './resolution.ts')).href
  const code = [
    "import { existsSync } from 'node:fs'",
    `import { resolveRuntimeEdges } from ${JSON.stringify(resolution)}`,
    'const controller=new AbortController()',
    `const poll=setInterval(()=>{if(existsSync(${JSON.stringify(abortFile)})){clearInterval(poll);controller.abort(new Error('controlled cancellation'))}},20)`,
    `try{await resolveRuntimeEdges(process.cwd(),[{importer:${JSON.stringify(route)},specifier:'node:path',position:0,kind:'static',typeTargets:[]}],'source',new Map(),controller.signal);process.exitCode=2}catch(error){process.stdout.write(error.message+'\\n')}`,
  ].join(';')
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preloadFile).href}`].filter(Boolean).join(' '),
      SPRINDLE_GENERATION_BLOCK_FILE: blockFile,
      SPRINDLE_GENERATION_MARKER_FILE: markerFile,
      SPRINDLE_GENERATION_WORKER_MARKER: workerMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.setEncoding('utf8').on('data', (value) => output += value)
  child.stderr?.setEncoding('utf8').on('data', (value) => output += value)
  try {
    writeFileSync(blockFile, 'block')
    await waitFor(() => existsSync(markerFile), 'the direct runtime resolver to reach its controlled block', 10_000, () => output)
    const probe = JSON.parse(readFileSync(markerFile, 'utf8').trim()) as { pid: number }
    writeFileSync(abortFile, 'abort')
    const closed = await waitForClose(child, 5000)
    expect(closed, `direct runtime resolution did not stop after cancellation.\n${output}`).toBe(true)
    expect(output).toContain('cancelled')
    expect(output).toContain(route)
    await waitFor(() => !isAlive(probe.pid), 'the direct runtime probe to exit after cancellation', 5000, () => output)
  } finally {
    await cleanupWatcher(child, workerMarker, markerFile, () => output)
  }
})
