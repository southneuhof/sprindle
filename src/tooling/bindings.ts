import { basename, dirname, join, relative, sep } from 'node:path'
import { routeFileLocation } from './route-files.ts'

export type RouteBindingMetadata = { kind: 'scope' | 'route'; helper: '.s' | '.r'; parameters: string[]; parentFile?: string }

export function routeBindingMetadata(root: string, file: string, files: Set<string>): RouteBindingMetadata {
  const { segments, parameters } = routeFileLocation(root, file)
  const kind = basename(file) === '+scope.ts' ? 'scope' : 'route'
  const ancestors = [root, ...segments.map((_, index) => join(root, ...segments.slice(0, index + 1)))]
  const parentFile = ancestors.reverse().map((directory) => join(directory, '+scope.ts')).find((candidate) => candidate !== file && files.has(candidate))
  return { kind, helper: kind === 'scope' ? '.s' : '.r', parameters, parentFile }
}

export function helperSourceSpecifier(file: string, target: string) {
  const path = relative(dirname(file), target).replaceAll(sep, '/').replace(/\.d\.ts$|\.(?:[cm]?tsx?)$/, '')
  return path.startsWith('../') || path.startsWith('./') ? path : `./${path}`
}
