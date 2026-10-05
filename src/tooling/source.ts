import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'esbuild'
import { parse, type ParserOptions } from '@babel/parser'
import { parse as parseJsonc } from 'jsonc-parser'
import { helperSourceSpecifier, routeBindingMetadata } from './bindings.ts'
import { readRouteDirectory, type RouteDirectory } from './route-files.ts'

type PathMapping = { pattern: string; targets: string[]; base: string }
type ResolverSettings = { moduleSuffixes: string[]; paths: PathMapping[]; baseUrl?: string; inputs: Map<string, string> }
type ModuleSpecifier = { node: { start?: number | null; end?: number | null; value?: unknown }; value: string; kind: 'static' | 'dynamic' | 'require' | 'type'; callee?: { start?: number | null; end?: number | null } }
type ParsedModule = { program: { body: unknown[] }; comments?: { value: string; start?: number | null; end?: number | null }[] | null }
type RouteSourceGraph = Awaited<ReturnType<typeof routeSourceGraph>>
type StagedRouteSource = {
  directory: string
  readonly versionDirectory: string
  readonly version: string
  entryFile: string
  manifestSource(hash?: string): string
  pointerSource(hash: string): string
  originals: Map<string, string>
  settingsInputs: Map<string, string>
  origins: Map<string, string>
  entryModules: Map<string, string>
  runtimeSources: Map<string, string>
  addRuntimeFile(file: string, contents: string): Promise<void>
  publish(): Promise<void>
  cleanup(): Promise<void>
}

const routeHelpers = new Set(['defineScope', 'defineRoute', 'list', 'detail', 'create', 'update', 'deleteRoute'])
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']

function isRouteSourceFile(file: string) {
  return sourceExtensions.some((extension) => extension !== '.json' && file.endsWith(extension))
}

function parserOptions(file: string): ParserOptions {
  return { sourceType: 'unambiguous' as const, plugins: file.endsWith('.tsx') || file.endsWith('.jsx') ? ['typescript', 'jsx'] : ['typescript'], attachComment: true }
}

function contains(directory: string, file: string) {
  const path = relative(resolve(directory), resolve(file))
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function sourceReferenceSpecifier(fromFile: string, target: string) {
  let path = relative(dirname(fromFile), resolve(target)).replaceAll(sep, '/')
  if (!path.startsWith('../') && !path.startsWith('./')) path = `./${path}`
  return path
}

export async function withRouteGenerationLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const root = resolve(projectRoot)
  const lock = resolve(root, '.sprindle', 'generation.lock')
  await mkdir(dirname(lock), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + 120_000
  while (true) {
    try {
      await mkdir(lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await lockOwner(lock)
      const identity = await lockStat(lock)
      const stale = owner ? !processIsRunning(owner.pid) : identity !== undefined && Date.now() - identity.mtimeMs > 30_000
      if (stale) {
        const reclaim = resolve(lock, `reclaim-${owner?.token ?? 'empty'}`)
        try { await mkdir(reclaim) } catch (claimError) {
          if ((claimError as NodeJS.ErrnoException).code === 'ENOENT') continue
          if ((claimError as NodeJS.ErrnoException).code !== 'EEXIST') throw claimError
          if (Date.now() >= deadline) throw new Error(`Timed out while waiting for the route generation lock at ${lock}.`)
          await new Promise((done) => setTimeout(done, 25))
          continue
        }
        let removed = false
        try {
          const current = await lockOwner(lock)
          const currentIdentity = await lockStat(lock)
          const unchanged = owner
            ? current?.pid === owner.pid && current.token === owner.token
            : !current && sameLockIdentity(identity, currentIdentity)
          if (unchanged) { await rm(lock, { recursive: true, force: true }); removed = true }
        } finally {
          if (!removed) await rm(reclaim, { recursive: true, force: true })
        }
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Timed out while waiting for the route generation lock at ${lock}.`)
      await new Promise((done) => setTimeout(done, 25))
      continue
    }
    try {
      await writeFile(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }))
      break
    } catch (error) {
      await rm(lock, { recursive: true, force: true })
      throw error
    }
  }
  try {
    return await operation()
  } finally {
    const owner = await lockOwner(lock)
    if (owner?.token === token) await rm(lock, { recursive: true, force: true })
  }
}

export async function stageRouteSource(projectRoot: string, model: RouteDirectory, sourceGraph?: RouteSourceGraph): Promise<StagedRouteSource> {
  const project = resolve(projectRoot)
  const outputRoot = resolve(project, '.sprindle', 'source')
  const stageRoot = resolve(outputRoot, `.staging-${process.pid}-${randomUUID()}`)
  const graph = sourceGraph ?? await routeSourceGraph(project, model)
  const entryFiles = [...new Set([...model.scopes, ...model.routes.map((route) => route.sourcePath)])].map((file) => resolve(file)).sort()
  const entrySet = new Set(entryFiles)
  const routeRoot = resolve(model.root)
  const settings = graph.settings
  const originals = new Map(entryFiles.map((file) => [file, graph.contents.get(file)!]))
  const copiedFiles = new Map<string, string>()
  const origins = new Map<string, string>()
  const entryModules = new Map<string, string>()
  const runtimeSources = new Map<string, string>()
  const sourceModels = new Map<string, ReturnType<typeof routeBindingMetadata>>()
  const reverse = new Map<string, Set<string>>()
  const bindingModules = new Set<string>()

  for (const [file, dependencies] of graph.graph) {
    if (!isRouteSourceFile(file) || !contains(routeRoot, file)) continue
    const source = graph.contents.get(file)
    if (source === undefined || extname(file) === '.json') continue
    const program = graph.parsed.get(file)!
    if (needsBinding(program.program.body)) bindingModules.add(file)
    for (const dependency of dependencies) {
      const dependents = reverse.get(dependency) ?? new Set<string>()
      dependents.add(file)
      reverse.set(dependency, dependents)
    }
  }

  const projected = new Set(bindingModules)
  const queue = [...bindingModules]
  while (queue.length) {
    const dependency = queue.pop()!
    for (const importer of reverse.get(dependency) ?? []) if (!projected.has(importer)) {
      projected.add(importer)
      queue.push(importer)
    }
  }

  const projectionSet = new Set([...entrySet, ...projected])
  for (const original of [...projected].sort()) {
    const metadata = routeBindingMetadata(model.root, original, projectionSet)
    sourceModels.set(original, metadata)
    entryModules.set(original, resolve(stageRoot, 'routes', relative(model.root, original)))
  }

  for (const [original, generated] of entryModules) {
    const source = graph.contents.get(original)!
    const program = graph.parsed.get(original)!
    const metadata = sourceModels.get(original)!
    const helper = resolve(dirname(generated), `${metadata.helper}.ts`)
    const transformed = rebaseProjectedSource(source, original, generated, helper, settings, entryModules, bindingModules.has(original), program)
    copiedFiles.set(generated, transformed.source)
    runtimeSources.set(generated, transformed.runtimeSource)
    origins.set(generated, original)
  }

  const helpers = new Map<string, string>()
  for (const original of bindingModules) {
    const generated = entryModules.get(original)!
    const metadata = sourceModels.get(original)!
    const helper = resolve(dirname(generated), `${metadata.helper}.ts`)
    if (helpers.has(helper)) continue
    helpers.set(helper, original)
    copiedFiles.set(helper, helperSource(helper, metadata, entryModules))
    origins.set(helper, original)
  }

  const sourceIdentity = JSON.stringify([
    model.routes.map(({ sourcePath, httpPath, parameters, methods, scopes }) => [relative(project, sourcePath), httpPath, parameters, methods, scopes.map((file) => relative(project, file))]),
    [...copiedFiles].map(([file, source]) => [relative(stageRoot, file), source]),
  ])
  const manifestIdentity = createHash('sha256').update(sourceIdentity).digest('hex')
  const stageEntry = resolve(stageRoot, 'routes.ts')
  const entryImports = manifestImports(project, stageEntry, model, entryModules)
  const ambientReferences = graph.ambientSources.map((file) => sourceReferenceSpecifier(stageEntry, file))
  const manifestSource = (hash = manifestIdentity) => routeManifestSource(entryImports.imports, entryImports.entries, hash, ambientReferences)
  const pointerSource = (hash: string) => routePointerSource(version, hash)
  const sourceEntry = manifestSource(manifestIdentity)
  copiedFiles.set(stageEntry, sourceEntry)
  origins.set(stageEntry, stageEntry)
  let version = ''
  let versionDirectory = ''
  const updateVersion = () => {
    version = createHash('sha256').update(JSON.stringify([sourceIdentity, [...copiedFiles].map(([file, source]) => [relative(stageRoot, file), source])])).digest('hex')
    versionDirectory = resolve(outputRoot, version)
  }
  updateVersion()
  try {
    await mkdir(stageRoot, { recursive: true })
    for (const [file, source] of copiedFiles) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, source)
    }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true })
    throw error
  }

  return {
    directory: stageRoot,
    entryFile: stageEntry,
    manifestSource,
    pointerSource,
    originals,
    settingsInputs: settings.inputs,
    origins,
    entryModules,
    runtimeSources,
    get version() { return version },
    get versionDirectory() { return versionDirectory },
    async addRuntimeFile(file, contents) {
      const target = resolve(stageRoot, file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents)
      copiedFiles.set(target, contents)
      updateVersion()
    },
    async publish() {
      await mkdir(outputRoot, { recursive: true })
      if (existsSync(versionDirectory)) {
        const same = [...copiedFiles].every(([file, source]) => readFileSync(resolve(versionDirectory, relative(stageRoot, file)), 'utf8') === source)
        if (!same) throw new Error(`Immutable Sprindle source version is damaged: ${versionDirectory}`)
        await rm(stageRoot, { recursive: true, force: true })
      } else await rename(stageRoot, versionDirectory)
    },
    async cleanup() { await rm(stageRoot, { recursive: true, force: true }) },
  }
}

export function sourceInputOrigins(source: StagedRouteSource, file: string) {
  return source.origins.get(resolve(file))
}

export function generatedRuntimePlugin(graph: RouteSourceGraph, source: StagedRouteSource, runtimeFile: string): Plugin {
  const canonicalPath = (file: string) => {
    try { return realpathSync(file) } catch { return resolve(file) }
  }
  const generatedFiles = new Set([...source.origins.keys()].map(canonicalPath))
  const runtimeDirectory = canonicalPath(dirname(runtimeFile))
  const runtimeSources = new Map([...source.runtimeSources].map(([file, contents]) => [canonicalPath(file), contents]))
  return {
    name: 'sprindle-source-runtime',
    setup(build) {
      build.onResolve({ filter: /^@southneuhof\/sprindle(?:\/|$)/ }, (args) => ({ path: args.path, external: true }))
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        const contents = runtimeSources.get(canonicalPath(args.path))
        if (contents === undefined) return
        const extension = extname(args.path)
        const loader = extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : extension === '.js' || extension === '.mjs' || extension === '.cjs' ? 'js' : extension === '.mts' ? 'ts' : extension === '.cts' ? 'ts' : 'ts'
        return { contents, loader, resolveDir: dirname(args.path) }
      })
      build.onResolve({ filter: /^\./ }, (args) => {
        const target = resolveSpecifier(args.importer, args.path, graph.settings)
        if (!target || generatedFiles.has(canonicalPath(target))) return
        let path = relative(runtimeDirectory, canonicalPath(target)).replaceAll(sep, '/')
        if (!path.startsWith('../') && !path.startsWith('./')) path = `./${path}`
        return { path, external: true }
      })
    },
  }
}

export async function routeSourceGraph(projectRoot: string, model: RouteDirectory) {
  const project = resolve(projectRoot)
  const settings = await resolverSettings(project)
  const ambientSources = await ambientTypeSources(project)
  const entryFiles = [...new Set([...model.scopes, ...model.routes.map((route) => route.sourcePath)])].map((file) => resolve(file))
  const pending = [...new Set([...entryFiles, ...ambientSources])]
  const graph = new Map<string, string[]>()
  const runtimeGraph = new Map<string, string[]>()
  const staticGraph = new Map<string, string[]>()
  const contents = new Map<string, string>()
  const parsedSources = new Map<string, ParsedModule>()
  while (pending.length) {
    const file = pending.pop()!
    if (graph.has(file) || relative(project, file).split(sep).includes('node_modules')) continue
    const source = await readFile(file, 'utf8')
    contents.set(file, source)
    const dependencies = new Set<string>()
    const runtimeDependencies = new Set<string>()
    const staticDependencies = new Set<string>()
    if (isRouteSourceFile(file) && extname(file) !== '.json') {
      const parsedSource = parse(source, parserOptions(file))
      parsedSources.set(file, parsedSource)
      for (const specifier of moduleSpecifiers(parsedSource.program)) {
        if (isSprindlePackageSpecifier(specifier.value)) continue
        if (!specifier.value.startsWith('.') && !pathAlias(specifier.value, settings)) continue
        const target = resolveSpecifier(file, specifier.value, settings)
        if (!target) {
          if (specifier.value.startsWith('.')) throw new Error(`${file}: unable to resolve source import ${specifier.value}`)
          continue
        }
        if (relative(project, target).split(sep).includes('node_modules')) continue
        dependencies.add(target)
        if (specifier.kind === 'static' || specifier.kind === 'dynamic' || specifier.kind === 'require') runtimeDependencies.add(target)
        if (specifier.kind === 'static') staticDependencies.add(target)
        pending.push(target)
      }
      for (const comment of parsedSource.comments ?? []) {
        if (!comment.value.includes('<reference') || !comment.value.includes('path=')) continue
        const match = /path\s*=\s*['"]([^'"]+)['"]/.exec(comment.value)
        if (!match?.[1]) continue
        const target = resolveSpecifier(file, match[1], settings)
        if (!target) throw new Error(`${file}: unable to resolve type reference ${match[1]}`)
        dependencies.add(target)
        pending.push(target)
      }
    }
    graph.set(file, [...dependencies].sort())
    runtimeGraph.set(file, [...runtimeDependencies].sort())
    staticGraph.set(file, [...staticDependencies].sort())
  }
  const runtimeInputs = new Set<string>()
  const runtimePending = entryFiles.slice()
  while (runtimePending.length) {
    const file = runtimePending.pop()!
    if (runtimeInputs.has(file) || !runtimeGraph.has(file)) continue
    runtimeInputs.add(file)
    runtimePending.push(...(runtimeGraph.get(file) ?? []))
  }
  return { graph, runtimeGraph, staticGraph, runtimeInputs, contents, parsed: parsedSources, settingsInputs: settings.inputs, settings, ambientSources }
}

export async function verifyRouteSourceIdentity(projectRoot: string, model: RouteDirectory, source: StagedRouteSource, snapshots: Map<string, string>) {
  const current = await readRouteDirectory(model.root)
  const expectedRoutes = model.routes.map(({ sourcePath, httpPath, parameters, methods, scopes }) => [sourcePath, httpPath, parameters, methods, scopes])
  const currentRoutes = current.routes.map(({ sourcePath, httpPath, parameters, methods, scopes }) => [sourcePath, httpPath, parameters, methods, scopes])
  if (JSON.stringify(currentRoutes) !== JSON.stringify(expectedRoutes)) throw new Error('Sprindle route inputs changed during generation. Run the route producer again.')
  for (const [file, contents] of source.originals) if (await readFile(file, 'utf8') !== contents) throw new Error(`Sprindle source changed during generation: ${relative(projectRoot, file)}. Run the route producer again.`)
  for (const [file, contents] of snapshots) {
    if (!existsSync(file) || await readFile(file, 'utf8') !== contents) throw new Error(`Sprindle dependency changed during generation: ${relative(projectRoot, file)}. Run the route producer again.`)
  }
}

export async function atomicWriteIfChanged(target: string, contents: string) {
  if (existsSync(target) && readFileSync(target, 'utf8') === contents) return false
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents)
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  return true
}

export function sourceModuleSpecifier(fromFile: string, target: string) {
  let specifier = relative(dirname(fromFile), target).replaceAll(sep, '/')
  if (!specifier.startsWith('../') && !specifier.startsWith('./')) specifier = `./${specifier}`
  return specifier.replace(/\.d\.(?:ts|mts|cts)$|\.(?:[cm]?tsx?)$/, '')
}

function manifestImports(project: string, entry: string, model: RouteDirectory, modules: Map<string, string>) {
  const imports: string[] = []
  const names = new Map<string, string>()
  for (const scope of model.scopes) {
    const name = `scope${names.size}`
    names.set(resolve(scope), name)
    const target = modules.get(resolve(scope)) ?? resolve(scope)
    imports.push(`import ${name} from ${JSON.stringify(sourceModuleSpecifier(entry, target))}`)
  }
  const entries = model.routes.map((route, index) => {
    const name = `route${index}`
    const target = modules.get(resolve(route.sourcePath)) ?? resolve(route.sourcePath)
    imports.push(`import * as ${name} from ${JSON.stringify(sourceModuleSpecifier(entry, target))}`)
    const parameters = tuple(route.parameters)
    const methods = tuple(route.methods)
    return `{sourcePath:${JSON.stringify(relative(project, route.sourcePath).replaceAll(sep, '/'))},httpPath:${JSON.stringify(route.httpPath)} as const,parameters:${parameters},methods:${methods},scopes:[${route.scopes.map((scope) => names.get(resolve(scope))).join(',')}],handlers:${name}}`
  })
  return { imports, entries }
}

function tuple(values: string[]) {
  const entries = values.map((value) => JSON.stringify(value))
  return `[${entries.join(',')}] as [${entries.join(',')}]`
}

function routeManifestSource(imports: string[], entries: string[], hash: string, references: string[]) {
  const directives = references.map((path) => `/// <reference path=${JSON.stringify(path)} />`).join('\n')
  return `${directives}${directives ? '\n' : ''}${imports.join('\n')}\nimport type { InferRouteContract } from '@southneuhof/sprindle/routes'\nimport type { FileRouteManifest } from '@southneuhof/sprindle/hono'\nexport const hash=${JSON.stringify(hash)}\nexport const manifest=[${entries.join(',')}] satisfies FileRouteManifest\nexport type RouteContract=InferRouteContract<typeof manifest>\nexport default manifest\n`
}

function routePointerSource(version: string, hash: string) {
  return `export { default, manifest } from './source/${version}/routes'\nexport type { RouteContract } from './source/${version}/routes'\nexport const hash=${JSON.stringify(hash)}\n`
}

function needsBinding(body: unknown[]) {
  for (const statement of body) {
    const item = statement as { type?: string; source?: { value?: unknown }; importKind?: string; specifiers?: unknown[] }
    if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type ?? '') || item.source?.value !== '@southneuhof/sprindle' || item.importKind === 'type') continue
    if (item.type === 'ExportAllDeclaration') return true
    for (const raw of item.specifiers ?? []) {
      const specifier = raw as { type?: string; importKind?: string; imported?: { name?: string; value?: string } }
      if (specifier.importKind === 'type') continue
      if (specifier.type === 'ImportNamespaceSpecifier') return true
      const imported = specifier.imported?.name ?? specifier.imported?.value
      if (imported && routeHelpers.has(imported)) return true
    }
  }
  return false
}

function isSprindlePackageSpecifier(value: string) {
  return value === '@southneuhof/sprindle' || value.startsWith('@southneuhof/sprindle/')
}

function rebaseProjectedSource(source: string, original: string, generated: string, helper: string, settings: ResolverSettings, projectedModules: Map<string, string>, bindHelpers: boolean, parsed: ParsedModule) {
  const edits: { start: number; end: number; value: string }[] = []
  const helperPath = sourceModuleSpecifier(generated, helper)
  for (const specifier of moduleSpecifiers(parsed.program)) {
    if (bindHelpers && specifier.value === '@southneuhof/sprindle') {
      const node = specifier.node
      if (node.start != null && node.end != null) edits.push({ start: node.start, end: node.end, value: JSON.stringify(helperPath) })
      continue
    }
    if (isSprindlePackageSpecifier(specifier.value)) continue
    if (!specifier.value.startsWith('.') && !pathAlias(specifier.value, settings)) continue
    const resolved = resolveSpecifier(original, specifier.value, settings)
    if (!resolved) {
      if (specifier.value.startsWith('.')) throw new Error(`${original}: unable to resolve source import ${specifier.value}`)
      continue
    }
    if (resolved === resolve(original)) continue
    const target = projectedModules.get(resolved) ?? resolved
    const value = sourceModuleSpecifier(generated, target)
    if (specifier.node.start != null && specifier.node.end != null) edits.push({ start: specifier.node.start, end: specifier.node.end, value: JSON.stringify(value) })
  }
  for (const statement of parsed.program.body) {
    if (!statement || typeof statement !== 'object') continue
    const node = statement as { type?: string; source?: ModuleSpecifier['node']; attributes?: unknown[]; assertions?: unknown[] }
    if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type ?? '') || !node.source || node.attributes?.length || node.assertions?.length) continue
    const specifier = node.source.value
    if (typeof specifier !== 'string') continue
    const target = resolveSpecifier(original, specifier, settings)
    if (target && extname(target) === '.json' && node.source.end != null) edits.push({ start: node.source.end, end: node.source.end, value: ' with { type: "json" }' })
  }
  const addDynamicJsonAttributes = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(addDynamicJsonAttributes); return }
    const node = value as Record<string, unknown>
    const type = node.type
    const callee = node.callee as Record<string, unknown> | undefined
    const isImportCall = type === 'CallExpression' && callee?.type === 'Import'
    const sourceNode = type === 'ImportExpression'
      ? node.source as ModuleSpecifier['node'] | undefined
      : isImportCall
        ? (node.arguments as ModuleSpecifier['node'][] | undefined)?.[0]
        : undefined
    const hasOptions = type === 'ImportExpression' ? node.options !== null && node.options !== undefined : (node.arguments as unknown[] | undefined)?.length !== 1
    if (sourceNode && !hasOptions && typeof sourceNode.value === 'string' && sourceNode.end != null) {
      const target = resolveSpecifier(original, sourceNode.value, settings)
      if (target && extname(target) === '.json') edits.push({ start: sourceNode.end, end: sourceNode.end, value: ', { with: { type: "json" } }' })
    }
    Object.values(node).forEach(addDynamicJsonAttributes)
  }
  addDynamicJsonAttributes(parsed.program.body)
  for (const comment of parsed.comments ?? []) {
    if (!comment.value.includes('<reference') || !comment.value.includes('path=')) continue
    const match = /path\s*=\s*['"]([^'"]+)['"]/.exec(comment.value)
    if (!match?.[1] || comment.start == null || match.index === undefined) continue
    const start = source.indexOf(match[0], comment.start) + match[0].indexOf(match[1])
    const target = resolveSpecifier(original, match[1], settings)
    if (target) edits.push({ start, end: start + match[1].length, value: sourceReferenceSpecifier(generated, target) })
  }
  const replaced = applyEdits(source, edits)
  const runtimeEdits = edits.slice()
  const requireName = uniqueIdentifier(parsed.program, '__sprindleRequire')
  const createRequireName = uniqueIdentifier(parsed.program, '__sprindleCreateRequire')
  let hasExternalRequire = false
  for (const specifier of moduleSpecifiers(parsed.program)) {
    if (specifier.kind !== 'require' || specifier.node.start == null || specifier.node.end == null || specifier.callee?.start == null || specifier.callee.end == null) continue
    let target: string | undefined
    if (specifier.value.startsWith('.') || pathAlias(specifier.value, settings)) target = resolveSpecifier(original, specifier.value, settings)
    if (target && projectedModules.has(target)) continue
    const requireSpecifier = target
    if (requireSpecifier) {
      const argumentEdit = runtimeEdits.find((edit) => edit.start === specifier.node.start && edit.end === specifier.node.end)
      if (argumentEdit) argumentEdit.value = JSON.stringify(requireSpecifier)
      else runtimeEdits.push({ start: specifier.node.start, end: specifier.node.end, value: JSON.stringify(requireSpecifier) })
    }
    runtimeEdits.push({ start: specifier.callee.start, end: specifier.callee.end, value: requireName })
    hasExternalRequire = true
  }
  const runtimeBody = applyEdits(source, runtimeEdits)
  const runtimePrefix = hasExternalRequire ? `import{createRequire as ${createRequireName}}from'node:module';const ${requireName}=${createRequireName}(import.meta.url);\n` : ''
  return {
    source: `${replaced}${replaced.endsWith('\n') ? '' : '\n'}${sourceMapComment(original, source, generated, edits, parsed.program)}`,
    runtimeSource: `${runtimePrefix}${runtimeBody}${runtimeBody.endsWith('\n') ? '' : '\n'}${sourceMapComment(original, source, generated, runtimeEdits, parsed.program, runtimePrefix ? 1 : 0)}`,
  }
}

function moduleSpecifiers(program: ParsedModule['program']) {
  const found: ModuleSpecifier[] = []
  const seen = new Set<object>()
  const unboundRequireCalls = collectUnboundRequireCalls(program)
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    if (Array.isArray(value)) { value.forEach(visit); return }
    seen.add(value)
    const node = value as Record<string, unknown>
    const type = node.type
    const call = type === 'CallExpression' ? node : undefined
    const callee = call?.callee as Record<string, unknown> | undefined
    const argument = (call?.arguments as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined
    const moduleReference = node.moduleReference as Record<string, unknown> | undefined
    const importEqualsArgument = moduleReference?.type === 'TSExternalModuleReference' ? moduleReference.expression as Record<string, unknown> | undefined : undefined
    const dynamicCall = callee?.type === 'Import'
    const requireCall = callee?.type === 'Identifier' && callee.name === 'require'
    if (requireCall && !unboundRequireCalls.has(node)) {
      Object.values(node).forEach(visit)
      return
    }
    const literal = type === 'TSImportType' ? node.argument : type === 'ImportExpression' ? node.source : type === 'TSImportEqualsDeclaration' ? importEqualsArgument : ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(String(type)) ? node.source : dynamicCall || requireCall ? argument : undefined
    if (literal && typeof literal === 'object') {
      const item = literal as ModuleSpecifier['node']
      const value = typeof item.value === 'string' ? item.value : templateSpecifier(item as Record<string, unknown>)
      if (value !== undefined) found.push({ node: item, value, kind: moduleEdgeKind(node, String(type), dynamicCall, requireCall), ...(requireCall && callee ? { callee } : {}) })
    }
    Object.values(node).forEach(visit)
  }
  visit(program.body)
  return found
}

type LexicalScope = { parent?: LexicalScope; kind: 'program' | 'function' | 'block' | 'class'; bindings: Set<string> }

function collectUnboundRequireCalls(program: ParsedModule['program']) {
  const root: LexicalScope = { kind: 'program', bindings: new Set() }
  const scopes = new WeakMap<object, LexicalScope>()
  const bindPattern = (scope: LexicalScope, value: unknown) => {
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    if (node.type === 'Identifier' && typeof node.name === 'string') { scope.bindings.add(node.name); return }
    if (node.type === 'RestElement') { bindPattern(scope, node.argument); return }
    if (node.type === 'AssignmentPattern') { bindPattern(scope, node.left); return }
    if (node.type === 'TSParameterProperty') { bindPattern(scope, node.parameter); return }
    if (node.type === 'ObjectPattern') {
      for (const property of node.properties as unknown[] ?? []) {
        if (!property || typeof property !== 'object') continue
        const item = property as Record<string, unknown>
        bindPattern(scope, item.type === 'RestElement' ? item.argument : item.value)
      }
      return
    }
    if (node.type === 'ArrayPattern') for (const element of node.elements as unknown[] ?? []) bindPattern(scope, element)
  }
  const functionScope = (scope: LexicalScope) => {
    let current: LexicalScope | undefined = scope
    while (current && current.kind !== 'function' && current.kind !== 'program') current = current.parent
    return current ?? root
  }
  const visit = (value: unknown, parent: LexicalScope): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach((item) => visit(item, parent)); return }
    const node = value as Record<string, unknown>
    if (typeof node.type !== 'string') return
    let scope = parent
    const type = node.type
    const declared = node.declare === true
    if (type === 'Program') scope = root
    else if (type === 'BlockStatement' || type === 'StaticBlock' || type === 'SwitchStatement' || type === 'ForStatement' || type === 'ForInStatement' || type === 'ForOfStatement' || type === 'CatchClause') {
      scope = { parent, kind: type === 'StaticBlock' ? 'function' : 'block', bindings: new Set() }
      if (type === 'CatchClause') bindPattern(scope, node.param)
    } else if (type === 'ClassDeclaration' || type === 'ClassExpression') {
      if (type === 'ClassDeclaration' && !declared) bindPattern(parent, node.id)
      scope = { parent, kind: 'class', bindings: new Set() }
      if (type === 'ClassExpression') bindPattern(scope, node.id)
    } else if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'TSDeclareFunction', 'TSDeclareMethod'].includes(type)) {
      if (type === 'FunctionDeclaration' && !declared) bindPattern(parent, node.id)
      scope = { parent, kind: 'function', bindings: new Set() }
      if (type === 'FunctionExpression') bindPattern(scope, node.id)
      for (const parameter of node.params as unknown[] ?? []) bindPattern(scope, parameter)
    } else if (type === 'VariableDeclaration' && !declared) {
      const target = node.kind === 'var' ? functionScope(parent) : parent
      for (const declaration of node.declarations as Record<string, unknown>[] ?? []) bindPattern(target, declaration.id)
    } else if (type === 'ImportDeclaration' && node.importKind !== 'type') {
      for (const specifier of node.specifiers as Record<string, unknown>[] ?? []) if (specifier.importKind !== 'type') bindPattern(parent, specifier.local)
    } else if (type === 'TSImportEqualsDeclaration' && node.importKind !== 'type' && !declared) bindPattern(parent, node.id)
    else if ((type === 'TSEnumDeclaration' || type === 'EnumDeclaration' || type === 'TSModuleDeclaration') && !declared) bindPattern(parent, node.id)
    scopes.set(node, scope)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'comments' || key === 'tokens' || key === 'extra') continue
      visit(child, scope)
    }
  }
  visit(program, root)
  const unbound = new Set<object>()
  const findCalls = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(findCalls); return }
    const node = value as Record<string, unknown>
    if (node.type === 'CallExpression') {
      const callee = node.callee as Record<string, unknown> | undefined
      if (callee?.type === 'Identifier' && callee.name === 'require') {
        let scope = scopes.get(node)
        let bound = false
        while (scope) { if (scope.bindings.has('require')) { bound = true; break } scope = scope.parent }
        if (!bound) unbound.add(node)
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'comments' || key === 'tokens' || key === 'extra') continue
      findCalls(child)
    }
  }
  findCalls(program)
  return unbound
}

function uniqueIdentifier(program: ParsedModule['program'], preferred: string) {
  const names = new Set<string>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const node = value as Record<string, unknown>
    if (node.type === 'Identifier' && typeof node.name === 'string') names.add(node.name)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'comments' || key === 'tokens' || key === 'extra') continue
      visit(child)
    }
  }
  visit(program)
  let name = preferred
  let index = 0
  while (names.has(name)) name = `${preferred}${++index}`
  return name
}

function templateSpecifier(node: Record<string, unknown>) {
  if (node.type !== 'TemplateLiteral' || (node.expressions as unknown[] | undefined)?.length !== 0) return undefined
  const quasis = node.quasis as { value?: { cooked?: unknown; raw?: unknown } }[] | undefined
  if (quasis?.length !== 1) return undefined
  const value = quasis[0]?.value?.cooked ?? quasis[0]?.value?.raw
  return typeof value === 'string' ? value : undefined
}

function moduleEdgeKind(node: Record<string, unknown>, type: string, dynamicCall: boolean, requireCall: boolean): ModuleSpecifier['kind'] {
  if (type === 'TSImportType') return 'type'
  if (type === 'ImportExpression' || dynamicCall) return 'dynamic'
  if (type === 'TSExternalModuleReference' || requireCall) return 'require'
  if (type === 'TSImportEqualsDeclaration') return node.importKind === 'type' ? 'type' : 'require'
  if (type === 'ImportDeclaration') {
    if (node.importKind === 'type') return 'type'
    const specifiers = node.specifiers as { importKind?: string }[] | undefined
    return specifiers?.length && specifiers.every((specifier) => specifier.importKind === 'type') ? 'type' : 'static'
  }
  if (type === 'ExportNamedDeclaration' || type === 'ExportAllDeclaration') {
    if (node.exportKind === 'type') return 'type'
    const specifiers = node.specifiers as { exportKind?: string }[] | undefined
    return specifiers?.length && specifiers.every((specifier) => specifier.exportKind === 'type') ? 'type' : 'static'
  }
  return 'static'
}

function applyEdits(source: string, edits: { start: number; end: number; value: string }[]) {
  const ordered = edits.sort((left, right) => right.start - left.start)
  let boundary = source.length
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end > boundary) throw new Error('Sprindle source transformation contains overlapping module edits.')
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end)
    boundary = edit.start
  }
  return source
}

function sourceMapComment(original: string, source: string, generated: string, edits: { start: number; end: number; value: string }[], program: ParsedModule['program'], generatedLineOffset = 0) {
  const lineStarts = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index! + 1)]
  const positions = astPositions(program)
  let previousSource = 0
  let previousOriginalLine = 0
  let previousOriginalColumn = 0
  const mappings = lineStarts.map((lineStart, line) => {
    const lineEnd = lineStarts[line + 1] === undefined ? source.length : lineStarts[line + 1]! - 1
    const points: { generated: number; original: number }[] = [{ generated: 0, original: 0 }]
    let shift = 0
    for (const edit of edits.slice().sort((left, right) => left.start - right.start)) {
      if (edit.start < lineStart || edit.start > lineEnd || edit.end > lineEnd) continue
      const originalStart = edit.start - lineStart
      const generatedStart = originalStart + shift
      const generatedEnd = generatedStart + edit.value.length
      points.push({ generated: generatedStart, original: originalStart }, { generated: generatedEnd, original: edit.end - lineStart })
      shift += edit.value.length - (edit.end - edit.start)
    }
    for (const position of positions) {
      if (position < lineStart || position > lineEnd || edits.some((edit) => position > edit.start && position < edit.end)) continue
      const column = position - lineStart
      const offset = edits.filter((edit) => edit.start >= lineStart && edit.end <= position).reduce((total, edit) => total + edit.value.length - (edit.end - edit.start), 0)
      points.push({ generated: column + offset, original: column })
    }
    const unique = [...new Map(points.sort((left, right) => left.generated - right.generated).map((point) => [point.generated, point])).values()]
    let previousGeneratedColumn = 0
    return unique.map(({ generated: generatedColumn, original: originalColumn }) => {
      const fields = [generatedColumn - previousGeneratedColumn, -previousSource, line - previousOriginalLine, originalColumn - previousOriginalColumn]
      previousGeneratedColumn = generatedColumn
      previousSource = 0
      previousOriginalLine = line
      previousOriginalColumn = originalColumn
      return fields.map(encodeVlq).join('')
    }).join(',')
  }).join(';')
  const sourcePath = relative(dirname(generated), original).replaceAll(sep, '/')
  const map = { version: 3, file: basename(generated), sources: [sourcePath], sourcesContent: [source], names: [], mappings: `${';'.repeat(generatedLineOffset)}${mappings}` }
  return `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`
}

function astPositions(program: ParsedModule['program']) {
  const positions = new Set<number>()
  const seen = new Set<object>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    if (Array.isArray(value)) { value.forEach(visit); return }
    seen.add(value)
    const node = value as Record<string, unknown>
    if (typeof node.type === 'string') {
      if (typeof node.start === 'number') positions.add(node.start)
      if (typeof node.end === 'number') positions.add(node.end)
    }
    Object.values(node).forEach(visit)
  }
  visit(program)
  return positions
}

function encodeVlq(value: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = value < 0 ? ((-value) << 1) + 1 : value << 1
  let output = ''
  do {
    let digit = encoded & 31
    encoded >>>= 5
    if (encoded) digit |= 32
    output += alphabet[digit]
  } while (encoded)
  return output
}

function helperSource(generated: string, metadata: ReturnType<typeof routeBindingMetadata>, modules: Map<string, string>) {
  const parent = metadata.parentFile
  const parentTarget = parent ? modules.get(resolve(parent)) ?? resolve(parent) : undefined
  const parentType = parentTarget ? `typeof import(${JSON.stringify(helperSourceSpecifier(generated, parentTarget))}).default` : 'ScopeView<{}, never>'
  const params = `{${metadata.parameters.map((name) => `${JSON.stringify(name)}: string`).join(';')}}`
  const runtime = `import { create as runtimeCreate, defineRoute as runtimeDefineRoute, defineScope as runtimeDefineScope, deleteRoute as runtimeDeleteRoute, detail as runtimeDetail, list as runtimeList, update as runtimeUpdate } from '@southneuhof/sprindle/routes'\nexport * from '@southneuhof/sprindle'\nimport type { DefineFileCreate, DefineFileDelete, DefineFileDetail, DefineFileList, DefineFileRoute, DefineFileScope, DefineFileUpdate, ScopeView } from '@southneuhof/sprindle/routes'\ntype Parent=${parentType}\ntype Params=${params}\nexport const defineScope=runtimeDefineScope as DefineFileScope<Parent,Params>\nexport const defineRoute=runtimeDefineRoute as DefineFileRoute<Parent,Params>\nexport const list=runtimeList as DefineFileList<Parent,Params>\nexport const detail=runtimeDetail as DefineFileDetail<Parent,Params>\nexport const create=runtimeCreate as DefineFileCreate<Parent,Params>\nexport const update=runtimeUpdate as DefineFileUpdate<Parent,Params>\nexport const deleteRoute=runtimeDeleteRoute as DefineFileDelete<Parent,Params>\n`
  return runtime
}

async function resolverSettings(project: string): Promise<ResolverSettings> {
  const chain = await configChain(resolve(project, 'tsconfig.json'))
  let baseUrl: string | undefined
  let moduleSuffixes = ['']
  const paths = new Map<string, PathMapping>()
  const inputs = new Map<string, string>()
  for (const file of chain) {
    const directory = dirname(file)
    const contents = readFileSync(file, 'utf8')
    inputs.set(file, contents)
    const options = (parseJsonc(contents) as { compilerOptions?: Record<string, unknown> } | undefined)?.compilerOptions
    if (!options) continue
    if (typeof options.baseUrl === 'string') baseUrl = resolve(directory, options.baseUrl)
    if (Array.isArray(options.moduleSuffixes) && options.moduleSuffixes.every((value) => typeof value === 'string')) moduleSuffixes = options.moduleSuffixes as string[]
    if (options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
      const base = baseUrl ?? directory
      for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) if (Array.isArray(targets) && targets.every((target) => typeof target === 'string')) paths.set(pattern, { pattern, targets: targets as string[], base })
    }
  }
  return { moduleSuffixes, paths: [...paths.values()].sort((left, right) => specificity(right.pattern) - specificity(left.pattern)), baseUrl, inputs }
}

async function ambientTypeSources(project: string) {
  const chain = await configChain(resolve(project, 'tsconfig.json'))
  let files: { values: string[]; base: string } | undefined
  let include: { values: string[]; base: string } | undefined
  let exclude: { values: string[]; base: string } | undefined
  for (const config of chain) {
    const value = parseJsonc(await readFile(config, 'utf8')) as { files?: unknown; include?: unknown; exclude?: unknown } | undefined
    for (const key of ['files', 'include', 'exclude'] as const) {
      const setting = value?.[key]
      if (!Array.isArray(setting) || !setting.every((entry) => typeof entry === 'string')) continue
      const selected = { values: setting as string[], base: dirname(config) }
      if (key === 'files') files = selected
      if (key === 'include') include = selected
      if (key === 'exclude') exclude = selected
    }
  }
  const exact = (files?.values ?? []).map((file) => resolve(files!.base, file))
  const patterns = include ?? (files ? undefined : { values: ['**/*'], base: project })
  const candidates = new Set(exact)
  if (patterns) for (const file of sourceFiles(patterns.base)) if (patterns.values.some((pattern) => matchesGlob(pattern, patterns.base, file)) && !(exclude?.values.some((pattern) => matchesGlob(pattern, exclude.base, file)) ?? false)) candidates.add(file)
  const ambient: string[] = []
  for (const file of candidates) {
    if (!existsSync(file) || !isRouteSourceFile(file) || extname(file) === '.json') continue
    let source: string
    try { source = readFileSync(file, 'utf8') } catch { continue }
    let program: ReturnType<typeof parse>['program']
    try { program = parse(source, parserOptions(file)).program } catch { continue }
    const moduleFile = program.body.some((statement) => ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration', 'TSImportEqualsDeclaration', 'TSExportAssignment'].includes(statement.type))
    if (!moduleFile || program.body.some((statement) => statement.type === 'TSModuleDeclaration')) ambient.push(file)
  }
  return ambient.sort()
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && (entry.name.startsWith('.sprindle') || ['.git', 'dist', 'dist-tooling', 'node_modules'].includes(entry.name))) return []
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return isRouteSourceFile(file) ? [file] : []
  })
}

function matchesGlob(pattern: string, base: string, file: string) {
  let normalized = pattern.replaceAll('\\', '/')
  const candidate = relative(resolve(base), resolve(file)).replaceAll(sep, '/')
  if (isAbsolute(candidate) || candidate === '..' || candidate.startsWith('../')) return false
  if (!/[?*]/.test(normalized) && existsSync(resolve(base, normalized)) && statSync(resolve(base, normalized)).isDirectory()) normalized = `${normalized.replace(/\/$/, '')}/**/*`
  let source = '^'
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index]!
    if (character === '*' && normalized[index + 1] === '*') {
      index++
      if (normalized[index + 1] === '/') { source += '(?:.*/)?'; index++ }
      else source += '.*'
    } else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${source}$`).test(candidate)
}

async function configChain(file: string, seen = new Set<string>()): Promise<string[]> {
  const target = resolve(file)
  if (seen.has(target) || !existsSync(target)) return []
  seen.add(target)
  const value = parseJsonc(await readFile(target, 'utf8')) as { extends?: string | string[] } | undefined
  const extended = typeof value?.extends === 'string' ? [value.extends] : value?.extends ?? []
  const parents = await Promise.all(extended.map(async (parent) => {
    if (!parent.startsWith('.') && !isAbsolute(parent)) return []
    let resolved = resolve(dirname(target), parent)
    if (!extname(resolved)) resolved = `${resolved}.json`
    if (existsSync(resolved)) return configChain(resolved, seen)
    const directoryConfig = resolve(dirname(target), parent, 'tsconfig.json')
    return existsSync(directoryConfig) ? configChain(directoryConfig, seen) : []
  }))
  return [...parents.flat(), target]
}

function specificity(pattern: string) {
  return pattern.replace('*', '').length
}

function pathAlias(specifier: string, settings: ResolverSettings) {
  return settings.paths.some((mapping) => pathPattern(mapping.pattern, specifier) !== undefined)
}

function pathPattern(pattern: string, specifier: string) {
  const index = pattern.indexOf('*')
  if (index < 0) return pattern === specifier ? '' : undefined
  if (pattern.indexOf('*', index + 1) >= 0) return undefined
  const prefix = pattern.slice(0, index), suffix = pattern.slice(index + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) return undefined
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function resolveSpecifier(importer: string, specifier: string, settings: ResolverSettings) {
  for (const mapping of settings.paths) {
    const wildcard = pathPattern(mapping.pattern, specifier)
    if (wildcard === undefined) continue
    for (const target of mapping.targets) {
      const mapped = resolveExistingModule(resolve(mapping.base, target.replace('*', wildcard)), settings.moduleSuffixes)
      if (mapped) return mapped
    }
  }
  if (specifier.startsWith('.')) return resolveExistingModule(resolve(dirname(importer), specifier), settings.moduleSuffixes)
  if (settings.baseUrl) return resolveExistingModule(resolve(settings.baseUrl, specifier), settings.moduleSuffixes)
}

function resolveExistingModule(base: string, suffixes: string[]) {
  if (/\.d\.(?:ts|mts|cts)$/.test(base)) return existsSync(base) && statSync(base).isFile() ? base : undefined
  const extension = sourceExtensions.find((candidate) => base.endsWith(candidate)) ?? ''
  const substitutions: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.d.ts', '.js'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.d.mts', '.mjs'],
    '.cjs': ['.cts', '.d.cts', '.cjs'],
  }
  const candidates: string[] = []
  if (extension) {
    const stem = base.slice(0, -extension.length)
    for (const suffix of suffixes) for (const replacement of substitutions[extension] ?? [extension]) candidates.push(`${stem}${suffix}${replacement}`)
    candidates.push(base)
  } else {
    for (const suffix of suffixes) for (const item of sourceExtensions) candidates.push(`${base}${suffix}${item}`)
    for (const suffix of suffixes) for (const item of sourceExtensions) candidates.push(join(base, `index${suffix}${item}`))
  }
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

async function lockOwner(lock: string) {
  try {
    const value = JSON.parse(await readFile(resolve(lock, 'owner.json'), 'utf8')) as { pid?: unknown; token?: unknown }
    return typeof value.pid === 'number' && typeof value.token === 'string' ? { pid: value.pid, token: value.token } : undefined
  } catch { return undefined }
}

async function lockStat(lock: string) {
  try {
    const value = await stat(lock)
    return { dev: value.dev, ino: value.ino, mtimeMs: value.mtimeMs }
  } catch { return undefined }
}

function sameLockIdentity(left: Awaited<ReturnType<typeof lockStat>>, right: Awaited<ReturnType<typeof lockStat>>) {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino
}

function processIsRunning(pid: number) {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
