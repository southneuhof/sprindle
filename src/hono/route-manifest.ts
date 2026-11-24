import type { Context } from 'hono'

export type FileRouteManifestEntry = {
  sourcePath: string
  httpPath: string
  parameters: string[]
  methods: string[]
  scopes: unknown[]
  handlers: Record<string, unknown>
}

export type FileRouteManifest = readonly FileRouteManifestEntry[]
const manifestKey = 'sprindle:manifest'

export function getRouteManifest(c: Context) {
  const manifest = c.get(manifestKey) as FileRouteManifest | undefined
  if (!manifest) throw new Error('Sprindle routes are not installed.')
  return manifest
}

export function setRouteManifest(c: Context, manifest: FileRouteManifest) {
  c.set(manifestKey, manifest)
}
