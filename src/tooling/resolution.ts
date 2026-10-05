import { spawnSync } from 'node:child_process'
import { builtinModules, createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

export type RouteImportKind = 'static' | 'dynamic' | 'require' | 'type'

export type RouteImportRecord = {
  importer: string
  specifier: string
  position: number
  kind: RouteImportKind
  typeTargets: string[]
  consumerSource?: string
  consumerSpecifier?: string
  consumerPosition?: number
  generatedBinding?: boolean
  packageTarget?: boolean
  runtimeTarget?: string
  runtimeEvidence?: 'esbuild' | 'node'
}

export type RouteResolutionReceipt = {
  version: 2
  producerRoot: string
  producerConfig: string
  producerCompiler: string
  producerModuleResolution: string
  runtimeMode: 'bundle' | 'source'
  customConditions: string[]
  edges: RouteImportRecord[]
  sourceOrigins: { source: string; origin: string }[]
  inputs: { file: string; digest: string }[]
}

type PackageInfo = { root: string; file: string; value: Record<string, unknown> }
type RuntimeRequest = { id: number; importer: string; parentURL: string; specifier: string; kind: RouteImportKind }
export type RuntimeResolutionContext = { importer: string; specifier: string }

function physicalPath(file: string) {
  try { return realpathSync(file) } catch { return resolve(file) }
}

function isJavaScriptFile(file: string) {
  return ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(file))
}

function sourceFileTargets(declarations: { kind?: number; getSourceFile?: () => { fileName?: string } }[], sourceFileKind: number) {
  const direct = declarations.filter((declaration) => declaration.kind === sourceFileKind)
  return [...new Set((direct.length ? direct : declarations).flatMap((declaration) => {
    const file = declaration.getSourceFile?.().fileName
    return file ? [physicalPath(file)] : []
  }))].sort()
}

function moduleLiteralAt(sourceFile: { forEachChild(callback: (node: any) => void): void }, compiler: any, position: number): any {
  let found: any
  const visit = (node: any) => {
    if (node.kind === compiler.SyntaxKind.StringLiteral && node.getStart() === position) found = node
    if (!found) node.forEachChild(visit)
  }
  visit(sourceFile)
  return found
}

export async function openCompilerResolver(projectRoot: string, configFile: string, extraFiles: string[] = [], requireProjectCompiler = false) {
  const root = resolve(projectRoot)
  const config = resolve(configFile)
  const projectRequire = createRequire(resolve(root, 'package.json'))
  let compilerRequire = projectRequire
  let packagePath: string
  try { packagePath = compilerRequire.resolve('typescript/package.json') } catch (error) {
    if (requireProjectCompiler) throw new Error(`TypeScript is not installed for ${root}.`, { cause: error })
    compilerRequire = createRequire(import.meta.url)
    try { packagePath = compilerRequire.resolve('typescript/package.json') } catch (fallbackError) {
      throw new Error(`TypeScript is not installed for ${root} or the Sprindle tooling package.`, { cause: fallbackError })
    }
  }
  const version = (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version
  const major = Number(version.split('.')[0])
  let effectiveConfig = config
  let overlayDirectory: string | undefined
  if (extraFiles.length) {
    overlayDirectory = mkdtempSync(resolve(tmpdir(), 'sprindle-route-imports-'))
    effectiveConfig = resolve(overlayDirectory, 'tsconfig.json')
    writeFileSync(effectiveConfig, JSON.stringify({ extends: config, files: extraFiles.map((file) => resolve(file)) }))
  }
  if (major >= 7) {
    const { API } = await import(pathToFileURL(compilerRequire.resolve('typescript/unstable/sync')).href)
    const api = new API({ cwd: root })
    api.parseConfigFile(effectiveConfig)
    const snapshot = api.updateSnapshot({ openProjects: [effectiveConfig] })
    const project = snapshot.getProject(effectiveConfig)
    if (!project) {
      snapshot.dispose()
      api.close()
      if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true })
      throw new Error(`TypeScript ${version} did not open ${config}.`)
    }
    const parseDiagnostics = project.program.getConfigFileParsingDiagnostics()
    if (parseDiagnostics.length) {
      snapshot.dispose()
      api.close()
      if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true })
      throw new Error(`TypeScript ${version} could not parse ${config}: ${parseDiagnostics.map((item: { text: string }) => item.text).join(' ')}`)
    }
    let sourceFileNamesByPath: Map<string, string> | undefined
    const canonicalSourceFileName = (file: string) => {
      sourceFileNamesByPath ??= new Map(project.program.getSourceFileNames().map((name: string) => [physicalPath(name), name]))
      return sourceFileNamesByPath.get(file)
    }
    return {
      version,
      customConditions: [...(project.compilerOptions.customConditions ?? [])],
      moduleResolution: moduleResolutionName(project.compilerOptions.moduleResolution),
      select(file: string, position: number) {
        const resolvedFile = physicalPath(file)
        const sourceFile = project.program.getSourceFile(file) ?? project.program.getSourceFile(resolvedFile) ?? (() => {
          const sourceFileName = canonicalSourceFileName(resolvedFile)
          return sourceFileName ? project.program.getSourceFile(sourceFileName) : undefined
        })()
        if (!sourceFile && isJavaScriptFile(file)) return []
        if (!sourceFile) throw new Error(`TypeScript ${version} did not load import source ${file} from ${config}.`)
        const symbol = project.checker.getSymbolAtPosition(sourceFile.fileName, position + 1)
        if (!symbol) return []
        const declarations = symbol.declarations.map((declaration: { resolve(project: unknown): { getSourceFile(): { fileName: string } } | undefined }) => declaration.resolve(project)).filter(Boolean)
        return sourceFileTargets(declarations, sourceFile.kind)
      },
      close() { snapshot.dispose(); api.close(); if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true }) },
    }
  }
  if (major !== 6) {
    if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true })
    throw new Error(`Unsupported TypeScript version ${version} in ${root}.`)
  }
  const compiler = compilerRequire('typescript')
  const read = compiler.readConfigFile(effectiveConfig, compiler.sys.readFile)
  if (read.error) {
    if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true })
    throw new Error(`TypeScript ${version} could not read ${config}: ${compiler.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
  }
  const parsed = compiler.parseJsonConfigFileContent(read.config, compiler.sys, dirname(effectiveConfig), undefined, effectiveConfig)
  if (parsed.errors.length) {
    if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true })
    throw new Error(`TypeScript ${version} could not parse ${config}: ${parsed.errors.map((item: { messageText: unknown }) => compiler.flattenDiagnosticMessageText(item.messageText, '\n')).join(' ')}`)
  }
  const program = compiler.createProgram([...new Set([...parsed.fileNames, ...extraFiles])], parsed.options)
  const checker = program.getTypeChecker()
  return {
    version,
    customConditions: [...(parsed.options.customConditions ?? [])],
    moduleResolution: moduleResolutionName(parsed.options.moduleResolution),
    select(file: string, position: number) {
      const resolvedFile = physicalPath(file)
      const sourceFile = program.getSourceFile(resolvedFile) ?? program.getSourceFile(file) ?? program.getSourceFiles().find((source: { fileName: string }) => physicalPath(source.fileName) === resolvedFile)
      if (!sourceFile && isJavaScriptFile(file)) return []
      if (!sourceFile) throw new Error(`TypeScript ${version} did not load import source ${file} from ${config}.`)
      const literal = moduleLiteralAt(sourceFile, compiler, position)
      if (!literal) return []
      const symbol = checker.getSymbolAtLocation(literal)
      return sourceFileTargets(symbol?.declarations ?? [], sourceFile.kind)
    },
    close() { if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true }) },
  }
}

function moduleResolutionName(value: unknown) {
  if (value === 3) return 'node16'
  if (value === 99) return 'nodenext'
  if (value === 100) return 'bundler'
  if (value === 2) return 'node10'
  if (value === 1) return 'classic'
  return 'unknown'
}

export function isNodeBuiltin(specifier: string) {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  return builtinModules.includes(bare)
}

export function packageNameForSpecifier(specifier: string) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('#')) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function packageAt(file: string): PackageInfo | undefined {
  let directory = dirname(physicalPath(file))
  while (true) {
    const manifest = resolve(directory, 'package.json')
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
      if (typeof value.name === 'string') return { root: physicalPath(directory), file: physicalPath(manifest), value }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export function externalPackageTarget(specifier: string, target: string) {
  const expected = packageNameForSpecifier(specifier)
  const selected = packageAt(target)
  return Boolean(expected && selected && (selected.value.name === expected || selected.value.name === typesPackageName(expected)))
}

export function packageManifestForTarget(target: string) {
  return packageAt(target)?.file
}

function typesPackageName(name: string) {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`
}

function specifierSubpath(specifier: string, packageName: string) {
  const suffix = specifier.slice(packageName.length)
  return suffix ? `.${suffix.startsWith('/') ? suffix : `/${suffix}`}` : '.'
}

function exportEntry(exportsValue: unknown, subpath: string) {
  if (typeof exportsValue === 'string' || Array.isArray(exportsValue)) return subpath === '.' ? exportsValue : undefined
  if (!exportsValue || typeof exportsValue !== 'object') return undefined
  const record = exportsValue as Record<string, unknown>
  const keys = Object.keys(record)
  if (!keys.some((key) => key.startsWith('.'))) return subpath === '.' ? exportsValue : undefined
  if (Object.hasOwn(record, subpath)) return record[subpath]
  const patterns = keys.filter((key) => key.includes('*')).map((key) => {
    const [prefix, suffix] = key.split('*')
    if (!subpath.startsWith(prefix!) || !subpath.endsWith(suffix!) || subpath.length < prefix!.length + suffix!.length) return undefined
    return { key, value: record[key], capture: subpath.slice(prefix!.length, subpath.length - suffix!.length), specificity: prefix!.length + suffix!.length }
  }).filter((value): value is NonNullable<typeof value> => value !== undefined).sort((left, right) => right.specificity - left.specificity)
  const match = patterns[0]
  if (!match) return undefined
  return replaceExportPattern(match.value, match.capture)
}

function replaceExportPattern(value: unknown, capture: string): unknown {
  if (typeof value === 'string') return value.replaceAll('*', capture)
  if (Array.isArray(value)) return value.map((item) => replaceExportPattern(item, capture))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceExportPattern(item, capture)]))
  return value
}

type PackageTargetSelection = { target: string; branch: string[] }

function packageTargetFiles(packageInfo: PackageInfo, value: string, targetKind: 'runtime' | 'types') {
  const direct = resolve(packageInfo.root, value)
  const packagePath = relative(packageInfo.root, direct)
  if (packagePath.startsWith('..') || isAbsolute(packagePath)) return []
  if (targetKind === 'runtime') return existsSync(direct) ? [physicalPath(direct)] : []
  const substitutions: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.d.ts', '.js'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.d.mts', '.mjs'],
    '.cjs': ['.cts', '.d.cts', '.cjs'],
  }
  const extension = Object.keys(substitutions).find((item) => direct.endsWith(item))
  const candidates = extension
    ? substitutions[extension]!.map((replacement) => `${direct.slice(0, -extension.length)}${replacement}`)
    : [direct, `${direct}.ts`, `${direct}.tsx`, `${direct}.d.ts`, resolve(direct, 'index.d.ts')]
  return [...new Set(candidates.filter(existsSync).map(physicalPath))]
}

function exportTargetSelections(value: unknown, packageInfo: PackageInfo, targetKind: 'runtime' | 'types', conditions: Set<string>, branch: string[] = []): PackageTargetSelection[] {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) return []
    return packageTargetFiles(packageInfo, value, targetKind).map((target) => ({ target, branch }))
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const selected = exportTargetSelections(item, packageInfo, targetKind, conditions, branch)
      if (selected.length) return selected
    }
    return []
  }
  if (!value || typeof value !== 'object') return []
  for (const [condition, child] of Object.entries(value)) {
    if (condition.startsWith('.') || condition.startsWith('#') || (condition !== 'default' && !conditions.has(condition))) continue
    const selected = exportTargetSelections(child, packageInfo, targetKind, conditions, [...branch, condition])
    if (selected.length) return selected
  }
  return []
}

function packageConditions(targetKind: 'runtime' | 'types', kind: RouteImportKind, customConditions: string[], moduleResolution: string) {
  const mode = kind === 'require' ? 'require' : 'import'
  if (targetKind === 'runtime') return new Set(['node', 'node-addons', 'module-sync', mode, 'default'])
  return new Set(['types', mode, ...(moduleResolution === 'node16' || moduleResolution === 'nodenext' ? ['node'] : []), ...customConditions, 'default'])
}

function packageExportSelections(packageInfo: PackageInfo, specifier: string, targetKind: 'runtime' | 'types', kind: RouteImportKind, customConditions: string[], moduleResolution: string): PackageTargetSelection[] | undefined {
  const name = packageInfo.value.name as string
  const subpath = specifierSubpath(specifier, name)
  const exportsValue = exportEntry(packageInfo.value.exports, subpath)
  if (packageInfo.value.exports !== undefined) {
    if (exportsValue === undefined) return []
    return exportTargetSelections(exportsValue, packageInfo, targetKind, packageConditions(targetKind, kind, customConditions, moduleResolution))
  }
  const entry = subpath === '.'
    ? targetKind === 'runtime' ? packageInfo.value.main ?? 'index.js' : packageInfo.value.types ?? packageInfo.value.typings ?? packageInfo.value.main ?? 'index.js'
    : subpath.slice(2)
  if (typeof entry !== 'string') return []
  const candidates = targetKind === 'runtime' && !extname(resolve(packageInfo.root, entry)) && kind === 'require'
    ? [entry, `${entry}.js`, `${entry}.json`, `${entry}.node`, `${entry}/index.js`]
    : targetKind === 'types' && subpath !== '.' && !extname(resolve(packageInfo.root, entry))
      ? [`${entry}.ts`, `${entry}.tsx`, `${entry}.d.ts`, `${entry}/index.d.ts`, entry]
      : [entry]
  const branch = targetKind === 'runtime' ? ['main'] : typeof (packageInfo.value.types ?? packageInfo.value.typings) === 'string' && subpath === '.' ? ['types'] : ['main']
  return candidates.flatMap((candidate) => packageTargetFiles(packageInfo, candidate, targetKind).map((target) => ({ target, branch })))
}

function selectedPackageTarget(packageInfo: PackageInfo, target: string, specifier: string, targetKind: 'runtime' | 'types', kind: RouteImportKind, customConditions: string[], moduleResolution: string) {
  const canonical = physicalPath(target)
  return packageExportSelections(packageInfo, specifier, targetKind, kind, customConditions, moduleResolution)?.filter((selection) => selection.target === canonical) ?? []
}

function typesPackageTarget(packageInfo: PackageInfo, target: string, specifier: string) {
  const expected = packageNameForSpecifier(specifier)
  if (!expected || packageInfo.value.name !== typesPackageName(expected) || packageAt(target)?.root !== packageInfo.root) return false
  const subpath = specifier.slice(expected.length).replace(/^\//, '')
  const path = relative(packageInfo.root, physicalPath(target)).replaceAll(sep, '/')
  if (!subpath) return /^(?:index|types\/index)\.d\.(?:ts|mts|cts)$/.test(path)
  return path === `${subpath}.d.ts` || path === `${subpath}/index.d.ts`
}

function declarationBranch(branch: string[]) {
  if (branch[0] === 'types') return branch.slice(1)
  return branch.at(-1) === 'types' ? branch.slice(0, -1) : branch
}

function branchMatches(runtime: string[], types: string[]) {
  const declared = declarationBranch(types)
  return declared.length <= runtime.length && declared.every((condition, index) => runtime[index] === condition)
}

function packageSelectionIsRelated(edge: RouteImportRecord, customConditions: string[], moduleResolution = 'unknown') {
  if (!edge.packageTarget) return undefined
  const expectedName = packageNameForSpecifier(edge.specifier)
  if (!expectedName) return undefined
  const runtime = edge.runtimeTarget && !edge.runtimeTarget.startsWith('node:') ? packageAt(edge.runtimeTarget) : undefined
  const typePackages = edge.typeTargets.map((target) => packageAt(target))
  const actualTypePackages = typePackages.filter((value): value is PackageInfo => value !== undefined)
  const relatedTypePackage = actualTypePackages.find((info) => info.value.name === expectedName || info.value.name === typesPackageName(expectedName))
  if (!runtime && !relatedTypePackage) return undefined
  if (!runtime && relatedTypePackage?.value.name === expectedName) {
    const typeSelections = edge.typeTargets.flatMap((target) => selectedPackageTarget(relatedTypePackage, target, edge.specifier, 'types', edge.kind, customConditions, moduleResolution))
    if (!edge.typeTargets.length) return { valid: false, runtime, type: relatedTypePackage }
    if (typeSelections.length === edge.typeTargets.length) {
      const branches = [...new Set(typeSelections.map((selection) => JSON.stringify(selection.branch)))].map((value) => JSON.parse(value) as string[])
      if (branches.length === 1) return { valid: true, runtime, type: relatedTypePackage, typeBranch: branches[0] }
      return { valid: false, runtime, type: relatedTypePackage }
    }
    const sourceSelections = edge.typeTargets.flatMap((target) => {
      if (/\.d\.(?:ts|mts|cts)$/.test(target)) return []
      return selectedPackageTarget(relatedTypePackage, target, edge.specifier, 'runtime', edge.kind, [], moduleResolution)
    })
    if (sourceSelections.length !== edge.typeTargets.length) return { valid: false, runtime, type: relatedTypePackage }
    const sourceBranches = [...new Set(sourceSelections.map((selection) => JSON.stringify(selection.branch)))].map((value) => JSON.parse(value) as string[])
    return sourceBranches.length === 1
      ? { valid: true, runtime, type: relatedTypePackage, sourceBranch: sourceBranches[0] }
      : { valid: false, runtime, type: relatedTypePackage }
  }
  if (!runtime && relatedTypePackage?.value.name === typesPackageName(expectedName)) {
    if (!edge.typeTargets.length || !edge.typeTargets.every((target) => typesPackageTarget(relatedTypePackage, target, edge.specifier))) return { valid: false, runtime, type: relatedTypePackage }
    return { valid: true, runtime, type: relatedTypePackage, typeBranch: ['@types'] }
  }
  if (runtime && runtime.value.name !== expectedName) return { valid: false, runtime, type: relatedTypePackage }
  const runtimeSelections = runtime && edge.runtimeTarget
    ? selectedPackageTarget(runtime, edge.runtimeTarget, edge.specifier, 'runtime', edge.kind, [], moduleResolution)
    : []
  if (runtime && edge.runtimeTarget && !runtimeSelections.length) return { valid: false, runtime, type: relatedTypePackage }
  if (edge.typeTargets.length && !relatedTypePackage) return { valid: false, runtime, type: undefined }
  if (runtime && relatedTypePackage && relatedTypePackage.value.name === expectedName) {
    if (runtime.root !== relatedTypePackage.root) return { valid: false, runtime, type: relatedTypePackage }
    const typeSelections = edge.typeTargets.flatMap((target) => selectedPackageTarget(relatedTypePackage, target, edge.specifier, 'types', edge.kind, customConditions, moduleResolution))
    if (typeSelections.length !== edge.typeTargets.length) return { valid: false, runtime, type: relatedTypePackage }
    const branches = [...new Set(typeSelections.map((selection) => JSON.stringify(selection.branch)))].map((value) => JSON.parse(value) as string[])
    if (branches.length !== 1) return { valid: false, runtime, type: relatedTypePackage }
    if (runtimeSelections.length && !runtimeSelections.some((runtimeSelection) => branchMatches(runtimeSelection.branch, branches[0]!))) return { valid: false, runtime, type: relatedTypePackage }
    return { valid: true, runtime, type: relatedTypePackage, typeBranch: branches[0] }
  } else if (relatedTypePackage && relatedTypePackage.value.name === typesPackageName(expectedName)) {
    if (!edge.typeTargets.every((target) => typesPackageTarget(relatedTypePackage, target, edge.specifier))) return { valid: false, runtime, type: relatedTypePackage }
  }
  if (!runtime && edge.typeTargets.length && !relatedTypePackage) return { valid: false, runtime, type: undefined }
  return { valid: true, runtime, type: relatedTypePackage, typeBranch: relatedTypePackage?.value.name === typesPackageName(expectedName) ? ['@types'] : undefined }
}

export function routeImportPackageSelectionIsValid(edge: RouteImportRecord, customConditions: string[], moduleResolution = 'unknown') {
  return packageSelectionIsRelated(edge, customConditions, moduleResolution)?.valid === true
}

export async function resolveRuntimeEdges(projectRoot: string, edges: RouteImportRecord[], runtimeMode: 'bundle' | 'source', contexts: Map<RouteImportRecord, RuntimeResolutionContext> = new Map()) {
  const requests: RuntimeRequest[] = edges.map((edge, id) => {
    const context = contexts.get(edge)
    const importer = physicalPath(context?.importer ?? edge.importer)
    return { id, importer, parentURL: pathToFileURL(importer).href, specifier: context?.specifier ?? edge.specifier, kind: edge.kind }
  })
  if (!requests.length) return new Map<number, string>()
  const source = `import { registerHooks, createRequire } from 'node:module';import { fileURLToPath, pathToFileURL } from 'node:url';import { readFileSync } from 'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));const result=[];registerHooks({resolve(specifier,context,nextResolve){if(!specifier.startsWith('sprindle-resolution:'))return nextResolve(specifier,context);const id=Number(specifier.slice('sprindle-resolution:'.length));const item=input[id];try{let target;if(item.kind==='require'){target=createRequire(fileURLToPath(item.parentURL)).resolve(item.specifier);if(target.startsWith('node:')){}else if(!target.startsWith('file:'))target=pathToFileURL(target).href}else{target=nextResolve(item.specifier,{...context,parentURL:item.parentURL}).url}result[id]={target:target.startsWith('file:')?fileURLToPath(target):target}}catch(error){result[id]={error:error.code??error.message}}return{url:'file:///sprindle-resolution-probe',shortCircuit:true}}});for(const item of input)await import.meta.resolve('sprindle-resolution:'+item.id);process.stdout.write(JSON.stringify(result))`
  const args = runtimeMode === 'source' ? ['--import', 'tsx', '--input-type=module', '-e', source] : ['--input-type=module', '-e', source]
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: 'utf8', input: JSON.stringify(requests), maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Node runtime resolution failed in ${projectRoot}: ${result.stderr || result.error?.message || result.status}`)
  let values: { target?: string; error?: string }[]
  try { values = JSON.parse(result.stdout) as typeof values } catch { throw new Error(`Node runtime resolution returned invalid output in ${projectRoot}: ${result.stdout}\n${result.stderr}`) }
  const selected = new Map<number, string>()
  const failures = requests.flatMap((request) => {
    const value = values[request.id]
    if (value?.target) {
      const target = value.target.startsWith('node:') ? value.target : isNodeBuiltin(value.target) ? `node:${value.target}` : physicalPath(value.target)
      selected.set(request.id, target)
      return []
    }
    return [`${request.importer}: unable to resolve ${request.kind} import ${request.specifier} with Node${runtimeMode === 'source' ? ' and tsx' : ''}${value?.error ? ` (${value.error})` : ''}`]
  })
  if (failures.length) throw new Error(failures.join('\n'))
  return selected
}

export function createRouteResolutionReceipt(args: Omit<RouteResolutionReceipt, 'inputs' | 'version'> & { inputContents: Map<string, string> }): RouteResolutionReceipt {
  const inputs = [...args.inputContents].map(([file, contents]) => ({ file: physicalPath(file), digest: createHash('sha256').update(contents).digest('hex') })).sort((left, right) => left.file.localeCompare(right.file))
  return { producerRoot: args.producerRoot, producerConfig: args.producerConfig, producerCompiler: args.producerCompiler, producerModuleResolution: args.producerModuleResolution, runtimeMode: args.runtimeMode, customConditions: args.customConditions, edges: args.edges, sourceOrigins: args.sourceOrigins, version: 2, inputs }
}

function receiptPath(producerRoot: string, contractFile: string) {
  const source = readFileSync(contractFile, 'utf8')
  const version = /\.\/source\/([a-f0-9]{64})\/routes/.exec(source)?.[1]
  if (!version) throw new Error(`Sprindle route source does not name an immutable version: ${contractFile}`)
  const sourceDirectory = resolve(producerRoot, '.sprindle', 'source', version)
  return { sourceDirectory, file: resolve(sourceDirectory, 'resolution.json') }
}

function canonicalTargets(values: string[]) {
  return [...new Set(values.map(physicalPath))].sort()
}

function mismatchMessage(edge: RouteImportRecord, apiTarget: string, consumerTarget: string, configFile: string) {
  return `Route import agreement failed:\n  importer: ${edge.importer}\n  import: ${edge.specifier}\n  API target: ${apiTarget}\n  consumer target: ${consumerTarget}\n  consumer config: ${configFile}`
}

export async function verifyRouteImportAgreement(args: { producerRoot: string; consumerRoot: string; consumerConfig: string; contractFile?: string }) {
  const producerRoot = resolve(args.producerRoot)
  const consumerRoot = resolve(args.consumerRoot)
  const config = resolve(args.consumerConfig)
  const contractFile = resolve(args.contractFile ?? resolve(producerRoot, '.sprindle/routes.ts'))
  const receiptLocation = receiptPath(producerRoot, contractFile)
  const receiptFile = receiptLocation.file
  if (!existsSync(receiptFile)) throw new Error(`Route import agreement record is missing: ${receiptFile}. Run the API route producer.`)
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as RouteResolutionReceipt
  if (receipt.version !== 2 || !Array.isArray(receipt.edges) || !Array.isArray(receipt.sourceOrigins) || !Array.isArray(receipt.inputs)) throw new Error(`Route import agreement record is invalid: ${receiptFile}`)
  const changed = receipt.inputs.flatMap(({ file, digest }) => {
    try { return createHash('sha256').update(readFileSync(file)).digest('hex') === digest ? [] : [file] } catch { return [file] }
  })
  if (changed.length) throw new Error(`Route import agreement record is stale. Run the API route producer. Changed inputs:\n${changed.map((file) => `  ${file}`).join('\n')}`)
  const contractSources = receipt.edges.map((edge) => edge.consumerSource ? resolve(receiptLocation.sourceDirectory, edge.consumerSource) : edge.importer)
  const compiler = await openCompilerResolver(consumerRoot, config, [...new Set([contractFile, ...contractSources])], true)
  const sourceOrigins = new Map(receipt.sourceOrigins.map(({ source, origin }) => [physicalPath(resolve(receiptLocation.sourceDirectory, source)), physicalPath(origin)]))
  try {
    for (const edge of receipt.edges) {
      const consumerImporter = edge.consumerSource ? resolve(receiptLocation.sourceDirectory, edge.consumerSource) : edge.importer
      const consumerSpecifier = edge.consumerSpecifier ?? edge.specifier
      const consumerPosition = edge.consumerPosition ?? edge.position
      const targets = compiler.select(consumerImporter, consumerPosition)
      const consumerTargets = canonicalTargets(targets)
      const comparableTargets = canonicalTargets(targets.map((target) => sourceOrigins.get(physicalPath(target)) ?? target))
      if (edge.generatedBinding) {
        if (consumerTargets.length !== 1 || !consumerTargets[0]!.startsWith(`${physicalPath(receiptLocation.sourceDirectory)}${sep}`)) {
          throw new Error(mismatchMessage(edge, edge.runtimeTarget ?? (edge.typeTargets.join(', ') || 'unresolved'), consumerTargets.join(', ') || 'unresolved', config))
        }
        continue
      }
      const packageSelection = packageSelectionIsRelated(edge, receipt.customConditions, receipt.producerModuleResolution)
      if (packageSelection) {
        const consumerPackageSelection = packageSelectionIsRelated({ ...edge, specifier: consumerSpecifier, typeTargets: consumerTargets }, compiler.customConditions, compiler.moduleResolution)
        const consumerUsesApiRuntime = edge.runtimeTarget !== undefined
          && consumerTargets.length === 1
          && canonicalTargets(consumerTargets)[0] === canonicalTargets([edge.runtimeTarget])[0]
          && packageAt(consumerTargets[0]!)?.value.name === packageNameForSpecifier(consumerSpecifier)
        const sameTypeBranch = packageSelection.typeBranch !== undefined
          && consumerPackageSelection?.typeBranch !== undefined
          && JSON.stringify(packageSelection.typeBranch) === JSON.stringify(consumerPackageSelection?.typeBranch)
        const sameSourceBranch = packageSelection.sourceBranch !== undefined
          && JSON.stringify(packageSelection.sourceBranch) === JSON.stringify(consumerPackageSelection?.sourceBranch)
        const sourceBranchMatchesTypeBranch = Boolean(
          (packageSelection.typeBranch && consumerPackageSelection?.sourceBranch && branchMatches(consumerPackageSelection.sourceBranch, packageSelection.typeBranch))
          || (packageSelection.sourceBranch && consumerPackageSelection?.typeBranch && branchMatches(packageSelection.sourceBranch, consumerPackageSelection.typeBranch)),
        )
        const packageBranchesMatch = sameTypeBranch || sameSourceBranch || sourceBranchMatchesTypeBranch
        if (!packageSelection.valid || (!consumerUsesApiRuntime && (!consumerPackageSelection?.valid || packageSelection.type?.root !== consumerPackageSelection.type?.root || !packageBranchesMatch))) {
          const apiTarget = (edge.runtimeTarget ?? edge.typeTargets.join(', ')) || 'unresolved'
          throw new Error(mismatchMessage(edge, apiTarget, consumerTargets.join(', ') || 'unresolved', config))
        }
        continue
      }
      if (isNodeBuiltin(consumerSpecifier)) {
        if (edge.kind === 'type' && JSON.stringify(canonicalTargets(edge.typeTargets)) !== JSON.stringify(consumerTargets)) throw new Error(mismatchMessage(edge, edge.typeTargets.join(', ') || 'unresolved', consumerTargets.join(', ') || 'unresolved', config))
        if (edge.kind !== 'type' && targets.length && JSON.stringify(canonicalTargets(edge.typeTargets)) !== JSON.stringify(consumerTargets)) throw new Error(mismatchMessage(edge, edge.runtimeTarget ?? 'unresolved', consumerTargets.join(', ') || 'unresolved', config))
        continue
      }
      if (edge.kind === 'require' && consumerTargets.length === 0) continue
      if (edge.kind !== 'type' && edge.typeTargets.length === 0 && consumerTargets.length === 0) continue
      const expected = edge.kind === 'type' ? canonicalTargets(edge.typeTargets) : edge.runtimeTarget ? canonicalTargets([edge.runtimeTarget]) : []
      if (JSON.stringify(expected) !== JSON.stringify(comparableTargets)) throw new Error(mismatchMessage(edge, expected.join(', ') || 'unresolved', consumerTargets.join(', ') || 'unresolved', config))
    }
  } finally { compiler.close() }
}
