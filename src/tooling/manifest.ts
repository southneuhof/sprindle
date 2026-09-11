import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { parse } from 'jsonc-parser'
import { parse as parseTypeScript } from '@babel/parser'
import { readRouteDirectory } from './route-files.ts'
import { routeLanguageOverlay } from './language.ts'

const dependencyInputs = new Map<string, string[]>()

function rejectStaticCycles(projectRoot: string, inputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>) {
  const graph = new Map(Object.entries(inputs).map(([file, input]) => [file, input.imports.filter((entry) => entry.kind === 'import-statement' && !entry.external && inputs[entry.path]).map((entry) => entry.path).sort()]))
  const visited = new Set<string>(), active = new Map<string, number>(), path: string[] = []
  const shown = (file: string) => relative(realpathSync(projectRoot), isAbsolute(file) ? file : existsSync(resolve(file)) ? resolve(file) : resolve(projectRoot, file)).replaceAll(sep, '/')
  const visit = (file: string): string[] | undefined => {
    const start = active.get(file)
    if (start !== undefined) return [...path.slice(start), file]
    if (visited.has(file)) return
    visited.add(file); active.set(file, path.length); path.push(file)
    for (const dependency of graph.get(file) ?? []) { const cycle = visit(dependency); if (cycle) return cycle }
    path.pop(); active.delete(file)
  }
  for (const file of [...graph.keys()].sort()) {
    const cycle = visit(file)
    if (cycle) throw new Error(`Static local import cycle: ${cycle.map(shown).join(' -> ')}. Move shared declarations into a module that does not import the service.`)
  }
}

async function configInputs(configFile: string, seen = new Set<string>()): Promise<string[]> {
  const file = resolve(configFile)
  if (seen.has(file)) return []
  seen.add(file)
  const source = await readFile(file, 'utf8')
  const value = parse(source) as { extends?: string | string[] } | undefined
  const extended = typeof value?.extends === 'string' ? [value.extends] : value?.extends ?? []
  const parents = extended.filter((entry) => entry.startsWith('.') || isAbsolute(entry)).map((entry) => {
    const target = resolve(dirname(file), entry)
    return extname(target) ? target : `${target}.json`
  })
  return [file, ...(await Promise.all(parents.map((parent) => configInputs(parent, seen)))).flat()]
}

export async function compileRouteManifest(projectRoot: string, routesDirectory = 'routes', output = '.sprindle/routes.mjs', bundle = true, options: { declarations?: boolean } = {}) {
  const root = resolve(projectRoot, routesDirectory)
  const emitDeclarations = options.declarations ?? true
  const model = await readRouteDirectory(root)
  const portable = model.routes.map((route) => ({ ...route, sourcePath: relative(projectRoot, route.sourcePath), scopes: route.scopes.map((scope) => relative(projectRoot, scope)) }))
  const imports: string[] = [], scopeNames = new Map<string, string>()
  for (const scope of model.scopes) { const name = `scope${scopeNames.size}`; scopeNames.set(scope, name); imports.push(`import ${name} from ${JSON.stringify(scope)}`) }
  const entries = model.routes.map((route, index) => { const name = `route${index}`; imports.push(`import * as ${name} from ${JSON.stringify(route.sourcePath)}`); return `{sourcePath:${JSON.stringify(relative(projectRoot, route.sourcePath))},httpPath:${JSON.stringify(route.httpPath)},parameters:${JSON.stringify(route.parameters)},methods:${JSON.stringify(route.methods)},scopes:[${route.scopes.map((scope) => scopeNames.get(scope)).join(',')}],handlers:${name}}` })
  const target = resolve(projectRoot, output); await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const source = (hash: string) => `${imports.join('\n')}\nexport const hash=${JSON.stringify(hash)};export default [${entries.join(',')}];`
  const analysis = await build({ stdin: { contents: source('pending'), resolveDir: projectRoot, sourcefile: 'sprindle-routes.ts', loader: 'ts' }, write: false, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', metafile: true })
  const bundled = Object.keys(analysis.metafile.inputs).filter((file) => !file.endsWith('sprindle-routes.ts') && file !== '<stdin>').map((file) => isAbsolute(file) ? file : existsSync(resolve(file)) ? resolve(file) : resolve(projectRoot, file))
  const inputs = [...new Set([...bundled, ...(await configInputs(resolve(projectRoot, 'tsconfig.json')))])].sort()
  dependencyInputs.set(resolve(projectRoot), inputs)
  rejectStaticCycles(projectRoot, analysis.metafile.inputs)
  const contents = await Promise.all(inputs.map((file) => readFile(file, 'utf8')))
  const hash = createHash('sha256').update(JSON.stringify([portable, inputs, contents])).digest('hex')
  try {
    if (bundle) await build({ stdin: { contents: source(hash), resolveDir: projectRoot, sourcefile: 'sprindle-routes.ts', loader: 'ts' }, outfile: temporary, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', sourcemap: 'inline' })
    else await writeFile(temporary, source(hash))
    const publishDeclaration = emitDeclarations ? await emitRouteDeclarations(projectRoot, routesDirectory, model.routes, target.replace(/\.mjs$/, '.d.ts')) : undefined
    await rename(temporary, target)
    if (publishDeclaration) await publishDeclaration()
    else await rm(target.replace(/\.mjs$/, '.d.ts'), { force: true })
  } finally {
    await rm(temporary, { force: true })
  }
  return target
}

async function emitRouteDeclarations(projectRoot: string, routesDirectory: string, routes: Awaited<ReturnType<typeof readRouteDirectory>>['routes'], declaration: string) {
  const frameworkRoot = [resolve(import.meta.dirname, '../..'), resolve(import.meta.dirname, '..')].find((directory) => existsSync(resolve(directory, 'package.json')))
  if (!frameworkRoot) throw new Error('Sprindle package root is missing.')
  const definitionSource = resolve(frameworkRoot, 'src/routes/definition.ts')
  const virtualDefinition = resolve(projectRoot, '.__sprindle_route_definition.ts')
  const overlay = routeLanguageOverlay(projectRoot, routesDirectory, new Map(), virtualDefinition)
  overlay.set(virtualDefinition, readFileSync(definitionSource, 'utf8'))
  for (const [file, source] of overlay) if (/\.[rs]\.d\.ts$/.test(file)) overlay.set(file, source.replace(/^export \* from .*$/m, `export * from '@southneuhof/sprindle'`))
  const commonSourceRoot = commonPath(projectRoot, [...overlay.keys()])
  const mappedPath = (file: string) => containedRelativePath(commonSourceRoot, file)
  const input = mkdtempSync(resolve(tmpdir(), `sprindle-contract-input-${process.pid}-`))
  const stagedProject = resolve(input, mappedPath(projectRoot))
  const temporary = resolve(projectRoot, `.sprindle-contract-${process.pid}-${randomUUID()}`)
  let declarationTemporary: string | undefined
  try {
    for (const [file, source] of overlay) {
      const output = resolve(input, mappedPath(file))
      if (output === resolve(stagedProject, 'tsconfig.json')) continue
      mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, source)
    }
    mkdirSync(resolve(input, 'node_modules'), { recursive: true })
    const frameworkModules = resolve(frameworkRoot, 'node_modules')
    const projectModules = resolve(projectRoot, 'node_modules')
    if (existsSync(projectModules)) for (const entry of readdirSync(projectModules, { withFileTypes: true })) symlinkSync(resolve(projectModules, entry.name), resolve(input, 'node_modules', entry.name), entry.isDirectory() ? 'dir' : 'file')
    for (const name of ['@types', 'hono', 'zod']) {
      const target = resolve(input, 'node_modules', name)
      if (!existsSync(target)) symlinkSync(resolve(frameworkModules, name), target, 'dir')
    }
    const compiler = resolveTypeScriptCompiler(frameworkRoot)
    const projectConfig = resolve(projectRoot, 'tsconfig.json')
    const shown = spawnSync(process.execPath, [compiler, '--showConfig', '-p', projectConfig], { cwd: projectRoot, encoding: 'utf8' })
    if (shown.error || shown.status !== 0) throw new Error(`TypeScript config failed: ${shown.error?.message ?? shown.stdout + shown.stderr}`)
    const effective = JSON.parse(shown.stdout) as { compilerOptions?: Record<string, unknown> }
    const options = { ...effective.compilerOptions }
    const originalBase = resolve(projectRoot, typeof options.baseUrl === 'string' ? options.baseUrl : '.')
    const paths = options.paths as Record<string, string[]> | undefined
    if (paths) options.paths = Object.fromEntries(Object.entries(paths).map(([name, targets]) => [name, targets.map((target) => {
      const path = relative(stagedProject, resolve(input, mappedPath(resolve(originalBase, target)))).replaceAll(sep, '/')
      return path.startsWith('.') ? path : `./${path}`
    })]))
    delete options.baseUrl
    Object.assign(options, { rootDir: input, outDir: temporary, declaration: true, emitDeclarationOnly: true, declarationMap: false, noEmit: false, composite: false, incremental: false, allowImportingTsExtensions: false, skipLibCheck: true })
    delete options.tsBuildInfoFile
    const contextualSources = [...overlay.keys()].filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && file !== resolve(projectRoot, 'tsconfig.json'))
    const rootFiles = [...new Set([...routes.flatMap((route) => [route.sourcePath, ...route.scopes]), ...contextualSources, virtualDefinition])].map((file) => resolve(input, mappedPath(file)))
    mkdirSync(stagedProject, { recursive: true })
    const stagedConfig = resolve(stagedProject, 'tsconfig.json')
    writeFileSync(stagedConfig, JSON.stringify({ compilerOptions: options, files: rootFiles }))
    const emitted = spawnSync(process.execPath, [compiler, '-p', stagedConfig, '--pretty', 'false'], { cwd: projectRoot, encoding: 'utf8' })
    if (emitted.error || emitted.status !== 0) throw new Error(`TypeScript declaration emit failed: ${emitted.error?.message ?? emitted.stdout + emitted.stderr}`)
    for (const [file, source] of overlay) if (file.endsWith('.d.ts')) {
      const output = resolve(temporary, mappedPath(file)); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, source)
    }
    for (const file of declarationFiles(temporary)) {
      const definitionPath = relative(dirname(file), resolve(temporary, mappedPath(virtualDefinition)).replace(/\.ts$/, '')).replaceAll('\\', '/')
      const specifier = definitionPath.startsWith('.') ? definitionPath : `./${definitionPath}`
      let source = readFileSync(file, 'utf8').replace(/(["'])[^"']*sprindle-contract-input-[^"']*\/\.__sprindle_route_definition\.js\1/g, JSON.stringify(specifier))
      source = rewritePathAliases(source, file, temporary, paths, originalBase, commonSourceRoot)
      writeFileSync(file, source)
    }
    const emittedFiles = declarationFiles(temporary).sort()
    const emittedContents = emittedFiles.map((file) => [relative(temporary, file).replaceAll(sep, '/'), readFileSync(file, 'utf8')])
    const version = createHash('sha256').update(JSON.stringify(emittedContents)).digest('hex').slice(0, 24)
    const contract = routes.flatMap((route) => route.methods.map((method) => {
      const modulePath = `./contracts/${version}/` + mappedPath(route.sourcePath).replaceAll('\\', '/').replace(/\.ts$/, '')
      return `{ path: ${JSON.stringify(route.httpPath)}; method: ${JSON.stringify(method.toLowerCase())}; definition: typeof import(${JSON.stringify(modulePath)})[${JSON.stringify(method)}] }`
    })).join(' | ') || 'never'
    const contractDirectory = resolve(dirname(declaration), 'contracts', version)
    await mkdir(dirname(contractDirectory), { recursive: true })
    try { await rename(temporary, contractDirectory) } catch (error) {
      if (!existsSync(contractDirectory)) throw error
      await rm(temporary, { recursive: true, force: true })
    }
    declarationTemporary = `${declaration}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(declarationTemporary, `export type RouteContract = ${contract}\n`)
    const prepared = declarationTemporary
    declarationTemporary = undefined
    return async () => { try { await rename(prepared, declaration) } finally { await rm(prepared, { force: true }) } }
  } finally {
    await rm(input, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
    if (declarationTemporary) await rm(declarationTemporary, { force: true })
  }
}

function containedRelativePath(root: string, file: string) {
  const path = relative(root, resolve(file))
  if (isAbsolute(path) || path.split(sep).includes('..')) throw new Error(`Declaration input is outside ${root}: ${file}`)
  return path
}

function commonPath(projectRoot: string, files: string[]) {
  let root = resolve(projectRoot)
  for (const file of files) while (containedRelativePathOrUndefined(root, file) === undefined) {
    const parent = dirname(root)
    if (parent === root) throw new Error(`Declaration inputs do not have a common path: ${projectRoot}, ${file}`)
    root = parent
  }
  return root
}

function containedRelativePathOrUndefined(root: string, file: string) {
  const path = relative(root, resolve(file))
  return isAbsolute(path) || path.split(sep).includes('..') ? undefined : path
}

function resolveTypeScriptCompiler(frameworkRoot: string) {
  try {
    const packageFile = createRequire(resolve(frameworkRoot, 'package.json')).resolve('typescript/package.json')
    const compiler = resolve(dirname(packageFile), 'bin/tsc')
    if (!existsSync(compiler)) throw new Error(`missing ${compiler}`)
    return compiler
  } catch (error) { throw new Error(`TypeScript compiler dependency is missing: ${error instanceof Error ? error.message : String(error)}`) }
}

function rewritePathAliases(source: string, file: string, outputRoot: string, paths: Record<string, string[]> | undefined, originalBase: string, commonSourceRoot: string) {
  if (!paths) return source
  const edits: { start: number; end: number; value: string }[] = []
  const program = parseTypeScript(source, { sourceType: 'module', plugins: ['typescript'] }).program
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const value = node as Record<string, unknown>
    const type = value.type
    let literal: Record<string, unknown> | undefined
    if (type === 'ImportDeclaration' || type === 'ExportNamedDeclaration' || type === 'ExportAllDeclaration') literal = value.source as Record<string, unknown> | undefined
    else if (type === 'TSImportType') literal = value.argument as Record<string, unknown> | undefined
    else if (type === 'ImportExpression') literal = value.source as Record<string, unknown> | undefined
    if (literal?.type === 'StringLiteral' && typeof literal.value === 'string' && typeof literal.start === 'number' && typeof literal.end === 'number') edits.push({ start: literal.start, end: literal.end, value: literal.value })
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child)
  }
  visit(program)
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    const name = edit.value
    let replacement: string | undefined
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf('*')
      const match = star < 0 ? name === pattern ? '' : undefined : name.startsWith(pattern.slice(0, star)) && name.endsWith(pattern.slice(star + 1)) ? name.slice(star, name.length - (pattern.length - star - 1)) : undefined
      if (match === undefined || !targets[0]) continue
      const target = targets[0].replace('*', match)
      const mappedTarget = containedRelativePath(commonSourceRoot, resolve(originalBase, target))
      let specifier = relative(dirname(file), resolve(outputRoot, mappedTarget)).replaceAll(sep, '/').replace(/\.(?:d\.ts|[cm]?ts)$/, '')
      if (!specifier.startsWith('.')) specifier = `./${specifier}`
      replacement = specifier
      break
    }
    if (replacement) source = source.slice(0, edit.start) + JSON.stringify(replacement) + source.slice(edit.end)
  }
  return source
}

function declarationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? declarationFiles(resolve(directory, entry.name)) : entry.name.endsWith('.d.ts') ? [resolve(directory, entry.name)] : [])
}

export async function watchRouteManifest(projectRoot: string, routesDirectory = 'routes', onResult?: (error?: Error) => void, output = '.sprindle/routes.mjs', bundle = true, options: { declarations?: boolean } = {}) {
  let queue = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined, closed = false
  const project = resolve(projectRoot), watched = new Map<string, ReturnType<typeof watch>>()
  const recursiveWatcher = watch(project, { recursive: true }, (_event, filename) => {
    const path = filename?.toString().replaceAll('\\', '/') ?? ''
    if (path.split('/').some((part) => part.startsWith('.sprindle')) || path.split('/').some((part) => ['.git', 'dist', 'dist-tooling', 'node_modules'].includes(part))) return
    if (!closed) schedule()
  })
  const directories = (directory: string): string[] => [directory, ...readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() && !entry.name.startsWith('.sprindle') && !['.git', 'dist', 'dist-tooling', 'node_modules'].includes(entry.name) ? directories(resolve(directory, entry.name)) : [])]
  const refreshWatchers = () => {
    if (closed) return
    const wanted = new Set([...directories(project), ...(dependencyInputs.get(project) ?? []).map(dirname)])
    for (const directory of wanted) if (!watched.has(directory)) watched.set(directory, watch(directory, (_event, filename) => {
      if (filename?.toString().startsWith('.sprindle')) return
      if (!closed) { refreshWatchers(); schedule() }
    }))
    for (const [directory, watcher] of watched) if (!wanted.has(directory)) { watcher.close(); watched.delete(directory) }
  }
  const compile = () => { if (closed) return; queue = queue.then(() => compileRouteManifest(projectRoot, routesDirectory, output, bundle, options).then(() => { if (!closed) { refreshWatchers(); onResult?.() } }, (error: Error) => { if (!closed) { refreshWatchers(); onResult?.(error) } })) }
  const schedule = () => { if (closed) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; compile() }, 100) }
  refreshWatchers(); compile(); await queue
  return { close: async () => { closed = true; recursiveWatcher.close(); if (timer) { clearTimeout(timer); timer = undefined }; await queue; for (const watcher of watched.values()) watcher.close(); watched.clear() } }
}
