import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isGenerationDependencies, isGenerationRequest, isGenerationResponse, type GenerationResponse } from './generation-protocol.ts'

let worker: ChildProcess | undefined
let dependencyInputs: string[] = []
let result: GenerationResponse | undefined
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

function sendResult(value: GenerationResponse) {
  completed = true
  if (!process.connected) return
  process.send?.(value, () => process.disconnect?.())
}

process.once('disconnect', stopOwnedTree)
process.once('message', (message: unknown) => {
  if (!isGenerationRequest(message)) {
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
    if (isGenerationDependencies(value)) {
      dependencyInputs = value.dependencyInputs
      if (process.connected) process.send?.(value, () => {})
      return
    }
    if (isGenerationResponse(value)) {
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
