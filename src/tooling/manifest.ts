import { createHash, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import chokidar, { type FSWatcher } from 'chokidar'
import { build } from 'esbuild'
import { parse } from 'jsonc-parser'
import { parse as parseTypeScript } from '@babel/parser'
import { readRouteDirectory } from './route-files.ts'
import { atomicWriteIfChanged, generatedRuntimePlugin, routeSourceGraph, sourceInputOrigins, stageRouteSource, verifyRouteSourceIdentity, withRouteGenerationLock } from './source.ts'
import { createRouteResolutionReceipt, externalPackageTarget, isNodeBuiltin, packageManifestForTarget, resolveRuntimeEdges, routeImportPackageSelectionIsValid, type RouteImportRecord, type RuntimeResolutionContext } from './resolution.ts'
import { stopOwnedProcessTree } from './process.ts'

const dependencyInputs = new Map<string, string[]>()
const defaultGenerationTimeoutMs = 120_000
const generationStopGraceMs = 2_500
const generationStopWaitMs = 1_500

export type WatchRouteManifestOptions = {
  signal?: AbortSignal
  generationTimeoutMs?: number
}

export type GenerationRequest = {
  projectRoot: string
  routesDirectory: string
  output: string
  bundle: boolean
  dependencyInputs: string[]
}

type GenerationFailure = Error & { dependencyInputs?: string[]; stopFailed?: boolean }
type GenerationResult = { target: string; dependencyInputs: string[] }
type WorkerError = { message: string; stack?: string }
type WorkerMessage =
  | { type: 'dependencies'; dependencyInputs: string[] }
  | { type: 'result'; ok: true; target: string; dependencyInputs: string[] }
  | { type: 'result'; ok: false; error: WorkerError; dependencyInputs: string[] }

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

function edgeKind(kind: string) {
  if (kind === 'dynamic-import') return 'dynamic'
  if (kind === 'require-call' || kind === 'require-resolve') return 'require'
  return kind === 'import-statement' ? 'static' : undefined
}

function outputContainsRequire(code: string, specifier: string) {
  const program = parseTypeScript(code, { sourceType: 'module', plugins: ['typescript'] }).program
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(visit)
    const node = value as Record<string, unknown>
    if (node.type === 'CallExpression') {
      const args = node.arguments as { type?: string; value?: unknown }[] | undefined
      if (args?.[0]?.type === 'StringLiteral' && args[0].value === specifier) return true
    }
    return Object.entries(node).some(([key, child]) => !['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'extra'].includes(key) && visit(child))
  }
  return visit(program)
}

function bundleRuntimeSelections(project: string, runtimeFile: string, generated: Awaited<ReturnType<typeof stageRouteSource>>, sourceGraph: Awaited<ReturnType<typeof routeSourceGraph>>, analysis: Awaited<ReturnType<typeof build>>, sourceMode: boolean) {
  const inputs = Object.entries(analysis.metafile?.inputs ?? {})
  const canonical = (file: string) => existingRealPath(file) ?? resolve(file)
  const inputOrigin = (file: string) => sourceInputOrigins(generated, file) ?? file
  const observedImporters = new Set(inputs.map(([input]) => canonical(inputOrigin(canonical(isAbsolute(input) ? input : resolve(project, input))))))
  const outputTarget = (path: string, external: boolean) => {
    if (external) return path
    const file = canonical(isAbsolute(path) ? path : resolve(project, path))
    return canonical(inputOrigin(file))
  }
  const observed = inputs.flatMap(([input, value]) => {
    const file = canonical(isAbsolute(input) ? input : resolve(project, input))
    const importer = canonical(inputOrigin(file))
    return value.imports.map((item) => ({ sourceImporter: file, importer, original: item.original, kind: edgeKind(item.kind), target: outputTarget(item.path, Boolean(item.external)), external: Boolean(item.external) }))
  })
  const externalEdges: RouteImportRecord[] = []
  const externalContexts = new Map<RouteImportRecord, RuntimeResolutionContext>()
  for (const edge of sourceGraph.importEdges) {
    if (edge.kind === 'type') continue
    const importer = canonical(edge.importer)
    const emittedSpecifier = generated.runtimeImportSpecifiers.get(edge) ?? edge.specifier
    const generatedImporter = edge.consumerSource ? canonical(resolve(generated.directory, edge.consumerSource)) : undefined
    const outputRelative = sourceMode && edge.runtimeTarget && !edge.runtimeTarget.startsWith('node:')
      ? relative(canonical(dirname(runtimeFile)), canonical(edge.runtimeTarget)).replaceAll(sep, '/')
      : undefined
    const outputSpecifier = outputRelative && !outputRelative.startsWith('../') && !outputRelative.startsWith('./') ? `./${outputRelative}` : outputRelative
    const emittedSpecifiers = new Set([emittedSpecifier, edge.specifier, outputSpecifier].filter((value): value is string => Boolean(value)))
    const authored = observed.filter((item) => (generatedImporter ? item.sourceImporter === generatedImporter : item.importer === importer) && item.kind === edge.kind && (emittedSpecifiers.has(item.original ?? '') || emittedSpecifiers.has(item.target)))
    const selectedTarget = authored.find((item) => !item.external)?.target
    if (selectedTarget) {
      edge.runtimeTarget = selectedTarget
      edge.runtimeEvidence = 'esbuild'
      if (edge.generatedBinding) edge.packageTarget = false
      const modeled = edge.typeTargets.filter((target) => !externalPackageTarget(edge.specifier, target))
      if (modeled.length && !modeled.some((target) => canonical(target) === canonical(selectedTarget))) {
        throw new Error(`${edge.importer}: API compiler selected ${modeled.join(', ')} for ${edge.specifier}, but esbuild selected ${selectedTarget}.`)
      }
      continue
    }
    const packageEdge = authored.some((item) => item.external) || isNodeBuiltin(edge.specifier) || edge.packageTarget
    if (!authored.length && sourceMode && generatedImporter && edge.kind === 'require') {
      if (!outputContainsRequire(analysis.outputFiles?.[0]?.text ?? '', emittedSpecifier)) throw new Error(`${edge.importer}: generated source output did not retain require ${emittedSpecifier} for ${edge.specifier}.`)
      externalEdges.push(edge)
      externalContexts.set(edge, { importer: runtimeFile, specifier: emittedSpecifier })
      continue
    }
    if (packageEdge) {
      if (!authored.length && sourceMode && !observedImporters.has(importer) && edge.runtimeTarget) continue
      const emitted = authored.filter((item) => item.external).map((item) => item.target)
      const specifiers = [...new Set(emitted)]
      if (specifiers.length !== 1) throw new Error(`${edge.importer}: esbuild did not provide one emitted external import for ${edge.specifier}: ${specifiers.join(', ') || 'none'}.`)
      externalEdges.push(edge)
      externalContexts.set(edge, { importer: runtimeFile, specifier: specifiers[0]! })
      continue
    }
    if (!authored.length && sourceMode && !observedImporters.has(importer) && edge.runtimeTarget) continue
    const expected = [...edge.typeTargets.filter((target) => !externalPackageTarget(edge.specifier, target)), ...(sourceGraph.graphEdgeTargets.get(edge) ? [sourceGraph.graphEdgeTargets.get(edge)!] : [])].map(canonical)
    const staged = observed.filter((item) => item.importer === importer && item.kind === edge.kind && !item.external && expected.includes(item.target))
    if (staged.length === 1) {
      edge.runtimeTarget = staged[0]!.target
      edge.runtimeEvidence = 'esbuild'
      continue
    }
    throw new Error(`${edge.importer}: esbuild did not provide runtime resolution evidence for ${edge.specifier}: expected ${expected.join(', ') || 'no local target'}; emitted ${emittedSpecifier} from ${generatedImporter ?? importer}; output ${outputSpecifier}; observed ${observed.filter((item) => item.importer === importer).map((item) => `${item.sourceImporter} ${item.original ?? item.target} -> ${item.target} (${item.kind})`).join(', ') || 'no imports'}.`)
  }
  return { externalEdges, externalContexts }
}

async function resolutionInputs(sourceGraph: Awaited<ReturnType<typeof routeSourceGraph>>, configFiles: string[]) {
  const files = new Set([...sourceGraph.graph.keys(), ...configFiles])
  for (const edge of sourceGraph.importEdges) {
    for (const target of [...edge.typeTargets, ...(edge.runtimeTarget && !edge.runtimeTarget.startsWith('node:') ? [edge.runtimeTarget] : [])]) {
      const manifest = packageManifestForTarget(target)
      if (manifest) files.add(manifest)
    }
  }
  return new Map(await Promise.all([...files].sort().map(async (file) => [file, sourceGraph.contents.get(file) ?? sourceGraph.settingsInputs.get(file) ?? await readFile(file, 'utf8')] as const)))
}

export async function compileRouteManifest(projectRoot: string, routesDirectory = 'routes', output = '.sprindle/routes.mjs', bundle = true) {
  return withRouteGenerationLock(projectRoot, () => compileRouteManifestLocked(projectRoot, routesDirectory, output, bundle))
}

export async function runRouteManifestGeneration(request: GenerationRequest, onDependencyInputs: (inputs: string[]) => void, signal?: AbortSignal) {
  const project = resolve(request.projectRoot)
  dependencyInputs.set(project, [...request.dependencyInputs])
  const updateInputs = (inputs: string[]) => {
    const current = [...new Set(inputs)].sort()
    dependencyInputs.set(project, current)
    onDependencyInputs(current)
  }
  const assertConnected = () => {
    if (!process.connected || signal?.aborted) throw new Error(`Route manifest generation parent disconnected for ${request.output} in ${project}.`)
  }
  try {
    const target = await withRouteGenerationLock(project, () => compileRouteManifestLocked(project, request.routesDirectory, request.output, request.bundle, assertConnected, updateInputs, signal))
    return { type: 'result', ok: true as const, target, dependencyInputs: dependencyInputs.get(project) ?? request.dependencyInputs }
  } catch (error) {
    return {
      type: 'result',
      ok: false as const,
      error: { message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) },
      dependencyInputs: dependencyInputs.get(project) ?? request.dependencyInputs,
    }
  }
}

async function compileRouteManifestLocked(projectRoot: string, routesDirectory: string, output: string, bundle: boolean, assertActive: () => void = () => {}, onDependencyInputs?: (inputs: string[]) => void, signal?: AbortSignal) {
  assertActive()
  const project = resolve(projectRoot)
  const root = resolve(projectRoot, routesDirectory)
  const model = await readRouteDirectory(root)
  const target = resolve(projectRoot, output)
  const portablePath = (file: string) => relative(projectRoot, file).replaceAll(sep, '/')
  const portable = model.routes.map((route) => ({ ...route, sourcePath: portablePath(route.sourcePath), scopes: route.scopes.map(portablePath) }))
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const placeholder = '0'.repeat(64)
  const sourceGraph = await routeSourceGraph(project, model, bundle ? 'bundle' : 'source')
  const generated = await stageRouteSource(project, model, sourceGraph)
  let published = false
  try {
    const provisionalSource = generated.manifestSource(placeholder)
    await writeFile(generated.entryFile, provisionalSource)
    const graph = sourceGraph.graph
    for (const [file, contents] of generated.settingsInputs) if (sourceGraph.settingsInputs.get(file) !== contents) throw new Error(`Sprindle TypeScript config changed during generation: ${relative(project, file)}. Run the route producer again.`)
    if (sourceGraph.settingsInputs.size !== generated.settingsInputs.size) throw new Error('Sprindle TypeScript config inputs changed during generation. Run the route producer again.')
    const configFiles = await configInputs(resolve(project, 'tsconfig.json'))
    const runtimeInputs = [...new Set([...sourceGraph.runtimeInputs, ...configFiles])].sort()
    dependencyInputs.set(project, runtimeInputs)
    onDependencyInputs?.(runtimeInputs)
    const cycleInputs = Object.fromEntries([...graph.keys()].map((file) => [file, { imports: (sourceGraph.staticGraph.get(file) ?? []).map((path) => ({ path, kind: 'import-statement' })) }]))
    rejectStaticCycles(project, cycleInputs)
    const runtimeFile = bundle ? target : resolve(generated.directory, 'routes.mjs')
    const buildOutput = bundle ? temporary : runtimeFile
    const buildOutputDirectory = existingRealPath(dirname(buildOutput))
    const analysis = await build({ absWorkingDir: project, entryPoints: [generated.entryFile], outfile: buildOutputDirectory ? resolve(buildOutputDirectory, basename(buildOutput)) : buildOutput, write: false, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', metafile: true, sourcemap: 'inline', plugins: bundle ? [] : [generatedRuntimePlugin(sourceGraph, generated, runtimeFile)] })
    const realPath = (file: string) => existingRealPath(file) ?? file
    const graphOwners = new Set([...graph.keys()].map(realPath))
    const runtimeOwners = new Set([...sourceGraph.runtimeInputs].map(realPath))
    for (const input of Object.keys(analysis.metafile.inputs)) {
      const inputFile = isAbsolute(input) ? resolve(input) : resolve(project, input)
      const origin = sourceInputOrigins(generated, inputFile) ?? inputFile
      if (origin === generated.entryFile) continue
      const canonicalOrigin = realPath(origin)
      if (!graph.has(origin) && !graphOwners.has(canonicalOrigin)) throw new Error(`Sprindle generated source has no author input owner: ${relative(project, origin)}.`)
      if (!sourceGraph.runtimeInputs.has(origin) && !runtimeOwners.has(canonicalOrigin)) throw new Error(`Sprindle runtime analysis found an untracked runtime input: ${relative(project, origin)}.`)
    }
    if (analysis.outputFiles?.length !== 1 || !analysis.outputFiles[0]) throw new Error('Sprindle runtime build: expected one output file')
    {
      const { externalEdges, externalContexts } = bundleRuntimeSelections(project, bundle ? target : runtimeFile, generated, sourceGraph, analysis, !bundle)
      const externalTargets = await resolveRuntimeEdges(project, externalEdges, sourceGraph.runtimeMode, externalContexts, signal)
      externalEdges.forEach((edge, index) => {
        const target = externalTargets.get(index)
        if (!target) throw new Error(`${edge.importer}: missing Node runtime resolution for ${edge.specifier}.`)
        edge.runtimeTarget = target
        edge.runtimeEvidence = 'node'
        edge.packageTarget ||= !isNodeBuiltin(edge.specifier) && externalPackageTarget(edge.specifier, target)
      })
    }
    for (const edge of sourceGraph.importEdges) {
      if (edge.kind !== 'type' && !edge.runtimeTarget) throw new Error(`${edge.importer}: missing runtime resolution evidence for ${edge.specifier}.`)
      if (edge.packageTarget && !routeImportPackageSelectionIsValid(edge, sourceGraph.customConditions, sourceGraph.producerModuleResolution)) {
        throw new Error(`${edge.importer}: API runtime selected ${edge.runtimeTarget ?? 'unresolved'} and API compiler selected ${edge.typeTargets.join(', ') || 'unresolved'} for ${edge.specifier}, but its declared package mapping does not relate those targets.`)
      }
    }
    const inputContents = await resolutionInputs(sourceGraph, configFiles)
    const finalInputs = [...new Set([...runtimeInputs, ...[...inputContents.keys()].filter((file) => basename(file) === 'package.json')])].sort()
    dependencyInputs.set(project, finalInputs)
    onDependencyInputs?.(finalInputs)
    const hash = createHash('sha256').update(JSON.stringify([portable, runtimeInputs.map((file) => relative(project, file).replaceAll(sep, '/')), runtimeInputs.map((file) => inputContents.get(file))])).digest('hex')
    const runtime = finalizeBundle(analysis.outputFiles[0].text, provisionalSource, placeholder, hash)
    if (bundle) await writeFile(temporary, runtime)
    else await generated.addGeneratedFile('routes.mjs', runtime)
    const receipt = createRouteResolutionReceipt({
      producerRoot: project,
      producerConfig: resolve(project, 'tsconfig.json'),
      producerCompiler: sourceGraph.producerCompiler,
      producerModuleResolution: sourceGraph.producerModuleResolution,
      runtimeMode: sourceGraph.runtimeMode,
      customConditions: sourceGraph.customConditions,
      edges: sourceGraph.importEdges,
      sourceOrigins: [...generated.origins].flatMap(([file, origin]) => file === generated.entryFile ? [] : [{ source: relative(generated.directory, file).replaceAll(sep, '/'), origin }]),
      inputContents,
    })
    await generated.addGeneratedFile('resolution.json', `${JSON.stringify(receipt)}\n`)
    await writeFile(generated.entryFile, generated.manifestSource())
    await verifyRouteSourceIdentity(project, model, generated, inputContents)
    assertActive()
    await generated.publish()
    assertActive()
    const sourcePointer = resolve(project, '.sprindle', 'routes.ts')
    const previousPointer = existsSync(sourcePointer) ? readFileSync(sourcePointer, 'utf8') : undefined
    const previousRuntime = existsSync(target) ? readFileSync(target, 'utf8') : undefined
    const runtimeSource = bundle ? runtime : sourceRuntimePointer(target, resolve(generated.versionDirectory, 'routes.mjs'), hash)
    assertActive()
    await atomicWriteIfChanged(target, runtimeSource)
    try {
      await atomicWriteIfChanged(sourcePointer, generated.pointerSource(hash))
      assertActive()
    } catch (error) {
      if (previousRuntime === undefined) await rm(target, { force: true })
      else await atomicWriteIfChanged(target, previousRuntime)
      if (previousPointer === undefined) await rm(sourcePointer, { force: true })
      else await atomicWriteIfChanged(sourcePointer, previousPointer)
      throw error
    }
    published = true
    const obsoleteContracts = new Set([
      ...(target.endsWith('.mjs') ? [target.slice(0, -4) + '.d.ts', target.slice(0, -4) + '.declarations.json'] : []),
      resolve(project, '.sprindle', 'routes.d.ts'),
      resolve(project, '.sprindle', 'routes.declarations.json'),
    ])
    for (const file of obsoleteContracts) if (file !== target && file !== sourcePointer) await rm(file, { force: true })
  } finally {
    await rm(temporary, { force: true })
    if (!published) await generated.cleanup()
  }
  return target
}

function sourceRuntimePointer(output: string, runtime: string, hash: string) {
  let specifier = relative(dirname(output), runtime).replaceAll(sep, '/')
  if (!specifier.startsWith('../') && !specifier.startsWith('./')) specifier = `./${specifier}`
  return `export { default, manifest } from ${JSON.stringify(specifier)}\nexport const hash=${JSON.stringify(hash)}\n`
}

function replaceExportedHash(code: string, placeholder: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(placeholder) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Sprindle bundle finalization: hash values must be 64 hexadecimal characters')
  let program: ReturnType<typeof parseTypeScript>['program']
  try {
    program = parseTypeScript(code, { sourceType: 'module', plugins: ['typescript'] }).program
  } catch (error) {
    throw new Error(`Sprindle bundle finalization: unable to parse bundle output: ${error instanceof Error ? error.message : String(error)}`)
  }
  let localName: string | undefined
  let bindings = 0
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.source) continue
    if (statement.declaration?.type === 'VariableDeclaration') {
      for (const declarator of statement.declaration.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.id.name === 'hash') { bindings += 1; localName = 'hash' }
      }
    } else if (!statement.declaration) {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ExportSpecifier' || specifier.exported.type !== 'Identifier' || specifier.exported.name !== 'hash') continue
        if (specifier.local.type !== 'Identifier') throw new Error('Sprindle bundle finalization: unexpected hash export shape')
        bindings += 1
        localName = specifier.local.name
      }
    }
  }
  if (bindings !== 1 || !localName) throw new Error('Sprindle bundle finalization: expected exactly one exported hash binding')
  let start: number | undefined, end: number | undefined
  let declarators = 0
  for (const statement of program.body) {
    const declaration = statement.type === 'VariableDeclaration' ? statement : statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined
    if (!declaration || declaration.type !== 'VariableDeclaration') continue
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== 'Identifier' || declarator.id.name !== localName) continue
      if (declarator.init?.type !== 'StringLiteral' || declarator.init.value !== placeholder) continue
      if (typeof declarator.init.start !== 'number' || typeof declarator.init.end !== 'number') throw new Error('Sprindle bundle finalization: hash literal is missing source offsets')
      declarators += 1
      start = declarator.init.start
      end = declarator.init.end
    }
  }
  if (declarators !== 1 || start === undefined || end === undefined) throw new Error('Sprindle bundle finalization: expected one provisional hash literal')
  const replacement = JSON.stringify(hash)
  const current = code.slice(start, end)
  if (replacement.length !== current.length) throw new Error('Sprindle bundle finalization: replacement hash length mismatch')
  return code.slice(0, start) + replacement + code.slice(end)
}

function finalizeBundle(code: string, provisionalSource: string, placeholder: string, hash: string): string {
  const comment = /\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\r?\n?$/
  const match = comment.exec(code)
  if (!match?.[1] || match.index === undefined) throw new Error('Sprindle bundle finalization: inline source map is missing')
  const executable = code.slice(0, match.index)
  const suffix = code.slice(match.index)
  const payload = match[1]
  let map: { version?: unknown; mappings?: unknown; sources?: unknown; sourcesContent?: unknown }
  try {
    map = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as typeof map
  } catch (error) {
    throw new Error(`Sprindle bundle finalization: inline source map is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (map.version !== 3 || typeof map.mappings !== 'string' || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) throw new Error('Sprindle bundle finalization: inline source map has an unexpected shape')
  if (!map.sources.every((source): source is string => typeof source === 'string') || !map.sourcesContent.every((source): source is string => typeof source === 'string')) throw new Error('Sprindle bundle finalization: inline source map has an unexpected shape')
  if (map.sources.length !== map.sourcesContent.length) throw new Error('Sprindle bundle finalization: inline source map has an unexpected shape')
  const generated = map.sourcesContent.filter((source) => source === provisionalSource)
  if (generated.length !== 1) throw new Error('Sprindle bundle finalization: generated manifest source is missing from the source map')
  const patchedExecutable = replaceExportedHash(executable, placeholder, hash)
  const patchedGenerated = replaceExportedHash(generated[0]!, placeholder, hash)
  const next = { ...map, sourcesContent: map.sourcesContent.map((source) => source === provisionalSource ? patchedGenerated : source) }
  const nextPayload = Buffer.from(JSON.stringify(next)).toString('base64')
  return patchedExecutable + suffix.replace(payload, nextPayload)
}

function existingRealPath(file: string) {
  try { return realpathSync(file) } catch { return undefined }
}

function containedRelativePathOrUndefined(root: string, file: string) {
  const path = relative(root, resolve(file))
  return isAbsolute(path) || path.split(sep).includes('..') ? undefined : path
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function watchSupervisorPath() {
  const source = import.meta.url.endsWith('.ts')
  return { file: fileURLToPath(new URL(source ? './generation-supervisor.ts' : './generation-supervisor.js', import.meta.url)), source }
}

function runWatcherGeneration(request: GenerationRequest, timeoutMs: number, signal?: AbortSignal) {
  const project = resolve(request.projectRoot)
  const target = resolve(project, request.output)
  const supervisor = watchSupervisorPath()
  const child = fork(supervisor.file, [], {
    cwd: project,
    detached: process.platform !== 'win32',
    execArgv: supervisor.source ? ['--experimental-strip-types'] : [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let output = '', response: Extract<WorkerMessage, { type: 'result' }> | undefined, stopReason: Error | undefined, stopTask: Promise<void> | undefined, disconnectTimer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let resolveGeneration!: (result: GenerationResult) => void
  let rejectGeneration!: (error: Error) => void
  const promise = new Promise<GenerationResult>((resolvePromise, rejectPromise) => {
    resolveGeneration = resolvePromise
    rejectGeneration = rejectPromise
  })
  const timeoutError = () => {
    const error = new Error(`Route manifest generation timed out after ${timeoutMs} ms for ${target} in ${project}; its owned process tree was stopped.`) as GenerationFailure
    error.dependencyInputs = dependencyInputs.get(project)
    return error
  }
  const settle = (error?: Error, result?: GenerationResult) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (disconnectTimer) clearTimeout(disconnectTimer)
    signal?.removeEventListener('abort', abort)
    if (error) rejectGeneration(error)
    else resolveGeneration(result!)
  }
  const stop = (reason: Error) => {
    if (stopTask) return stopTask
    stopReason = reason
    stopTask = (async () => {
      try {
        await stopOwnedProcessTree(child, generationStopGraceMs, generationStopWaitMs)
        settle(reason)
      } catch (error) {
        const failure = new AggregateError([reason, error], `Route manifest generation could not stop its owned process tree for ${target} in ${project}.`) as GenerationFailure
        failure.dependencyInputs = dependencyInputs.get(project)
        failure.stopFailed = true
        settle(failure)
        throw failure
      }
    })()
    return stopTask
  }
  const abort = () => {
    const error = new Error(`Route manifest generation cancelled for ${target} in ${project}.`, { cause: signal?.reason })
    void stop(error).catch(() => {})
  }
  const timer = setTimeout(() => { void stop(timeoutError()).catch(() => {}) }, timeoutMs)
  child.stderr?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-65_536) })
  child.once('error', (error) => settle(new Error(`Route manifest generation could not start for ${target} in ${project}.`, { cause: error })))
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const value = message as Partial<WorkerMessage>
    if (value.type === 'dependencies' && isStringArray(value.dependencyInputs)) {
      dependencyInputs.set(project, value.dependencyInputs)
      return
    }
    if (value.type !== 'result' || !isStringArray(value.dependencyInputs)) return
    if (value.ok === true && typeof value.target === 'string') {
      dependencyInputs.set(project, value.dependencyInputs)
      response = value as Extract<WorkerMessage, { type: 'result' }>
      return
    }
    if (value.ok === false && value.error && typeof value.error === 'object' && typeof value.error.message === 'string') {
      dependencyInputs.set(project, value.dependencyInputs)
      response = value as Extract<WorkerMessage, { type: 'result' }>
      return
    }
    void stop(new Error(`Route manifest generation returned an invalid result for ${target} in ${project}.`)).catch(() => {})
  })
  child.once('disconnect', () => {
    disconnectTimer = setTimeout(() => {
      if (!response && !stopReason && !settled) void stop(new Error(`Route manifest generation disconnected before returning a result for ${target} in ${project}.`)).catch(() => {})
    }, 25)
  })
  child.once('close', (code, exitSignal) => {
    if (stopReason) return
    if (!response) {
      settle(new Error(`Route manifest generation exited without a result for ${target} in ${project} (${exitSignal ?? code ?? 'unknown'}).${output ? `\n${output}` : ''}`))
      return
    }
    if (response.ok) {
      settle(undefined, { target: response.target, dependencyInputs: response.dependencyInputs })
      return
    }
    const error = new Error(`Route manifest generation failed for ${target} in ${project}: ${response.error.message}`) as GenerationFailure
    error.dependencyInputs = response.dependencyInputs
    if (response.error.stack) error.stack = `${error.stack}\n${response.error.stack}`
    settle(error)
  })
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  else child.send(request, (error) => {
    if (error) void stop(new Error(`Route manifest generation could not send its request for ${target} in ${project}.`, { cause: error })).catch(() => {})
  })
  return { promise, stop, child }
}

function validatedGenerationTimeout(options: WatchRouteManifestOptions) {
  const timeout = options.generationTimeoutMs ?? defaultGenerationTimeoutMs
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) throw new RangeError('The route generation timeout must be an integer from 1 to 600000 milliseconds.')
  return timeout
}

export async function watchRouteManifest(projectRoot: string, routesDirectory = 'routes', onResult?: (error?: Error) => void, output = '.sprindle/routes.mjs', bundle = true, options: WatchRouteManifestOptions = {}) {
  const timeoutMs = validatedGenerationTimeout(options)
  const signal = options.signal
  const project = resolve(projectRoot), routesRoot = resolve(project, routesDirectory)
  const outputPath = resolve(project, output)
  const abortError = () => new Error(`Route manifest watcher startup cancelled for ${outputPath} in ${project}.`, { cause: signal?.reason })
  if (signal?.aborted) throw abortError()
  let queue = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined, closed = false
  let activeGeneration: ReturnType<typeof runWatcherGeneration> | undefined
  let terminalError: Error | undefined, terminalClose: Promise<void> | undefined
  let closePromise: Promise<void> | undefined
  let resolveClosed!: () => void
  const closedSignal = new Promise<void>((resolveClosedSignal) => { resolveClosed = resolveClosedSignal })
  const routePathIgnored = (root: string, file: string) => {
    const path = relative(root, file).replaceAll(sep, '/')
    if (!path || path === '.') return false
    if (isAbsolute(path) || path.split('/').includes('..')) return true
    return path.split('/').some((part) => part.startsWith('.sprindle') || ['.git', 'dist', 'dist-tooling', 'node_modules'].includes(part))
  }
  const routeIgnored = (file: string) => routePathIgnored(routesRoot, resolve(project, file))
  const routeRoots = [routesRoot]
  const realRoutesRoot = existingRealPath(routesRoot)
  if (realRoutesRoot && realRoutesRoot !== routesRoot) routeRoots.push(realRoutesRoot)
  const routePathMatches = (root: string, file: string) => {
    const path = relative(root, file)
    return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`) && !routePathIgnored(root, file)
  }
  const routeInputMatches = (file: string) => {
    const logical = resolve(project, file)
    const candidates = [logical]
    const real = existingRealPath(logical)
    if (real && real !== logical) candidates.push(real)
    return routeRoots.some((root) => candidates.some((candidate) => routePathMatches(root, candidate)))
  }
  const externalWatchFiles = new Map<string, Set<string>>()
  const externalWatchDirectories = (): string[] => [...externalWatchFiles.keys()]
  const refreshExternalInputs = () => {
    if (closed) return
    externalWatchFiles.clear()
    const track = (file: string) => {
      const directory = dirname(file)
      let files = externalWatchFiles.get(directory)
      if (!files) { files = new Set(); externalWatchFiles.set(directory, files) }
      files.add(basename(file))
    }
    for (const input of dependencyInputs.get(project) ?? []) {
      if (containedRelativePathOrUndefined(routesRoot, input) !== undefined) continue
      const real = existingRealPath(input) ?? input
      if (containedRelativePathOrUndefined(routesRoot, real) !== undefined) continue
      track(input)
      if (real !== input) track(real)
    }
  }
  const externalMatches = (eventPath: string) => {
    const file = resolve(project, eventPath)
    const directory = externalWatchFiles.get(dirname(file))
    if (directory?.has(basename(file))) return true
    try {
      const real = realpathSync(file)
      return externalWatchFiles.get(dirname(real))?.has(basename(real)) ?? false
    } catch { return false }
  }
  const hasInput = (file: string) => routeInputMatches(file) || externalMatches(file)
  let routeWatcher: FSWatcher | undefined, dependencyWatcher: FSWatcher | undefined
  const waitForReady = async (ready: Promise<void>) => {
    if (closed) throw abortError()
    await Promise.race([ready, closedSignal.then(() => { throw abortError() })])
  }
  const watchReady = (watcher: FSWatcher) => new Promise<void>((resolveReady, rejectReady) => {
    let ready = false
    const onReady = () => { ready = true; resolveReady() }
    const onError = (error: Error) => { if (!ready) rejectReady(error); else if (!closed) onResult?.(error) }
    watcher.on('ready', onReady)
    watcher.on('error', onError)
  })
  const startDependencyWatcher = (directories: string[]) => {
    const candidate = chokidar.watch(directories, { ignoreInitial: true, disableGlobbing: true, depth: 0, followSymlinks: false })
    let ready = false
    candidate.on('ready', () => { ready = true })
    candidate.on('all', (_event, eventPath) => { if (!ready || closed || !externalMatches(eventPath)) return; schedule() })
    const readyPromise = watchReady(candidate)
    return { candidate, ready: readyPromise }
  }
  const compile = () => {
    if (closed) return
    queue = queue.then(async () => {
      if (closed) return
      const generation = runWatcherGeneration({
        projectRoot: project,
        routesDirectory,
        output,
        bundle,
        dependencyInputs: dependencyInputs.get(project) ?? [],
      }, timeoutMs, signal)
      activeGeneration = generation
      let error: Error | undefined
      try {
        const result = await generation.promise
        dependencyInputs.set(project, result.dependencyInputs)
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught))
        const failure = error as GenerationFailure
        if (failure.dependencyInputs) dependencyInputs.set(project, failure.dependencyInputs)
        if (failure.stopFailed) {
          terminalError = error
          closed = true
          if (timer) { clearTimeout(timer); timer = undefined }
          signal?.removeEventListener('abort', onAbort)
          const route = routeWatcher, dependency = dependencyWatcher
          routeWatcher = undefined
          dependencyWatcher = undefined
          const closeTask = Promise.all([route?.close(), dependency?.close()].filter((close): close is Promise<void> => close !== undefined)).then(() => undefined)
          terminalClose = closeTask
          void closeTask.catch((closeError) => onResult?.(closeError instanceof Error ? closeError : new Error(String(closeError))))
        }
      } finally {
        if (activeGeneration === generation) activeGeneration = undefined
      }
      if (closed) {
        if ((error as GenerationFailure | undefined)?.stopFailed) onResult?.(error)
        return
      }
      refreshExternalInputs()
      if (routeWatcher) await replaceDependencyWatcher()
      if (!closed) onResult?.(error)
    })
  }
  const replaceDependencyWatcher = async () => {
    const wanted = externalWatchDirectories()
    const current = dependencyWatcher ? Object.keys(dependencyWatcher.getWatched()) : []
    if (wanted.length === 0) {
      const old = dependencyWatcher
      dependencyWatcher = undefined
      if (old) await old.close()
      return
    }
    if (current.length === wanted.length && current.every((directory) => externalWatchFiles.has(directory))) return
    const old = dependencyWatcher
    const { candidate, ready } = startDependencyWatcher(wanted)
    try { await waitForReady(ready) } catch {
      await candidate.close().catch(() => {})
      return
    }
    if (closed) { await candidate.close(); return }
    dependencyWatcher = candidate
    if (old) await old.close()
  }
  const schedule = () => { if (closed) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; compile() }, 100) }
  const close = () => {
    if (closePromise) return closePromise
    closed = true
    resolveClosed()
    if (timer) { clearTimeout(timer); timer = undefined }
    signal?.removeEventListener('abort', onAbort)
    const route = routeWatcher, dependency = dependencyWatcher
    const active = activeGeneration
    routeWatcher = undefined
    dependencyWatcher = undefined
    const cancellation = new Error(`Route manifest watcher closed for ${outputPath} in ${project}.`)
    const tasks = [active?.stop(cancellation), route?.close(), dependency?.close(), terminalClose, terminalError ? Promise.reject(terminalError) : undefined, queue].filter((task): task is Promise<void> => task !== undefined)
    closePromise = Promise.allSettled(tasks).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, `Route manifest watcher could not close cleanly for ${outputPath} in ${project}.`)
    })
    return closePromise
  }
  const onAbort = () => {
    void close().catch((error) => onResult?.(error instanceof Error ? error : new Error(String(error))))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    compile()
    await waitForReady(queue)
    if (closed) throw abortError()
    refreshExternalInputs()
    routeWatcher = chokidar.watch(routesRoot, { ignoreInitial: true, disableGlobbing: true, ignored: routeIgnored })
    const routeReady = watchReady(routeWatcher)
    let routeIsReady = false
    routeWatcher.on('ready', () => { routeIsReady = true })
    routeWatcher.on('all', () => { if (!routeIsReady || closed) return; schedule() })
    const initial = externalWatchDirectories()
    if (initial.length > 0) {
      const { candidate, ready } = startDependencyWatcher(initial)
      try {
        await waitForReady(Promise.all([routeReady, ready]).then(() => undefined))
        if (closed) { await candidate.close(); routeWatcher = undefined }
        else dependencyWatcher = candidate
      } catch (error) {
        await candidate.close().catch(() => {})
        const failed = routeWatcher
        routeWatcher = undefined
        if (failed) await failed.close().catch(() => {})
        throw error
      }
    } else await waitForReady(routeReady)
    if (closed) throw abortError()
  } catch (error) {
    await close()
    if (signal?.aborted) throw abortError()
    throw error
  }
  return { hasInput, close }
}
