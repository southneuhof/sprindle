import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { parse } from '@babel/parser'

export const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'] as const
export type HttpExport = (typeof HTTP_METHODS)[number]

export type RouteFile = {
  sourcePath: string
  httpPath: string
  parameters: string[]
  methods: HttpExport[]
  scopes: string[]
}

export type RouteDirectory = { root: string; routes: RouteFile[]; scopes: string[] }

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))).flat().sort()
}

export function exportedNames(source: string) {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  const names: string[] = []
  for (const statement of program.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') { names.push('default'); continue }
    if (statement.type !== 'ExportNamedDeclaration') continue
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration') for (const declaration of statement.declaration.declarations) {
      if (declaration.id.type === 'Identifier') names.push(declaration.id.name)
    }
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration && 'id' in statement.declaration && statement.declaration.id?.type === 'Identifier') names.push(statement.declaration.id.name)
    if (statement.type === 'ExportNamedDeclaration') for (const specifier of statement.specifiers) if (specifier.exported.type === 'Identifier') names.push(specifier.exported.name)
  }
  return names
}

export function routeFileLocation(root: string, file: string) {
  const segments = relative(root, dirname(file)).split(sep).filter(Boolean)
  const parameters: string[] = []
  const url: string[] = []
  for (const segment of segments) {
    const parameter = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(segment)?.[1]
    if (parameter) {
      if (parameters.includes(parameter)) throw new Error(`${file}: duplicate parameter ${parameter}`)
      parameters.push(parameter); url.push(`:${parameter}`); continue
    }
    if (/^\([A-Za-z0-9_-]+\)$/.test(segment)) continue
    if (!/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..') throw new Error(`${file}: unsupported segment ${segment}`)
    url.push(segment)
  }
  return { segments, parameters, httpPath: `/${url.join('/')}` }
}

export async function readRouteDirectory(root: string): Promise<RouteDirectory> {
  const files = await walk(root)
  const scopes = files.filter((file) => file.endsWith(`${sep}+scope.ts`))
  for (const scope of scopes) {
    const exports = exportedNames(await readFile(scope, 'utf8'))
    if (exports.length !== 1 || exports[0] !== 'default') throw new Error(`${scope}: scope must export only a default definition`)
  }
  const routes: RouteFile[] = []
  const seen = new Map<string, string>()
  const pathParameters = new Map<string, { parameters: string[]; sourcePath: string }>()
  for (const sourcePath of files.filter((file) => file.endsWith(`${sep}+server.ts`))) {
    const { segments, parameters, httpPath } = routeFileLocation(root, sourcePath)
    const exports = exportedNames(await readFile(sourcePath, 'utf8'))
    const invalid = exports.filter((name) => !HTTP_METHODS.includes(name as HttpExport))
    if (invalid.length) throw new Error(`${sourcePath}: invalid reserved export ${invalid[0]}`)
    const methods = exports.filter((name): name is HttpExport => HTTP_METHODS.includes(name as HttpExport))
    const ancestors = [root, ...segments.map((_, index) => join(root, ...segments.slice(0, index + 1)))]
      .map((directory) => join(directory, '+scope.ts')).filter((file) => scopes.includes(file))
    for (const method of methods) {
      const normalized = `${method} ${httpPath.replace(/:[^/]+/g, ':parameter')}`
      const other = seen.get(normalized)
      if (other) throw new Error(`${sourcePath}: duplicate ${normalized}; also ${other}`)
      seen.set(normalized, sourcePath)
    }
    const pathKey = httpPath.replace(/:[^/]+/g, ':parameter')
    const previousPath = pathParameters.get(pathKey)
    if (previousPath && previousPath.parameters.join('/') !== parameters.join('/')) throw new Error(`${sourcePath}: parameter names for ${pathKey} conflict with ${previousPath.sourcePath}`)
    pathParameters.set(pathKey, previousPath ?? { parameters, sourcePath })
    routes.push({ sourcePath, httpPath, parameters, methods, scopes: ancestors })
  }
  routes.sort((a, b) => {
    const left = a.httpPath.split('/'), right = b.httpPath.split('/')
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const order = Number(left[index].startsWith(':')) - Number(right[index].startsWith(':'))
      if (order) return order
    }
    return a.httpPath.localeCompare(b.httpPath) || a.sourcePath.localeCompare(b.sourcePath)
  })
  return { root, routes, scopes }
}
