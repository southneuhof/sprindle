import { runRouteManifestGeneration, type GenerationRequest } from './manifest.ts'

function isRequest(value: unknown): value is GenerationRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<GenerationRequest>
  return typeof request.projectRoot === 'string'
    && typeof request.routesDirectory === 'string'
    && typeof request.output === 'string'
    && typeof request.bundle === 'boolean'
    && Array.isArray(request.dependencyInputs)
    && request.dependencyInputs.every((input) => typeof input === 'string')
}

let received = false
const cancellation = new AbortController()

process.on('disconnect', () => {
  cancellation.abort(new Error('The route watcher disconnected.'))
  if (!received) process.exitCode = 1
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => cancellation.abort(new Error(`Generation worker received ${signal}.`)))

process.once('message', (message: unknown) => {
  received = true
  if (!isRequest(message)) {
    process.exitCode = 1
    process.disconnect?.()
    return
  }
  const sendDependencies = (dependencyInputs: string[]) => {
    if (!process.connected) return
    process.send?.({ type: 'dependencies', dependencyInputs }, () => {})
  }
  void runRouteManifestGeneration(message, sendDependencies, cancellation.signal).then((result) => {
    if (!process.connected) return
    process.send?.(result, () => process.disconnect?.())
  })
})
