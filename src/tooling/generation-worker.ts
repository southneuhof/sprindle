import { isGenerationRequest, type GenerationDependencies } from './generation-protocol.ts'
import { runRouteManifestGeneration } from './manifest.ts'

let received = false
const cancellation = new AbortController()

process.on('disconnect', () => {
  cancellation.abort(new Error('The route watcher disconnected.'))
  if (!received) process.exitCode = 1
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => cancellation.abort(new Error(`Generation worker received ${signal}.`)))

process.once('message', (message: unknown) => {
  received = true
  if (!isGenerationRequest(message)) {
    process.exitCode = 1
    process.disconnect?.()
    return
  }
  const sendDependencies = (dependencyInputs: string[]) => {
    if (!process.connected) return
    const message: GenerationDependencies = { type: 'dependencies', dependencyInputs }
    process.send?.(message, () => {})
  }
  void runRouteManifestGeneration(message, sendDependencies, cancellation.signal).then((result) => {
    if (!process.connected) return
    process.send?.(result, () => process.disconnect?.())
  })
})
