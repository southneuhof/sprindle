import { spawnSync, type ChildProcess } from 'node:child_process'

function processGroupIsAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function waitForClose(child: ChildProcess, timeoutMs: number) {
  if ((child.exitCode !== null || child.signalCode !== null) && child.stdio.every((stream) => !stream || stream.destroyed)) return Promise.resolve(true)
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

async function waitForGroupToStop(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pid)) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  return !processGroupIsAlive(pid)
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export async function stopOwnedProcessTree(child: ChildProcess, graceMs = 500, forceMs = 2000, processGroup = true) {
  const pid = child.pid
  if (!pid) {
    if (!await waitForClose(child, graceMs + forceMs)) throw new Error('The owned process did not close after startup failed.')
    return
  }
  if (!processGroup) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (await waitForClose(child, graceMs)) return
    child.kill('SIGKILL')
    if (!await waitForClose(child, forceMs)) throw new Error(`The owned process ${pid} did not stop after SIGKILL.`)
    return
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: forceMs })
    if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Cannot stop the owned process tree with taskkill.exe.', { cause: result.error })
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`The owned process tree for ${pid} did not stop with taskkill.exe.`)
    if (!await waitForClose(child, forceMs)) throw new Error(`The owned process tree for ${pid} did not stop after taskkill.exe.`)
    return
  }
  signalGroup(pid, 'SIGTERM')
  const graceful = await Promise.all([waitForClose(child, graceMs), waitForGroupToStop(pid, graceMs)])
  if (graceful.every(Boolean)) return
  signalGroup(pid, 'SIGKILL')
  const forced = await Promise.all([waitForClose(child, forceMs), waitForGroupToStop(pid, forceMs)])
  if (!forced.every(Boolean)) throw new Error(`The owned process group for ${pid} did not stop after SIGKILL.`)
}
