import { fork, type ChildProcess } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { GenerationRequest } from './manifest.ts'

type WorkerMessage =
  | { type: 'dependencies'; dependencyInputs: string[] }
  | { type: 'result'; ok: true; target: string; dependencyInputs: string[] }
  | { type: 'result'; ok: false; error: { message: string; stack?: string }; dependencyInputs: string[] }

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRequest(value: unknown): value is GenerationRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<GenerationRequest>
  return typeof request.projectRoot === 'string'
    && typeof request.routesDirectory === 'string'
    && typeof request.output === 'string'
    && typeof request.bundle === 'boolean'
    && isStringArray(request.dependencyInputs)
}

function isResult(value: unknown): value is Extract<WorkerMessage, { type: 'result' }> {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<Extract<WorkerMessage, { type: 'result' }>>
  return result.type === 'result' && isStringArray(result.dependencyInputs)
    && (result.ok === true && typeof result.target === 'string'
      || result.ok === false && typeof result.error?.message === 'string')
}

let worker: ChildProcess | undefined
let dependencyInputs: string[] = []
let result: Extract<WorkerMessage, { type: 'result' }> | undefined
let failure: Error | undefined
let completed = false
let stopping = false

function stopOwnedTree() {
  if (completed || stopping) return
  stopping = true
  if (process.platform === 'win32') {
    const stopped = spawnSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 })
    if (stopped.status !== 0 && worker?.pid) {
      const workerTree = spawnSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 })
      if (workerTree.status !== 0) {
        try { process.kill(worker.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') process.exitCode = 1 }
      }
    }
    if (stopped.status !== 0) process.exitCode = 1
    return
  }
  try { process.kill(-process.pid, 'SIGKILL') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') process.exitCode = 1
  }
}

function sendResult(value: Extract<WorkerMessage, { type: 'result' }>) {
  completed = true
  if (!process.connected) return
  process.send?.(value, () => process.disconnect?.())
}

process.once('disconnect', stopOwnedTree)
process.once('message', (message: unknown) => {
  if (!isRequest(message)) {
    sendResult({ type: 'result', ok: false, error: { message: 'The route watcher sent an invalid generation request.' }, dependencyInputs })
    return
  }
  dependencyInputs = [...message.dependencyInputs]
  const source = import.meta.url.endsWith('.ts')
  const workerPath = fileURLToPath(new URL(source ? './generation-worker.ts' : './generation-worker.js', import.meta.url))
  worker = fork(workerPath, [], {
    cwd: message.projectRoot,
    detached: false,
    execArgv: source ? ['--experimental-strip-types'] : [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  worker.on('message', (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const item = value as Partial<WorkerMessage>
    if (item.type === 'dependencies' && isStringArray(item.dependencyInputs)) {
      dependencyInputs = item.dependencyInputs
      if (process.connected) process.send?.({ type: 'dependencies', dependencyInputs }, () => {})
      return
    }
    if (isResult(value)) {
      dependencyInputs = value.dependencyInputs
      result = value
    }
  })
  worker.once('error', (error) => { failure = error })
  worker.once('close', (code, signal) => {
    if (result) {
      sendResult(result)
      return
    }
    const message = failure?.message ?? `The generation worker exited without a result (${signal ?? code ?? 'unknown'}).`
    sendResult({ type: 'result', ok: false, error: { message, ...(failure?.stack ? { stack: failure.stack } : {}) }, dependencyInputs })
  })
  worker.send(message, (error) => { if (error) failure = error })
})
