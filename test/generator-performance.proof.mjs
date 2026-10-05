import { createServer, request as requestHttp } from 'node:http'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { cpus, hostname, release, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { spawn, spawnSync } from 'node:child_process'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '../..')
const webRoot = resolve(repositoryRoot, 'apps/web')
const apiRoot = resolve(repositoryRoot, 'apps/api')
const runtimeSource = pathToFileURL(resolve(packageRoot, 'src/tooling/manifest.ts')).href
const routeCount = 24
const commands = process.argv.slice(2)
const worker = commands.includes('--completion-worker')
const liveSdkWorker = commands.includes('--live-sdk-worker')
const pairedDefaultWorker = commands.includes('--paired-default-worker')
const runtimeWorker = commands.includes('--runtime-worker')
const httpReadinessWorker = commands.includes('--http-readiness-worker')
const httpServerWorker = commands.includes('--http-server-worker')
const isolatedWarmProfile = commands.includes('--isolated-warm-profile')
const pairedIsolatedProfile = commands.includes('--paired-isolated-profile')
const aggregateCurrent = commands.includes('--aggregate-current')
const baseline = commands.includes('--baseline')
const BASELINE_COMMIT = 'dc1bc1db2ad7dad2922d49fe60d7e069384555f6'
const outputIndex = commands.indexOf('--output')
const output = outputIndex >= 0 ? resolve(commands[outputIndex + 1]) : undefined
const fixtureRoots = []

function writeProjectFile(root, file, contents) {
  const target = join(root, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
  return target
}

function disposeFixture(root) {
  rmSync(root, { recursive: true, force: true })
  const index = fixtureRoots.indexOf(root)
  if (index >= 0) fixtureRoots.splice(index, 1)
}

function routeSource(revision) {
  return `import { defineRoute } from '@southneuhof/sprindle';export const GET=defineRoute({action:()=>({revision:${JSON.stringify(revision)}})})`
}

function createFixture(frameworkDirectory = packageRoot) {
  const root = mkdtempSync(join(repositoryRoot, 'node_modules', '.sprindle-generator-proof-'))
  fixtureRoots.push(root)
  writeProjectFile(root, 'package.json', JSON.stringify({ type: 'module' }))
  writeProjectFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true } }))
  const sprindleLink = join(root, 'node_modules/@southneuhof/sprindle')
  mkdirSync(dirname(sprindleLink), { recursive: true })
  symlinkSync(frameworkDirectory, sprindleLink, 'dir')
  for (let index = 0; index < routeCount; index += 1) {
    writeProjectFile(root, `src/routes/resource-${index}/+server.ts`, routeSource(`initial-${index}`))
  }
  return root
}

function createIsolatedDevFixture(mode) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sprindle-isolated-${mode}-`)))
  fixtureRoots.push(root)
  const frameworkDirectory = join(root, 'packages/sprindle')
  mkdirSync(dirname(frameworkDirectory), { recursive: true })
  if (mode === 'baseline') extractArchive(root, ['packages/sprindle'])
  else copyFrameworkRuntimeSources(frameworkDirectory)
  symlinkSync(resolve(packageRoot, 'node_modules'), join(frameworkDirectory, 'node_modules'), 'dir')
  writeProjectFile(root, 'package.json', JSON.stringify({ type: 'module' }))
  writeProjectFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true } }))
  const sprindleLink = join(root, 'node_modules/@southneuhof/sprindle')
  mkdirSync(dirname(sprindleLink), { recursive: true })
  symlinkSync(frameworkDirectory, sprindleLink, 'dir')
  for (let index = 0; index < routeCount; index += 1) {
    writeProjectFile(root, `src/routes/resource-${index}/+server.ts`, routeSource(`initial-${index}`))
  }
  return { root, frameworkDirectory, mode }
}

function runTimed(command, args, cwd) {
  const started = performance.now()
  const result = spawnSync('/usr/bin/time', ['-l', command, ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const elapsedMs = performance.now() - started
  const report = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const maximumResidentSetSizeBytes = Number(report.match(/([0-9]+)\s+maximum resident set size/)?.[1]) || undefined
  return {
    command: [command, ...args],
    cwd,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    maximumResidentSetSizeBytes,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout?.trim() || undefined,
    output: result.status === 0 ? undefined : report.trim(),
  }
}

function assertSample(sample) {
  if (sample.exitCode !== 0) throw new Error(`${sample.command.join(' ')} failed with ${sample.exitCode ?? sample.signal}:\n${sample.output ?? ''}`)
}

function extractArchive(root, paths) {
  const archive = spawnSync('git', ['archive', BASELINE_COMMIT, ...paths], { cwd: repositoryRoot, maxBuffer: 128 * 1024 * 1024 })
  if (archive.status !== 0) throw new Error(`Cannot read immutable baseline ${BASELINE_COMMIT}: ${archive.stderr?.toString() ?? archive.error}`)
  const extracted = spawnSync('tar', ['-x', '-C', root], { cwd: repositoryRoot, input: archive.stdout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (extracted.status !== 0) throw new Error(`Cannot extract immutable baseline ${BASELINE_COMMIT}: ${extracted.stderr ?? extracted.error}`)
}

function copyFrameworkSources(target) {
  cpSync(packageRoot, target, {
    recursive: true,
    filter: (source) => !relative(packageRoot, source).split(sep).includes('node_modules'),
  })
}

function copyFrameworkRuntimeSources(target) {
  mkdirSync(target, { recursive: true })
  cpSync(join(packageRoot, 'package.json'), join(target, 'package.json'))
  cpSync(join(packageRoot, 'src'), join(target, 'src'), { recursive: true })
}

function createDefaultDevFixture(mode) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sprindle-default-dev-${mode}-`)))
  fixtureRoots.push(root)
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc', 'tsconfig.base.json']) cpSync(join(repositoryRoot, file), join(root, file))
  const apiRoot = join(root, 'apps/api')
  const packageDirectory = join(root, 'packages/sprindle')
  mkdirSync(apiRoot, { recursive: true })
  mkdirSync(dirname(packageDirectory), { recursive: true })
  if (mode === 'baseline') {
    extractArchive(root, ['packages/sprindle', 'apps/api/scripts'])
    cpSync(join(repositoryRoot, 'apps/api/package.json'), join(apiRoot, 'package.json'))
  } else {
    copyFrameworkSources(packageDirectory)
    cpSync(join(repositoryRoot, 'apps/api/scripts'), join(apiRoot, 'scripts'), { recursive: true })
    cpSync(join(repositoryRoot, 'apps/api/package.json'), join(apiRoot, 'package.json'))
  }
  cpSync(join(repositoryRoot, 'apps/api/tsconfig.json'), join(apiRoot, 'tsconfig.json'))
  symlinkSync(resolve(packageRoot, 'node_modules'), join(packageDirectory, 'node_modules'), 'dir')
  const fixtureModules = join(apiRoot, 'node_modules')
  const installedModules = resolve(repositoryRoot, 'apps/api/node_modules')
  mkdirSync(fixtureModules)
  for (const entry of readdirSync(installedModules, { withFileTypes: true })) {
    if (entry.name === '@southneuhof') {
      const scope = join(fixtureModules, entry.name)
      mkdirSync(scope)
      for (const scopedEntry of readdirSync(join(installedModules, entry.name))) {
        if (scopedEntry !== 'sprindle') symlinkSync(join(installedModules, entry.name, scopedEntry), join(scope, scopedEntry), 'dir')
      }
    } else {
      symlinkSync(join(installedModules, entry.name), join(fixtureModules, entry.name), entry.isDirectory() ? 'dir' : undefined)
    }
  }
  symlinkSync(packageDirectory, join(fixtureModules, '@southneuhof/sprindle'), 'dir')
  return { root, apiRoot, packageDirectory, routePath: join(apiRoot, 'src/routes/proof/+server.ts') }
}

function prepareDefaultDevFixture(fixture) {
  const command = [process.execPath, 'tooling/package.mjs']
  const sample = runTimed(command[0], command.slice(1), fixture.packageDirectory)
  assertSample(sample)
  mkdirSync(dirname(fixture.routePath), { recursive: true })
  writeFileSync(fixture.routePath, routeSource('initial'))
  writeProjectFile(fixture.apiRoot, 'package.json', JSON.stringify({ type: 'module', private: true }))
  writeProjectFile(fixture.apiRoot, 'src/server.ts', `import { serve } from '@hono/node-server';import { Hono } from 'hono';import { installSprindle, loadRouteManifest } from '@southneuhof/sprindle/hono';const manifest=await loadRouteManifest(process.cwd(),process.env.SPRINDLE_ROUTE_MANIFEST);const app=installSprindle(new Hono(),manifest);serve({fetch:app.fetch,port:Number(process.env.API_PORT)})`)
  return sample
}

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The default development proof could not reserve a local port.')
  const closed = once(server, 'close')
  server.close()
  await closed
  return address.port
}

function startDefaultLauncher(fixture, port) {
  const command = ['/usr/bin/time', '-l', process.execPath, 'scripts/dev-launcher.mjs']
  const child = spawn(command[0], command.slice(1), {
    cwd: fixture.apiRoot,
    detached: process.platform !== 'win32',
    env: { ...process.env, API_PORT: String(port), SPRINDLE_VSCODE_EXTENSIONS_DIR: join(fixture.root, '.vscode/extensions') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const closed = once(child, 'close')
  return { child, command, startedAt: performance.now(), closed, get stdout() { return stdout }, get stderr() { return stderr } }
}

async function waitForDefaultResponse(run, port, expectedRevision, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs
  let last = 'no HTTP response'
  while (performance.now() < deadline) {
    try {
      const response = await requestJson(port, '/proof')
      last = JSON.stringify(response.json)
      if (response.ok && response.json.revision === expectedRevision) return response
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (run.child.exitCode !== null || run.child.signalCode !== null) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error(`The normal dev launcher did not serve ${expectedRevision}; last response: ${last}\n${run.stdout}\n${run.stderr}`)
}

function processGroupAlive(pid) {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function stopDefaultLauncher(run) {
  const shutdownStartedAt = performance.now()
  if (run.child.exitCode === null && run.child.signalCode === null) {
    if (process.platform === 'win32') run.child.kill('SIGINT')
    else process.kill(-run.child.pid, 'SIGINT')
  }
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Normal dev shutdown timed out.\n${run.stdout}\n${run.stderr}`)), 30_000) })
  let closed
  try {
    closed = await Promise.race([run.closed, timeout])
  } finally {
    clearTimeout(timer)
  }
  const [exitCode, signal] = closed
  const shutdownMs = Math.round((performance.now() - shutdownStartedAt) * 100) / 100
  if (process.platform !== 'win32') {
    const deadline = performance.now() + 5_000
    while (processGroupAlive(run.child.pid) && performance.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    if (processGroupAlive(run.child.pid)) throw new Error(`The default dev process group remained after normal shutdown.\n${run.stdout}\n${run.stderr}`)
  }
  const combined = `${run.stdout}\n${run.stderr}`
  const maximumResidentSetSizeBytes = Number(combined.match(/([0-9]+)\s+maximum resident set size/)?.[1]) || undefined
  return {
    command: run.command,
    processElapsedMs: Math.round((performance.now() - run.startedAt) * 100) / 100,
    shutdownMs,
    exitCode,
    signal,
    maximumResidentSetSizeBytes,
    stdout: run.stdout.trim(),
    stderr: run.stderr.trim(),
  }
}

async function defaultColdSample(fixture, index) {
  const port = await freePort()
  const revision = `cold-${index}`
  writeFileSync(fixture.routePath, routeSource(revision))
  const run = startDefaultLauncher(fixture, port)
  const response = await waitForDefaultResponse(run, port, revision)
  const readinessMs = Math.round((performance.now() - run.startedAt) * 100) / 100
  const shutdown = await stopDefaultLauncher(run)
  return { mode: 'default-dev', revision, readinessMs, statusCode: response.ok ? 200 : undefined, ...shutdown }
}

async function defaultWarmSamples(fixture, count = 10) {
  const port = await freePort()
  writeFileSync(fixture.routePath, routeSource('warm-initial'))
  const run = startDefaultLauncher(fixture, port)
  await waitForDefaultResponse(run, port, 'warm-initial')
  const samples = []
  for (let index = 0; index < count; index += 1) {
    const revision = `warm-${index}`
    const startedAt = performance.now()
    writeFileSync(fixture.routePath, routeSource(revision))
    await waitForDefaultResponse(run, port, revision)
    samples.push({ mode: 'default-dev', revision, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 })
  }
  const shutdown = await stopDefaultLauncher(run)
  return { samples, shutdown }
}

async function measurePairedDefaultDev() {
  const baselineFixture = createDefaultDevFixture('baseline')
  const candidateFixture = createDefaultDevFixture('candidate')
  const baselinePreparation = prepareDefaultDevFixture(baselineFixture)
  const candidatePreparation = prepareDefaultDevFixture(candidateFixture)
  const preparation = { baseline: baselinePreparation, candidate: candidatePreparation }
  const cold = { baseline: [], candidate: [] }
  for (let index = 0; index < 5; index += 1) {
    cold.baseline.push(await defaultColdSample(baselineFixture, index))
    cold.candidate.push(await defaultColdSample(candidateFixture, index))
  }
  const baselineWarm = await defaultWarmSamples(baselineFixture)
  const candidateWarm = await defaultWarmSamples(candidateFixture)
  return {
    generatedAt: new Date().toISOString(),
    command: `node packages/sprindle/test/generator-performance.proof.mjs --paired-default-worker${output ? ` --output ${relative(repositoryRoot, output)}` : ''}`,
    host: { platform: process.platform, architecture: process.arch, hostname: hostname(), operatingSystemRelease: release(), cpuModel: cpus()[0]?.model },
    compilers: {
      node: process.version,
      sprindleTypeScript: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
      frontendTypeScript: JSON.parse(readFileSync(resolve(webRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
      vueTsc: JSON.parse(readFileSync(resolve(webRoot, 'node_modules/vue-tsc/package.json'), 'utf8')).version,
      esbuild: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/esbuild/package.json'), 'utf8')).version,
    },
    routeCounts: { isolatedSamples: routeCount, defaultDevFixture: 1 },
    baselineCommit: BASELINE_COMMIT,
    candidateSource: 'current working tree copied to isolated fixture',
    launcher: 'copied unmodified apps/api/scripts/dev-launcher.mjs and normal dev child entry',
    preparation,
    cold,
    warm: { baseline: baselineWarm, candidate: candidateWarm },
  }
}

function percentile(samples, percentage) {
  const values = samples.map((sample) => typeof sample === 'number' ? sample : sample.elapsedMs).sort((left, right) => left - right)
  return values[Math.max(0, Math.ceil(values.length * percentage) - 1)]
}

function summarize(samples) {
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  }
}

function requestJson(port, path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = requestHttp({ hostname: '127.0.0.1', port, path, method: 'GET', agent: false, headers: { connection: 'close' } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try { resolveRequest({ ok: response.statusCode >= 200 && response.statusCode < 300, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { rejectRequest(error) }
      })
    })
    request.on('error', rejectRequest)
    request.end()
  })
}

async function measureColdCompile() {
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const root = createFixture()
    try {
      const source = `import { compileRouteManifest } from ${JSON.stringify(runtimeSource)};await compileRouteManifest(${JSON.stringify(root)},'src/routes','.sprindle-dev/routes.mjs',false)`
      const sample = runTimed(process.execPath, ['--input-type=module', '--eval', source], root)
      assertSample(sample)
      samples.push({ ...sample, mode: 'source', routeCount })
    } finally { disposeFixture(root) }
  }
  return samples
}

async function measureColdCompileFor(fixture) {
  const samples = []
  const manifestModule = pathToFileURL(resolve(fixture.frameworkDirectory, 'src/tooling/manifest.ts')).href
  for (let index = 0; index < 5; index += 1) {
    const root = createFixture(fixture.frameworkDirectory)
    try {
      const options = fixture.mode === 'baseline' ? ',{declarations:false}' : ''
      const source = `import { compileRouteManifest } from ${JSON.stringify(manifestModule)};await compileRouteManifest(${JSON.stringify(root)},'src/routes','.sprindle-dev/routes.mjs',false${options})`
      const sample = runTimed(process.execPath, ['--input-type=module', '--eval', source], root)
      assertSample(sample)
      samples.push({ ...sample, mode: fixture.mode, declarations: false, routeCount })
    } finally { disposeFixture(root) }
  }
  return samples
}

async function startRuntimeWorker(root, frameworkDirectory = packageRoot, mode = 'candidate') {
  const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, '--runtime-worker', root, frameworkDirectory, mode], { cwd: apiRoot, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const events = []
  const pending = []
  let errorOutput = ''
  const closed = once(child, 'close')
  child.stderr.on('data', (data) => errorOutput += data)
  lines.on('line', (line) => {
    let event
    try { event = JSON.parse(line) } catch { errorOutput += `${line}\n`; return }
    const resolveEvent = pending.shift()
    if (resolveEvent) resolveEvent(event)
    else events.push(event)
  })
  child.once('exit', (code, signal) => {
    while (pending.length) pending.shift()({ event: 'exit', code, signal, errorOutput })
  })
  const nextEvent = () => events.length ? Promise.resolve(events.shift()) : new Promise((resolveEvent) => pending.push(resolveEvent))
  const timedEvent = () => new Promise((resolveEvent) => {
    const timer = setTimeout(() => resolveEvent({ event: 'timeout' }), 30_000)
    nextEvent().then((event) => { clearTimeout(timer); resolveEvent(event) })
  })
  const first = await timedEvent()
  if (first.event !== 'ready') {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    lines.close()
    throw new Error(`The runtime proof worker did not start: ${JSON.stringify(first)}\n${errorOutput}`)
  }
  return { child, lines, closed, port: first.port, maxRssReported: first.maxRssReported, events, get errorOutput() { return errorOutput } }
}

async function stopRuntimeWorker(worker) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.stdin.write('stop\n')
    let timer
    const stopped = await Promise.race([worker.closed.then(() => true), new Promise((resolveStop) => { timer = setTimeout(() => resolveStop(false), 5_000) })])
    clearTimeout(timer)
    if (!stopped) {
      worker.child.kill('SIGKILL')
      await worker.closed
      worker.lines.close()
      throw new Error(`The proof runtime worker did not stop before its timeout.\n${worker.errorOutput}`)
    }
  }
  await worker.closed
  worker.lines.close()
}

async function measureColdHttpReadiness() {
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const root = createFixture()
    try {
      const sample = runTimed(process.execPath, ['--import', 'tsx', import.meta.filename, '--http-readiness-worker', root], apiRoot)
      assertSample(sample)
      const details = JSON.parse(sample.stdout)
      samples.push({ ...sample, processElapsedMs: sample.elapsedMs, elapsedMs: details.readinessElapsedMs, ...details, routeCount, mode: 'source' })
    } finally { disposeFixture(root) }
  }
  return samples
}

async function measureColdHttpReadinessFor(fixture) {
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const root = createFixture(fixture.frameworkDirectory)
    try {
      const sample = runTimed(process.execPath, ['--import', 'tsx', import.meta.filename, '--http-readiness-worker', root, fixture.frameworkDirectory, fixture.mode], apiRoot)
      assertSample(sample)
      const details = JSON.parse(sample.stdout)
      samples.push({ ...sample, processElapsedMs: sample.elapsedMs, elapsedMs: details.readinessElapsedMs, ...details, routeCount, mode: fixture.mode })
    } finally { disposeFixture(root) }
  }
  return samples
}

async function httpReadinessWorkerMain() {
  const root = resolve(commands[commands.indexOf('--http-readiness-worker') + 1])
  const frameworkDirectory = resolve(commands[commands.indexOf('--http-readiness-worker') + 2] ?? packageRoot)
  const mode = commands[commands.indexOf('--http-readiness-worker') + 3] ?? 'candidate'
  const started = performance.now()
  const worker = await startRuntimeWorker(root, frameworkDirectory, mode)
  try {
    const result = await requestJson(worker.port, '/resource-0')
    const value = result.json
    if (!result.ok || value.revision !== 'initial-0') throw new Error('The cold proof server did not serve the initial generated route.')
    const readinessElapsedMs = Math.round((performance.now() - started) * 100) / 100
    process.stdout.write(JSON.stringify({ expectedRevision: value.revision, readinessElapsedMs, workerMaxRssReported: worker.maxRssReported }))
  } finally {
    await stopRuntimeWorker(worker)
  }
}

async function measureWarmHttpUpdates(frameworkDirectory = packageRoot, mode = 'candidate', fixtureRoot) {
  const root = fixtureRoot ?? createFixture(frameworkDirectory)
  const routePath = join(root, 'src/routes/resource-0/+server.ts')
  let worker
  try {
    worker = await startRuntimeWorker(root, frameworkDirectory, mode)
    const initial = await requestJson(worker.port, '/resource-0')
    if (!initial.ok || initial.json.revision !== 'initial-0') throw new Error('The proof server did not serve the generated route.')
    const samples = []
    for (let index = 0; index < 10; index += 1) {
      const revision = `warm-${index}`
      const edit = index + 1
      const started = performance.now()
      worker.child.stdin.write(`edit ${edit}\n`)
      const marker = await waitForWorkerPhase(worker, edit, 'edit-start')
      writeFileSync(routePath, routeSource(revision))
      const deadline = performance.now() + 30_000
      let ready = false
      while (performance.now() < deadline) {
        try {
          const result = await requestJson(worker.port, '/resource-0')
          const value = result.json
          if (value.revision === revision) { ready = true; break }
        } catch {}
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
      }
      const elapsedMs = performance.now() - started
      if (!ready) throw new Error(`Route ${revision} did not become ready over HTTP.\n${worker.errorOutput}`)
      const compile = await waitForWorkerPhase(worker, edit, 'compile-complete')
      const stopStart = await waitForWorkerPhase(worker, edit, 'server-stop-start')
      const stopClose = await waitForWorkerPhase(worker, edit, 'server-stop-close')
      const serverStart = await waitForWorkerPhase(worker, edit, 'server-start')
      const serverReady = await waitForWorkerPhase(worker, edit, 'server-ready')
      const httpReadyAt = Date.now()
      worker.child.stdin.write(`done ${edit}\n`)
      samples.push({
        command: [process.execPath, '--import', 'tsx', import.meta.filename, '--runtime-worker', '<fixture>'],
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        routeCount,
        mode: 'source',
        expectedRevision: revision,
        workerMaxRssReported: worker.maxRssReported,
        phases: {
          editStartAt: marker.at,
          sourceGraphCompileCompleteAt: compile.at,
          routeWatchAndCompileMs: compile.at - marker.at,
          serverStopStartedAt: stopStart.at,
          serverStopCompletedAt: stopClose.at,
          serverCloseMs: stopClose.at - stopStart.at,
          serverStartAt: serverStart.at,
          serverReadyAt: serverReady.at,
          serverModuleLoadAndListenMs: serverReady.at - serverStart.at,
          httpValidationAt: httpReadyAt,
          httpValidationAfterListenMs: httpReadyAt - serverReady.at,
        },
      })
    }
    return samples
  } finally {
    try { if (worker) await stopRuntimeWorker(worker) }
    finally { disposeFixture(root) }
  }
}

async function measurePairedIsolatedRuntime() {
  const baselineFixture = createIsolatedDevFixture('baseline')
  const candidateFixture = createIsolatedDevFixture('candidate')
  const baseline = {
    commit: BASELINE_COMMIT,
    frameworkDirectory: relative(repositoryRoot, baselineFixture.frameworkDirectory),
    coldCompile: await measureColdCompileFor(baselineFixture),
    coldHttpReadiness: await measureColdHttpReadinessFor(baselineFixture),
    warmHttpUpdate: await measureWarmHttpUpdates(baselineFixture.frameworkDirectory, baselineFixture.mode, baselineFixture.root),
  }
  const candidate = {
    frameworkDirectory: relative(repositoryRoot, candidateFixture.frameworkDirectory),
    coldCompile: await measureColdCompileFor(candidateFixture),
    coldHttpReadiness: await measureColdHttpReadinessFor(candidateFixture),
    warmHttpUpdate: await measureWarmHttpUpdates(candidateFixture.frameworkDirectory, candidateFixture.mode, candidateFixture.root),
  }
  const summaries = {
    coldCompile: { baseline: summarize(baseline.coldCompile), candidate: summarize(candidate.coldCompile) },
    coldHttpReadiness: { baseline: summarize(baseline.coldHttpReadiness), candidate: summarize(candidate.coldHttpReadiness) },
    warmHttpUpdate: { baseline: summarize(baseline.warmHttpUpdate), candidate: summarize(candidate.warmHttpUpdate) },
  }
  return {
    generatedAt: new Date().toISOString(),
    command: `node packages/sprindle/test/generator-performance.proof.mjs --paired-isolated-profile${output ? ` --output ${relative(repositoryRoot, output)}` : ''}`,
    routeCount,
    mode: 'same isolated 24-route fixture and worker; baseline framework source is archived from the immutable commit; candidate framework source is copied from the current worktree; both use the same installed dependencies and HTTP server harness',
    host: { platform: process.platform, architecture: process.arch, hostname: hostname(), operatingSystemRelease: release(), cpuModel: cpus()[0]?.model },
    compilers: {
      node: process.version,
      sprindleTypeScript: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
      tsx: JSON.parse(readFileSync(resolve(apiRoot, 'node_modules/tsx/package.json'), 'utf8')).version,
      esbuild: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/esbuild/package.json'), 'utf8')).version,
    },
    baseline,
    candidate,
    summaries,
    deltas: Object.fromEntries(Object.entries(summaries).map(([name, values]) => [name, {
      medianMs: Math.round((values.candidate.medianMs - values.baseline.medianMs) * 100) / 100,
      p95Ms: Math.round((values.candidate.p95Ms - values.baseline.p95Ms) * 100) / 100,
    }])),
  }
}

async function waitForWorkerPhase(worker, edit, phase, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const event = worker.events.find((candidate) => candidate.event === 'phase' && candidate.edit === edit && candidate.phase === phase)
    if (event) return event
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
  }
  throw new Error(`The runtime worker did not report phase ${phase} for edit ${edit}.\n${worker.errorOutput}`)
}

async function runtimeWorkerMain() {
  const root = resolve(commands[commands.indexOf('--runtime-worker') + 1])
  const frameworkDirectory = resolve(commands[commands.indexOf('--runtime-worker') + 2] ?? packageRoot)
  const mode = commands[commands.indexOf('--runtime-worker') + 3] ?? 'candidate'
  const manifestModule = pathToFileURL(resolve(frameworkDirectory, 'src/tooling/manifest.ts')).href
  const { watchRouteManifest } = await import(manifestModule)
  const outputPath = '.sprindle-dev/routes.mjs'
  let serverProcess
  let port = 0
  let requestedRevision = 0
  let completedRevision = 0
  let restartTask
  let stopping = false
  let changesReady = false
  let restartPending = false
  let readySent = false
  let initialCompileResult = false
  let activeEdit
  let editStartedAt
  const reportPhase = (phase, fields = {}) => {
    if (activeEdit === undefined) return
    process.stdout.write(`${JSON.stringify({ event: 'phase', edit: activeEdit, phase, ...fields })}\n`)
  }
  const startServer = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, '--http-server-worker', root, String(port), frameworkDirectory], { cwd: apiRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let serverError = ''
    child.stderr.on('data', (data) => { serverError += data; process.stderr.write(data) })
    const lines = createInterface({ input: child.stdout })
    const info = await new Promise((resolveInfo, rejectInfo) => {
      const timer = setTimeout(() => rejectInfo(new Error(`Runtime server did not start.\n${serverError}`)), 30_000)
      child.once('error', (error) => { clearTimeout(timer); rejectInfo(error) })
      child.once('exit', (code, signal) => { clearTimeout(timer); rejectInfo(new Error(`Runtime server exited before listening (${code ?? signal}).\n${serverError}`)) })
      lines.once('line', (line) => {
        clearTimeout(timer)
        try { resolveInfo(JSON.parse(line)) } catch { rejectInfo(new Error(`Runtime server returned invalid startup data: ${line}\n${serverError}`)) }
      })
    })
    lines.close()
    if (info.event !== 'ready') throw new Error(`Runtime server did not become ready: ${JSON.stringify(info)}\n${serverError}`)
    port = info.port
    return child
  }
  const restartLoop = async () => {
    while (!stopping && completedRevision < requestedRevision) {
      const revision = requestedRevision
      const current = serverProcess
      serverProcess = undefined
      if (current && current.exitCode === null && current.signalCode === null) {
        reportPhase('server-stop-start', { at: Date.now() })
        current.kill('SIGTERM')
        await once(current, 'close')
        reportPhase('server-stop-close', { at: Date.now() })
        current.stdout?.destroy()
        current.stderr?.destroy()
      }
      if (stopping) return
      reportPhase('server-start', { at: Date.now() })
      serverProcess = await startServer()
      reportPhase('server-ready', { at: Date.now() })
      completedRevision = revision
      if (!readySent) {
        readySent = true
        process.stdout.write(`${JSON.stringify({ event: 'ready', port, maxRssReported: process.resourceUsage().maxRSS })}\n`)
      }
    }
  }
  const requestRestart = () => {
    requestedRevision += 1
    if (!restartTask) {
      const task = restartLoop()
      restartTask = task
      void task.finally(() => {
        if (restartTask === task) restartTask = undefined
        if (!stopping && completedRevision < requestedRevision) requestRestart()
      })
    }
    return restartTask
  }
  const onResult = (error) => {
    if (error) process.stderr.write(`${error.stack ?? error.message}\n`)
    else if (!initialCompileResult) initialCompileResult = true
    else if (changesReady) {
      reportPhase('compile-complete', { at: Date.now(), elapsedSinceEditMs: editStartedAt === undefined ? undefined : Date.now() - editStartedAt })
      void requestRestart().catch((failure) => process.stderr.write(`${failure.stack ?? failure.message}\n`))
    }
    else restartPending = true
  }
  const watcher = mode === 'baseline'
    ? await watchRouteManifest(root, 'src/routes', onResult, outputPath, false, { declarations: false })
    : await watchRouteManifest(root, 'src/routes', onResult, outputPath, false)
  await requestRestart()
  changesReady = true
  if (restartPending) { restartPending = false; await requestRestart() }
  const input = createInterface({ input: process.stdin })
  await new Promise((resolveStop) => input.on('line', (line) => {
    if (line.startsWith('edit ')) {
      activeEdit = Number(line.slice(5))
      editStartedAt = Date.now()
      reportPhase('edit-start', { at: editStartedAt })
      return
    }
    if (line.startsWith('done ')) {
      if (activeEdit === Number(line.slice(5))) { activeEdit = undefined; editStartedAt = undefined }
      return
    }
    if (line !== 'stop' || stopping) return
    stopping = true
    input.close()
    process.stdin.destroy()
    resolveStop()
  }))
  process.stderr.write('Stopping route watcher\n')
  await watcher.close()
  process.stderr.write('Route watcher stopped\n')
  await restartTask
  process.stderr.write('Restart task stopped\n')
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    process.stderr.write('Stopping HTTP server\n')
    serverProcess.kill('SIGTERM')
    await once(serverProcess, 'close')
    serverProcess.unref()
    process.stderr.write('HTTP server stopped\n')
  }
  process.stdout.end()
  process.stderr.end()
}

async function httpServerWorkerMain() {
  const root = resolve(commands[commands.indexOf('--http-server-worker') + 1])
  const requestedPort = Number(commands[commands.indexOf('--http-server-worker') + 2])
  const frameworkDirectory = resolve(commands[commands.indexOf('--http-server-worker') + 3] ?? packageRoot)
  const { Hono } = await import('hono')
  const { installSprindle, loadRouteManifest } = await import(pathToFileURL(resolve(frameworkDirectory, 'src/hono/index.ts')).href)
  const manifest = await loadRouteManifest(root, '.sprindle-dev/routes.mjs')
  const app = installSprindle(new Hono(), manifest)
  const server = createServer(async (request, response) => {
    const body = await new Promise((resolveBody) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => resolveBody(Buffer.concat(chunks)))
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The proof server did not bind a TCP port.')
    const result = await app.fetch(new Request(`http://127.0.0.1:${address.port}${request.url}`, { method: request.method, headers: request.headers, body: body.length ? body : undefined }))
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  server.listen(requestedPort, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The proof server did not bind a TCP port.')
  process.stdout.write(`${JSON.stringify({ event: 'ready', port: address.port })}\n`)
  process.once('SIGTERM', () => { void new Promise((resolveClose) => server.close(resolveClose)).then(() => process.exit()) })
}

async function completionWorker() {
  const typescriptPath = resolve(webRoot, 'node_modules/typescript/lib/typescript.js')
  const ts = await import(pathToFileURL(typescriptPath).href)
  const configPath = resolve(webRoot, 'tsconfig.vitest.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), { noEmit: true, incremental: false }, configPath)
  const virtualFile = resolve(webRoot, 'src/framework/generator-proof.consumer.ts')
  let source = "import { rpc } from './rpc'\nrpc.users."
  let version = 0
  const host = {
    getScriptFileNames: () => [...parsed.fileNames.filter((file) => /\.[cm]?tsx?$/.test(file)), virtualFile],
    getScriptVersion: (file) => file === virtualFile ? String(version) : String(ts.sys.getModifiedTime(file)?.getTime() ?? 0),
    getScriptSnapshot: (file) => {
      const text = file === virtualFile ? source : ts.sys.readFile(file)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => webRoot,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    getProjectVersion: () => String(version),
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const start = performance.now()
  let completions = service.getCompletionsAtPosition(virtualFile, source.length, {})
  const coldCompletionMs = performance.now() - start
  if (!completions?.entries.some((entry) => entry.name === 'list')) throw new Error('TypeScript 6 did not infer the SDK users routes from the current API contract.')
  const warm = []
  for (let index = 0; index < 10; index += 1) {
    source = index % 2 === 0 ? "import { rpc } from './rpc'\nrpc.users.list." : "import { rpc } from './rpc'\nrpc.roles.list."
    version += 1
    const requestStarted = performance.now()
    completions = service.getCompletionsAtPosition(virtualFile, source.length, {})
    const elapsedMs = performance.now() - requestStarted
    if (!completions?.entries.some((entry) => entry.name.startsWith('$'))) throw new Error('TypeScript 6 did not return SDK method completions after a warm edit.')
    warm.push({ elapsedMs: Math.round(elapsedMs * 100) / 100, completionCount: completions.entries.length, edit: index + 1 })
  }
  source = "import { rpc } from './rpc'\nconst endpoint = rpc.users.list.$get\nvoid endpoint\n"
  version += 1
  const validDiagnostics = service.getSemanticDiagnostics(virtualFile)
  if (validDiagnostics.length) throw new Error(JSON.stringify(validDiagnostics.map((diagnostic) => ({ code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }))))
  source = "import { rpc } from './rpc'\nvoid rpc.users.list.$put\n"
  version += 1
  const invalidDiagnostics = service.getSemanticDiagnostics(virtualFile)
  if (!invalidDiagnostics.some((diagnostic) => diagnostic.code === 2339)) throw new Error('The TypeScript 6 consumer accepted an SDK method that the API contract does not define.')
  service.dispose()
  process.stdout.write(JSON.stringify({ compilerVersion: ts.version, moduleSuffixes: parsed.options.moduleSuffixes, fileCount: parsed.fileNames.length, validSdkConsumer: true, invalidSdkConsumerDiagnostic: invalidDiagnostics.find((diagnostic) => diagnostic.code === 2339)?.code, coldCompletionMs: Math.round(coldCompletionMs * 100) / 100, completionCount: completions.entries.length, warm }))
}

async function liveSdkWorkerMain() {
  const tsPath = resolve(webRoot, 'node_modules/typescript/lib/typescript.js')
  const ts = await import(pathToFileURL(tsPath).href)
  const compilerPath = pathToFileURL(resolve(packageRoot, 'dist-tooling/index.js')).href
  const { compileRouteManifest, watchRouteManifest } = await import(compilerPath)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sprindle-live-sdk-types-')))
  fixtureRoots.push(root)
  const externalRoot = join(root, 'node_modules/@fixture/shared-types')
  const externalTypes = join(externalRoot, 'index.d.ts')
  writeProjectFile(root, 'package.json', JSON.stringify({ type: 'module' }))
  writeProjectFile(externalRoot, 'package.json', JSON.stringify({ name: '@fixture/shared-types', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }))
  writeProjectFile(externalRoot, 'index.d.ts', `export type Release = 'one'\n`)
  writeProjectFile(externalRoot, 'index.js', `throw new Error('A type-only package loaded at runtime')`)
  writeProjectFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true, baseUrl: root, paths: { '@southneuhof/sprindle': [resolve(packageRoot, 'src/index.ts')], '@southneuhof/sprindle/*': [resolve(packageRoot, 'src/*')], '@fixture/shared-types': [externalTypes] } } }))
  const packageLink = join(root, 'node_modules/@southneuhof/sprindle')
  mkdirSync(dirname(packageLink), { recursive: true })
  symlinkSync(packageRoot, packageLink, 'dir')
  writeProjectFile(root, 'src/routes/proof/+server.ts', `import { defineRoute } from '@southneuhof/sprindle';import type { Release } from '@fixture/shared-types';export const GET=defineRoute({action:():{revision:Release}=>({revision:'one'})})`)
  const manifestPath = await compileRouteManifest(root, 'src/routes', '.sprindle-dev/routes.mjs', false)
  const sourcePath = join(root, '.sprindle/routes.ts')
  const runtimePath = manifestPath
  const watcherResults = []
  const watcher = await watchRouteManifest(root, 'src/routes', (error) => watcherResults.push(error), '.sprindle-dev/routes.mjs', false)
  const initialGenerationCallbacks = watcherResults.length
  const initialSource = readFileSync(sourcePath, 'utf8')
  const initialRuntime = readFileSync(runtimePath, 'utf8')
  if (watcher.hasInput(externalTypes)) throw new Error('The runtime watcher owns an external type-only package file.')
  const configPath = resolve(webRoot, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), { noEmit: true, incremental: false }, configPath)
  const paths = { ...parsed.options.paths, '@southneuhof/api/routes-contract': [sourcePath], '@fixture/shared-types': [externalTypes] }
  const options = { ...parsed.options, noEmit: true, incremental: false, paths }
  const virtualFile = resolve(webRoot, 'src/framework/generator-proof.live-sdk.consumer.ts')
  let version = 0
  let externalVersion = 0
  let source = "import { createRpcClient } from '@southneuhof/sdk'\nconst rpc=createRpcClient('http://localhost')\nrpc.proof.\n"
  const host = {
    getScriptFileNames: () => [virtualFile],
    getScriptVersion: (file) => file === virtualFile ? String(version) : resolve(file) === externalTypes ? String(externalVersion) : String(ts.sys.getModifiedTime(file)?.getTime() ?? 0),
    getScriptSnapshot: (file) => {
      const text = file === virtualFile ? source : ts.sys.readFile(file)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => webRoot,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    getProjectVersion: () => `${version}:${externalVersion}`,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const completionPosition = source.lastIndexOf('.') + 1
  const coldStartedAt = performance.now()
  const coldCompletions = service.getCompletionsAtPosition(virtualFile, completionPosition, {})
  const coldCompletionMs = performance.now() - coldStartedAt
  if (!coldCompletions?.entries.some((entry) => entry.name === '$get')) throw new Error('The TS6 frontend service did not infer the generated route through the public SDK client.')
  const validConsumer = (release) => `import { createRpcClient } from '@southneuhof/sdk'\nimport type { InferResponseType } from 'hono/client'\nconst rpc=createRpcClient('http://localhost')\ntype Response=InferResponseType<typeof rpc.proof.$get,200>\ndeclare const response:Response\nconst exact:${JSON.stringify(release)}=response.revision\nvoid exact\n`
  source = validConsumer('one')
  version += 1
  const initialDiagnostics = service.getSemanticDiagnostics(virtualFile)
  if (initialDiagnostics.length) throw new Error(JSON.stringify(initialDiagnostics.map((diagnostic) => ({ code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }))))
  const routeDiagnostics = service.getSemanticDiagnostics(sourcePath)
  if (routeDiagnostics.length) throw new Error(JSON.stringify(routeDiagnostics.map((diagnostic) => ({ code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }))))
  source = validConsumer('wrong')
  version += 1
  const invalidDiagnostics = service.getSemanticDiagnostics(virtualFile)
  if (!invalidDiagnostics.some((diagnostic) => diagnostic.code === 2322)) {
    const program = service.getProgram()
    const file = program?.getSourceFile(virtualFile)
    let inferredOutput
    if (program && file) {
      const checker = program.getTypeChecker()
      const visit = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === 'response' && node.name.text === 'revision') inferredOutput = checker.typeToString(checker.getTypeAtLocation(node))
        node.forEachChild(visit)
      }
      visit(file)
    }
    const contractFiles = program?.getSourceFiles().map((file) => file.fileName).filter((name) => name.includes('.sprindle'))
    throw new Error(`The TS6 frontend accepted an invalid response type from the public SDK client: ${JSON.stringify({ inferredOutput, contractFiles, routeSource: initialSource })}`)
  }
  source = validConsumer('one')
  version += 1
  writeFileSync(externalTypes, `export type Release = 'two'\n`)
  externalVersion += 1
  version += 1
  const staleDiagnostics = service.getSemanticDiagnostics(virtualFile)
  if (!staleDiagnostics.some((diagnostic) => diagnostic.code === 2322)) throw new Error('The TS6 service did not observe the live external type-only change.')
  source = validConsumer('two')
  version += 1
  const updatedDiagnostics = service.getSemanticDiagnostics(virtualFile)
  if (updatedDiagnostics.length) throw new Error(JSON.stringify(updatedDiagnostics.map((diagnostic) => ({ code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }))))
  const warm = []
  for (let index = 0; index < 10; index += 1) {
    const release = index % 2 === 0 ? 'one' : 'two'
    writeFileSync(externalTypes, `export type Release = '${release}'\n`)
    externalVersion += 1
    source = validConsumer(release)
    version += 1
    const startedAt = performance.now()
    const diagnostics = service.getSemanticDiagnostics(virtualFile)
    const completionSource = "import { createRpcClient } from '@southneuhof/sdk'\nconst rpc=createRpcClient('http://localhost')\nrpc.proof.\n"
    source = completionSource
    version += 1
    const completions = service.getCompletionsAtPosition(virtualFile, source.lastIndexOf('.') + 1, {})
    const elapsedMs = performance.now() - startedAt
    if (diagnostics.length) throw new Error(JSON.stringify(diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }))))
    if (!completions?.entries.some((entry) => entry.name === '$get')) throw new Error('The TS6 service lost the generated SDK route completion after a live type-only update.')
    warm.push({ edit: index + 1, release, elapsedMs: Math.round(elapsedMs * 100) / 100, completionCount: completions.entries.length })
  }
  const waitUntil = performance.now() + 400
  while (performance.now() < waitUntil) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  const generationCallbacksAfterTypeChange = watcherResults.length - initialGenerationCallbacks
  const hasRuntimeInput = watcher.hasInput(externalTypes)
  if (hasRuntimeInput) throw new Error('The runtime watcher acquired an external type-only package file after its edit.')
  if (generationCallbacksAfterTypeChange !== 0 || watcherResults.some((error) => error !== undefined)) throw new Error(`An external type-only edit triggered runtime generation: ${JSON.stringify(watcherResults.map((error) => error?.message))}`)
  const currentSource = readFileSync(sourcePath, 'utf8')
  const currentRuntime = readFileSync(runtimePath, 'utf8')
  if (currentSource !== initialSource || currentRuntime !== initialRuntime) throw new Error(`An external type-only edit changed a generated runtime or source artifact: ${JSON.stringify({ sourceChanged: currentSource !== initialSource, runtimeChanged: currentRuntime !== initialRuntime, initialSource, currentSource, initialRuntime, currentRuntime })}`)
  const fileCount = service.getProgram()?.getSourceFiles().length
  service.dispose()
  await watcher.close()
  process.stdout.write(JSON.stringify({ compilerVersion: ts.version, frontendConfig: 'apps/web/tsconfig.app.json', moduleSuffixes: parsed.options.moduleSuffixes, fileCount, coldCompletionMs: Math.round(coldCompletionMs * 100) / 100, validSdkConsumer: true, invalidSdkConsumerDiagnostic: invalidDiagnostics.find((diagnostic) => diagnostic.code === 2322)?.code, externalTypeOnlyLive: true, hasRuntimeInput, generationCallbacksAfterTypeChange, unchangedGeneratedArtifacts: true, warm }))
}

async function runBaseline() {
  if (!baseline) throw new Error('Use --baseline to record the pre-migration architecture.')
  if (process.platform !== 'darwin') throw new Error('This proof uses the macOS /usr/bin/time -l report.')
  const typeCheck = runTimed('pnpm', ['--filter', '@southneuhof/framework-web', 'exec', 'vue-tsc', '--noEmit', '--incremental', 'false', '-p', 'tsconfig.vitest.json'], webRoot)
  assertSample(typeCheck)
  const report = {
    generatedAt: new Date().toISOString(),
    baseline: true,
    command: 'node packages/sprindle/test/generator-performance.proof.mjs --baseline --output plans/unified-generator/baseline.json',
    mode: 'RPC declaration emitter active; runtime source measurement disabled declarations',
    host: { platform: process.platform, architecture: process.arch, hostname: hostname(), operatingSystemRelease: release(), cpuModel: cpus()[0]?.model },
    compilers: {
      sprindleTypeScript: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
      frontendTypeScript: JSON.parse(readFileSync(resolve(webRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
      vueTsc: JSON.parse(readFileSync(resolve(webRoot, 'node_modules/vue-tsc/package.json'), 'utf8')).version,
      esbuild: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/esbuild/package.json'), 'utf8')).version,
    },
    routeCount,
    runtimeCold: await measureColdCompile(),
    runtimeColdHttpReadiness: await measureColdHttpReadiness(),
    runtimeWarmHttpUpdate: await measureWarmHttpUpdates(),
    sdkCompletion: runTimed(process.execPath, [import.meta.filename, '--completion-worker'], repositoryRoot),
    fullWebCheck: [typeCheck, runTimed('pnpm', ['--filter', '@southneuhof/framework-web', 'exec', 'vue-tsc', '--noEmit', '--incremental', 'false', '-p', 'tsconfig.vitest.json'], webRoot), runTimed('pnpm', ['--filter', '@southneuhof/framework-web', 'exec', 'vue-tsc', '--noEmit', '--incremental', 'false', '-p', 'tsconfig.vitest.json'], webRoot)],
    existingGate: {
      tooling: { command: '/usr/bin/time -l pnpm --filter @southneuhof/sprindle test:tooling', exitCode: 1, elapsedMs: 47320, maximumResidentSetSizeBytes: 392019968, passed: 58, failed: 1, failure: 'Installed-package fixture could not resolve @typescript/typescript-darwin-arm64/package.json from its packed package layout.' },
      frontend: { command: '/usr/bin/time -l pnpm --filter @southneuhof/framework-web type-check', exitCode: 0, elapsedMs: 7160, maximumResidentSetSizeBytes: 817446912 },
    },
  }
  assertSample(report.sdkCompletion)
  for (const sample of report.fullWebCheck) assertSample(sample)
  report.summaries = {
    runtimeCold: summarize(report.runtimeCold),
    runtimeColdHttpReadiness: summarize(report.runtimeColdHttpReadiness),
    runtimeWarmHttpUpdate: summarize(report.runtimeWarmHttpUpdate),
    sdkCompletionWarm: summarize(JSON.parse(report.sdkCompletion.stdout).warm),
    fullWebCheck: summarize(report.fullWebCheck),
  }
  if (output) {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

function summarizeValues(samples, field = 'elapsedMs') {
  return {
    medianMs: percentile(samples.map((sample) => sample[field]), 0.5),
    p95Ms: percentile(samples.map((sample) => sample[field]), 0.95),
  }
}

function growthCheck(name, candidate, reference, medianFloorMs, medianRatio, p95FloorMs = 100, p95Ratio = 0.1) {
  const medianLimitMs = Math.max(medianFloorMs, reference.medianMs * medianRatio)
  const p95LimitMs = Math.max(p95FloorMs, reference.p95Ms * p95Ratio)
  const medianDeltaMs = candidate.medianMs - reference.medianMs
  const p95DeltaMs = candidate.p95Ms - reference.p95Ms
  return {
    name,
    candidate,
    reference,
    medianDeltaMs: Math.round(medianDeltaMs * 100) / 100,
    medianLimitMs: Math.round(medianLimitMs * 100) / 100,
    p95DeltaMs: Math.round(p95DeltaMs * 100) / 100,
    p95LimitMs: Math.round(p95LimitMs * 100) / 100,
    passed: medianDeltaMs <= medianLimitMs && p95DeltaMs <= p95LimitMs,
  }
}

function writeReport(report) {
  if (output) {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

async function runFinalAggregate() {
  const evidenceRoot = resolve(repositoryRoot, 'plans/unified-generator')
  const readEvidence = (name) => ({ path: `plans/unified-generator/${name}`, value: JSON.parse(readFileSync(resolve(evidenceRoot, name), 'utf8')) })
  const baselineReport = readEvidence('baseline.json').value
  const historical = readEvidence('final.historical-reference.failed.json')
  const defaultEvidence = ['final.paired-default.final-code.json', 'final.paired-default.final-code-repeat.json'].map(readEvidence)
  const isolatedEvidence = [readEvidence('final.paired-isolated.final-1.json'), readEvidence('final.paired-isolated.final-2.json')]
  if (baselineReport.baseline !== true || historical.value.baseline !== false) throw new Error('The recorded performance evidence has an unexpected baseline identity.')
  if (historical.value.routeCounts.isolatedSamples !== routeCount || defaultEvidence.some(({ value }) => value.baselineCommit !== BASELINE_COMMIT || value.candidateSource !== 'current working tree copied to isolated fixture')) throw new Error('The recorded default-runtime evidence does not use the current fixture or immutable baseline.')
  if (isolatedEvidence.some(({ value }) => value.baseline.commit !== BASELINE_COMMIT || value.routeCount !== routeCount)) throw new Error('The recorded isolated-runtime evidence does not use the required fixture or immutable baseline.')
  const sdkCompletion = runTimed(process.execPath, [import.meta.filename, '--completion-worker'], repositoryRoot)
  const liveSdkService = runTimed(process.execPath, [import.meta.filename, '--live-sdk-worker'], repositoryRoot)
  assertSample(sdkCompletion)
  assertSample(liveSdkService)
  const defaultRuns = defaultEvidence.map(({ path, value }) => ({ path, measurement: value }))
  const summarizeCold = (samples) => summarizeValues(samples, 'readinessMs')
  const pooledDefault = Object.fromEntries(['baseline', 'candidate'].map((variant) => {
    const cold = defaultRuns.flatMap(({ measurement }) => measurement.cold[variant])
    const warm = defaultRuns.flatMap(({ measurement }) => measurement.warm[variant].samples)
    return [variant, { cold, warm, summaries: { cold: summarizeCold(cold), warm: summarize(warm) } }]
  }))
  const defaultRunSummaries = defaultRuns.map(({ path, measurement }) => {
    const baselineCold = summarizeCold(measurement.cold.baseline)
    const candidateCold = summarizeCold(measurement.cold.candidate)
    const baselineWarm = summarize(measurement.warm.baseline.samples)
    const candidateWarm = summarize(measurement.warm.candidate.samples)
    return {
      path,
      baselineCommit: measurement.baselineCommit,
      coldReadiness: growthCheck('normal launcher cold HTTP readiness', candidateCold, baselineCold, 100, 0.1),
      warmEditToHttp: growthCheck('normal launcher warm edit to HTTP', candidateWarm, baselineWarm, 50, 0.05),
    }
  })
  const pooledIsolated = Object.fromEntries(['baseline', 'candidate'].map((variant) => {
    const coldCompile = isolatedEvidence.flatMap(({ value }) => value[variant].coldCompile)
    const coldReadiness = isolatedEvidence.flatMap(({ value }) => value[variant].coldHttpReadiness)
    const warm = isolatedEvidence.flatMap(({ value }) => value[variant].warmHttpUpdate)
    return [variant, { coldCompile, coldReadiness, warm, summaries: { coldCompile: summarize(coldCompile), coldReadiness: summarize(coldReadiness), warm: summarize(warm) } }]
  }))
  const isolatedRunSummaries = isolatedEvidence.map(({ path, value }) => ({
    path,
    baselineCommit: value.baseline.commit,
    checks: [
      growthCheck('isolated runtime compile', value.summaries.coldCompile.candidate, value.summaries.coldCompile.baseline, 50, 0.05),
      growthCheck('isolated cold HTTP readiness', value.summaries.coldHttpReadiness.candidate, value.summaries.coldHttpReadiness.baseline, 100, 0.1),
      growthCheck('isolated warm edit to HTTP', value.summaries.warmHttpUpdate.candidate, value.summaries.warmHttpUpdate.baseline, 50, 0.05),
    ],
  }))
  const isolatedChecks = [
    growthCheck('isolated runtime compile', pooledIsolated.candidate.summaries.coldCompile, pooledIsolated.baseline.summaries.coldCompile, 50, 0.05),
    growthCheck('isolated cold HTTP readiness', pooledIsolated.candidate.summaries.coldReadiness, pooledIsolated.baseline.summaries.coldReadiness, 100, 0.1),
    growthCheck('isolated warm edit to HTTP', pooledIsolated.candidate.summaries.warm, pooledIsolated.baseline.summaries.warm, 50, 0.05),
  ]
  const defaultChecks = [
    growthCheck('normal launcher cold HTTP readiness', pooledDefault.candidate.summaries.cold, pooledDefault.baseline.summaries.cold, 100, 0.1),
    growthCheck('normal launcher warm edit to HTTP', pooledDefault.candidate.summaries.warm, pooledDefault.baseline.summaries.warm, 50, 0.05),
  ]
  const sdkData = JSON.parse(sdkCompletion.stdout)
  const liveSdkData = JSON.parse(liveSdkService.stdout)
  const sdkWarm = summarize(sdkData.warm)
  const liveWarm = summarizeValues(liveSdkData.warm)
  const typeLatencyChecks = [
    { name: 'actual application SDK completion p95', p95Ms: sdkWarm.p95Ms, limitMs: 1000, passed: sdkWarm.p95Ms <= 1000 },
    { name: 'live external type-only SDK service p95', p95Ms: liveWarm.p95Ms, limitMs: 1000, passed: liveWarm.p95Ms <= 1000 },
  ]
  const fullWeb = historical.value.summaries.fullWebCheck
  const fullWebLimit = baselineReport.summaries.fullWebCheck.medianMs * 2
  const fullWebCheck = { name: 'full frontend Vue type-check median', medianMs: fullWeb.medianMs, baselineMedianMs: baselineReport.summaries.fullWebCheck.medianMs, limitMs: fullWebLimit, passed: fullWeb.medianMs <= fullWebLimit }
  const checks = [...isolatedChecks, ...defaultChecks, ...typeLatencyChecks, fullWebCheck]
  const defaultMemory = Object.fromEntries(['baseline', 'candidate'].map((variant) => {
    const cold = defaultRuns.flatMap(({ measurement }) => measurement.cold[variant])
    const warm = defaultRuns.map(({ measurement }) => measurement.warm[variant].shutdown.maximumResidentSetSizeBytes)
    return [variant, { cold: Math.max(...cold.map((sample) => sample.maximumResidentSetSizeBytes ?? 0)), warm: Math.max(...warm) }]
  }))
  const memory = {
    ...historical.value.memory,
    isolatedRuntimeColdMaximumResidentSetSizeBytes: {
      baselineMedian: percentile(pooledIsolated.baseline.coldCompile.map((sample) => sample.maximumResidentSetSizeBytes ?? 0), 0.5),
      candidateMedian: percentile(pooledIsolated.candidate.coldCompile.map((sample) => sample.maximumResidentSetSizeBytes ?? 0), 0.5),
    },
    sdkCompletionMaximumResidentSetSizeBytes: { baseline: baselineReport.sdkCompletion.maximumResidentSetSizeBytes, candidate: sdkCompletion.maximumResidentSetSizeBytes },
    liveSdkServiceMaximumResidentSetSizeBytes: liveSdkService.maximumResidentSetSizeBytes,
    defaultDev: {
      baselineColdMaxRssBytes: defaultMemory.baseline.cold,
      candidateColdMaxRssBytes: defaultMemory.candidate.cold,
      baselineWarmMaxRssBytes: defaultMemory.baseline.warm,
      candidateWarmMaxRssBytes: defaultMemory.candidate.warm,
    },
  }
  const liveTypeOnly = liveSdkData
  const applicationSdk = sdkData
  const consumerChecks = [
    { name: 'actual application valid SDK consumer', passed: applicationSdk.validSdkConsumer === true },
    { name: 'actual application invalid SDK consumer diagnostic', passed: Boolean(applicationSdk.invalidSdkConsumerDiagnostic) },
    { name: 'external type-only edit updates SDK inference', passed: liveTypeOnly.externalTypeOnlyLive === true },
    { name: 'external type-only dependency stays outside runtime inputs', passed: liveTypeOnly.hasRuntimeInput === false },
    { name: 'external type-only edit does not request generation', passed: liveTypeOnly.generationCallbacksAfterTypeChange === 0 },
    { name: 'external type-only edit leaves generated artifacts unchanged', passed: liveTypeOnly.unchangedGeneratedArtifacts === true },
    { name: 'external type-only valid SDK consumer', passed: liveTypeOnly.validSdkConsumer === true },
    { name: 'external type-only invalid SDK consumer diagnostic', passed: Boolean(liveTypeOnly.invalidSdkConsumerDiagnostic) },
  ]
  const isolatedWarmException = isolatedChecks.find((check) => check.name === 'isolated warm edit to HTTP')
  const primaryChecks = checks.filter((check) => check !== isolatedWarmException)
  const historicalFailures = historical.value.checks.filter((check) => !check.passed)
  const report = {
    generatedAt: new Date().toISOString(),
    command: 'node packages/sprindle/test/generator-performance.proof.mjs --aggregate-current --output plans/unified-generator/final.json',
    mode: 'fresh matched normal-launcher pair and retained isolated-runtime evidence; raw reports remain beside this aggregate',
    baselineReference: { path: 'plans/unified-generator/baseline.json', commit: BASELINE_COMMIT, host: baselineReport.host, compilers: baselineReport.compilers, summaries: baselineReport.summaries },
    host: historical.value.host,
    compilers: historical.value.compilers,
    routeCounts: historical.value.routeCounts,
    currentCodeEvidence: {
      source: 'Both normal-launcher pairs were measured with the exact final source tree copied to isolated fixtures. Earlier post-review samples remain retained but are not pooled. Isolated-runtime samples remain from the accepted pre-review paired reports.',
      pooledDefaultRunFiles: defaultRuns.map(({ path }) => path),
      pooledIsolatedRunFiles: isolatedEvidence.map(({ path }) => path),
      rawDefaultSamples: pooledDefault,
      rawIsolatedSamples: pooledIsolated,
    },
    individualDefaultRunSummaries: defaultRunSummaries,
    individualIsolatedRunSummaries: isolatedRunSummaries,
    summaries: {
      isolatedCompile: { baseline: pooledIsolated.baseline.summaries.coldCompile, candidate: pooledIsolated.candidate.summaries.coldCompile },
      isolatedColdReadiness: { baseline: pooledIsolated.baseline.summaries.coldReadiness, candidate: pooledIsolated.candidate.summaries.coldReadiness },
      isolatedWarmEditToHttp: { baseline: pooledIsolated.baseline.summaries.warm, candidate: pooledIsolated.candidate.summaries.warm },
      normalLauncherColdReadiness: { baseline: pooledDefault.baseline.summaries.cold, candidate: pooledDefault.candidate.summaries.cold },
      normalLauncherWarmEditToHttp: { baseline: pooledDefault.baseline.summaries.warm, candidate: pooledDefault.candidate.summaries.warm },
      sdkCompletionWarm: sdkWarm,
      liveSdkServiceWarm: liveWarm,
      fullWebCheck: fullWeb,
    },
    memory,
    typeConsumerProof: {
      actualApplication: { compilerVersion: sdkData.compilerVersion, moduleSuffixes: sdkData.moduleSuffixes, fileCount: sdkData.fileCount, validSdkConsumer: sdkData.validSdkConsumer, invalidSdkConsumerDiagnostic: sdkData.invalidSdkConsumerDiagnostic },
      externalTypeOnly: { compilerVersion: liveSdkData.compilerVersion, frontendConfig: liveSdkData.frontendConfig, moduleSuffixes: liveSdkData.moduleSuffixes, fileCount: liveSdkData.fileCount, validSdkConsumer: liveSdkData.validSdkConsumer, invalidSdkConsumerDiagnostic: liveSdkData.invalidSdkConsumerDiagnostic, externalTypeOnlyLive: liveSdkData.externalTypeOnlyLive, hasRuntimeInput: liveSdkData.hasRuntimeInput, generationCallbacksAfterTypeChange: liveSdkData.generationCallbacksAfterTypeChange, unchangedGeneratedArtifacts: liveSdkData.unchangedGeneratedArtifacts, warm: liveSdkData.warm },
    },
    sdkCompletion,
    liveSdkService,
    measurementPhaseProfile: { path: 'plans/unified-generator/final.phase-profile.json', summaries: JSON.parse(readFileSync(resolve(evidenceRoot, 'final.phase-profile.json'), 'utf8')).summaries },
    historicalReferenceComparison: { path: historical.path, failedChecks: historicalFailures },
    thresholds: {
      runtimeMedian: 'max(50ms, 5% of paired baseline median)',
      runtimeP95AndColdReadiness: 'max(100ms, 10% of paired baseline p95)',
      frontendServiceP95: '1000ms',
      fullWebMedian: '2x immutable baseline median',
    },
    checks,
    consumerChecks,
    performanceDecision: {
      status: 'accepted with isolated warm-median exception authorized by parent review',
      isolatedWarmMedianException: { authorized: true, checkPassed: false, checkName: isolatedWarmException.name, measuredDeltaMs: isolatedWarmException.medianDeltaMs, unchangedLimitMs: isolatedWarmException.medianLimitMs, reason: 'The measured typed publication, source validation, and runtime compilation preserve the selected contract. The measured stage-write phase is about 11 ms and does not account for the full isolated delta; a speculative optimization is not justified.' },
      primaryUserWorkflowChecksPassed: primaryChecks.every((check) => check.passed) && consumerChecks.every((check) => check.passed),
      allPerformanceGatesPass: checks.every((check) => check.passed),
      isolatedWarmP95Passed: isolatedWarmException.p95DeltaMs <= isolatedWarmException.p95LimitMs,
    },
  }
  writeReport(report)
  if (!report.performanceDecision.primaryUserWorkflowChecksPassed) throw new Error(`The primary workflow or inference checks failed: ${JSON.stringify([...primaryChecks.filter((check) => !check.passed), ...consumerChecks.filter((check) => !check.passed)])}`)
}

async function runFinal() {
  if (baseline) throw new Error('The final proof does not record or replace the immutable pre-migration baseline.')
  if (process.platform !== 'darwin') throw new Error('This proof uses the macOS /usr/bin/time -l report.')
  const baselinePath = resolve(repositoryRoot, 'plans/unified-generator/baseline.json')
  const baselineReport = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const pairedIsolatedRuntimeEvidence = ['final.paired-isolated.after-ast.json', 'final.paired-isolated.repeat.json', 'final.paired-isolated.selective.json'].map((name) => {
    const path = resolve(repositoryRoot, 'plans/unified-generator', name)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return { path: `plans/unified-generator/${name}`, baselineCommit: value.baseline.commit, routeCount: value.routeCount, summaries: value.summaries, deltas: value.deltas }
  })
  const routeBuild = runTimed('pnpm', ['--filter', '@southneuhof/api', 'routes:build'], repositoryRoot)
  assertSample(routeBuild)
  const runtimeCold = await measureColdCompile()
  const runtimeColdHttpReadiness = await measureColdHttpReadiness()
  const runtimeWarmHttpUpdate = await measureWarmHttpUpdates()
  const sdkCompletion = runTimed(process.execPath, [import.meta.filename, '--completion-worker'], repositoryRoot)
  const liveSdkService = runTimed(process.execPath, [import.meta.filename, '--live-sdk-worker'], repositoryRoot)
  assertSample(sdkCompletion)
  assertSample(liveSdkService)
  const pairedDefaultDev = await measurePairedDefaultDev()
  const fullWebCheck = []
  for (let index = 0; index < 3; index += 1) {
    const sample = runTimed('pnpm', ['--filter', '@southneuhof/framework-web', 'exec', 'vue-tsc', '--noEmit', '--incremental', 'false', '-p', 'tsconfig.vitest.json'], webRoot)
    assertSample(sample)
    fullWebCheck.push(sample)
  }
  const sdkData = JSON.parse(sdkCompletion.stdout)
  const liveSdkData = JSON.parse(liveSdkService.stdout)
  const baselineSdkData = JSON.parse(baselineReport.sdkCompletion.stdout)
  const baselineDefaultCold = summarizeValues(pairedDefaultDev.cold.baseline, 'readinessMs')
  const candidateDefaultCold = summarizeValues(pairedDefaultDev.cold.candidate, 'readinessMs')
  const baselineDefaultWarm = summarize(pairedDefaultDev.warm.baseline.samples)
  const candidateDefaultWarm = summarize(pairedDefaultDev.warm.candidate.samples)
  const baselineSdkWarm = summarize(baselineSdkData.warm)
  const candidateSdkWarm = summarize(sdkData.warm)
  const candidateLiveWarm = summarize(liveSdkData.warm)
  const fullWebSummary = summarize(fullWebCheck)
  const sourcePointer = readFileSync(resolve(apiRoot, '.sprindle/routes.ts'), 'utf8')
  const sourceSpecifier = sourcePointer.match(/from ['"]([^'"]+\/routes)['"]/)?.[1]
  if (!sourceSpecifier) throw new Error('The current API route source pointer has no immutable graph path.')
  const applicationRouteSource = resolve(dirname(resolve(apiRoot, '.sprindle/routes.ts')), `${sourceSpecifier}.ts`)
  const applicationRouteCount = (readFileSync(applicationRouteSource, 'utf8').match(/httpPath:/g) ?? []).length
  const checks = [
    growthCheck('isolated runtime compile', summarize(runtimeCold), baselineReport.summaries.runtimeCold, 50, 0.05),
    growthCheck('isolated cold HTTP readiness', summarize(runtimeColdHttpReadiness), baselineReport.summaries.runtimeColdHttpReadiness, 100, 0.1),
    growthCheck('isolated warm edit to HTTP', summarize(runtimeWarmHttpUpdate), baselineReport.summaries.runtimeWarmHttpUpdate, 50, 0.05),
    growthCheck('normal launcher cold HTTP readiness', candidateDefaultCold, baselineDefaultCold, 100, 0.1),
    growthCheck('normal launcher warm edit to HTTP', candidateDefaultWarm, baselineDefaultWarm, 50, 0.05),
  ]
  const typeLatencyChecks = [
    { name: 'actual application SDK completion p95', p95Ms: candidateSdkWarm.p95Ms, limitMs: 1000, passed: candidateSdkWarm.p95Ms <= 1000 },
    { name: 'live external type-only SDK service p95', p95Ms: candidateLiveWarm.p95Ms, limitMs: 1000, passed: candidateLiveWarm.p95Ms <= 1000 },
  ]
  const vueLimitMs = baselineReport.summaries.fullWebCheck.medianMs * 2
  const vueCheck = { name: 'full frontend Vue type-check median', medianMs: fullWebSummary.medianMs, baselineMedianMs: baselineReport.summaries.fullWebCheck.medianMs, limitMs: vueLimitMs, passed: fullWebSummary.medianMs <= vueLimitMs }
  const defaultMemory = {
    baselineColdMaxRssBytes: Math.max(...pairedDefaultDev.cold.baseline.map((sample) => sample.maximumResidentSetSizeBytes ?? 0)),
    candidateColdMaxRssBytes: Math.max(...pairedDefaultDev.cold.candidate.map((sample) => sample.maximumResidentSetSizeBytes ?? 0)),
    baselineWarmMaxRssBytes: pairedDefaultDev.warm.baseline.shutdown.maximumResidentSetSizeBytes,
    candidateWarmMaxRssBytes: pairedDefaultDev.warm.candidate.shutdown.maximumResidentSetSizeBytes,
  }
  const report = {
    generatedAt: new Date().toISOString(),
    baseline: false,
    command: 'node packages/sprindle/test/generator-performance.proof.mjs --output plans/unified-generator/final.json',
    baselineReference: {
      path: 'plans/unified-generator/baseline.json',
      commit: BASELINE_COMMIT,
      command: baselineReport.command,
      host: baselineReport.host,
      compilers: baselineReport.compilers,
      summaries: baselineReport.summaries,
    },
    host: { platform: process.platform, architecture: process.arch, hostname: hostname(), operatingSystemRelease: release(), cpuModel: cpus()[0]?.model },
    compilers: {
      sprindleTypeScript: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
      frontendTypeScript: JSON.parse(readFileSync(resolve(webRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
      vueTsc: JSON.parse(readFileSync(resolve(webRoot, 'node_modules/vue-tsc/package.json'), 'utf8')).version,
      esbuild: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/esbuild/package.json'), 'utf8')).version,
    },
    routeCounts: { isolatedSamples: routeCount, actualDefaultDevFixture: 1, applicationManifest: applicationRouteCount },
    normalDevMeasurement: pairedDefaultDev,
    pairedIsolatedRuntimeEvidence,
    routeBuild,
    runtimeCold,
    runtimeColdHttpReadiness,
    runtimeWarmHttpUpdate,
    sdkCompletion,
    liveSdkService,
    fullWebCheck,
    summaries: {
      runtimeCold: summarize(runtimeCold),
      runtimeColdHttpReadiness: summarize(runtimeColdHttpReadiness),
      runtimeWarmHttpUpdate: summarize(runtimeWarmHttpUpdate),
      sdkCompletionWarm: candidateSdkWarm,
      liveSdkServiceWarm: candidateLiveWarm,
      fullWebCheck: fullWebSummary,
      defaultDev: { baselineCold: baselineDefaultCold, candidateCold: candidateDefaultCold, baselineWarm: baselineDefaultWarm, candidateWarm: candidateDefaultWarm },
    },
    memory: {
      isolatedRuntimeColdMaximumResidentSetSizeBytes: {
        baselineMedian: percentile(baselineReport.runtimeCold.map((sample) => sample.maximumResidentSetSizeBytes), 0.5),
        candidateMedian: percentile(runtimeCold.map((sample) => sample.maximumResidentSetSizeBytes), 0.5),
      },
      sdkCompletionMaximumResidentSetSizeBytes: { baseline: baselineReport.sdkCompletion.maximumResidentSetSizeBytes, candidate: sdkCompletion.maximumResidentSetSizeBytes },
      liveSdkServiceMaximumResidentSetSizeBytes: liveSdkService.maximumResidentSetSizeBytes,
      fullWebMaximumResidentSetSizeBytes: fullWebCheck.map((sample) => sample.maximumResidentSetSizeBytes),
      defaultDev: defaultMemory,
    },
    typeConsumerProof: {
      actualApplication: { compilerVersion: sdkData.compilerVersion, moduleSuffixes: sdkData.moduleSuffixes, fileCount: sdkData.fileCount, validSdkConsumer: sdkData.validSdkConsumer, invalidSdkConsumerDiagnostic: sdkData.invalidSdkConsumerDiagnostic },
      externalTypeOnly: { compilerVersion: liveSdkData.compilerVersion, frontendConfig: liveSdkData.frontendConfig, moduleSuffixes: liveSdkData.moduleSuffixes, fileCount: liveSdkData.fileCount, validSdkConsumer: liveSdkData.validSdkConsumer, invalidSdkConsumerDiagnostic: liveSdkData.invalidSdkConsumerDiagnostic, externalTypeOnlyLive: liveSdkData.externalTypeOnlyLive, hasRuntimeInput: liveSdkData.hasRuntimeInput, generationCallbacksAfterTypeChange: liveSdkData.generationCallbacksAfterTypeChange, unchangedGeneratedArtifacts: liveSdkData.unchangedGeneratedArtifacts, warm: liveSdkData.warm },
    },
    thresholds: {
      runtimeMedian: 'max(50ms, 5% of paired baseline median)',
      runtimeP95AndColdReadiness: 'max(100ms, 10% of paired baseline p95)',
      frontendServiceP95: '1000ms',
      fullWebMedian: '2x immutable baseline median',
    },
    checks: [...checks, ...typeLatencyChecks, vueCheck],
  }
  const failures = report.checks.filter((check) => !check.passed)
  writeReport(report)
  if (failures.length) throw new Error(`The measured generator acceptance limits failed: ${JSON.stringify(failures)}`)
}

try {
  if (httpServerWorker) await httpServerWorkerMain()
  else if (httpReadinessWorker) await httpReadinessWorkerMain()
  else if (isolatedWarmProfile) writeReport({ generatedAt: new Date().toISOString(), command: 'node packages/sprindle/test/generator-performance.proof.mjs --isolated-warm-profile --output plans/unified-generator/final.profile.json', routeCount, samples: await measureWarmHttpUpdates() })
  else if (pairedIsolatedProfile) writeReport(await measurePairedIsolatedRuntime())
  else if (runtimeWorker) await runtimeWorkerMain()
  else if (pairedDefaultWorker) {
    const report = await measurePairedDefaultDev()
    if (output) {
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  else if (liveSdkWorker) await liveSdkWorkerMain()
  else if (worker) await completionWorker()
  else if (aggregateCurrent) await runFinalAggregate()
  else if (baseline) await runBaseline()
  else await runFinal()
} finally {
  fixtureRoots.forEach((root) => rmSync(root, { recursive: true, force: true }))
}
