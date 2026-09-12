import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
    const declaration = target.replace(/\.mjs$/, '.d.ts')
    const metadata = declaration.replace(/\.d\.ts$/, '.declarations.json')
    const publishDeclaration = emitDeclarations ? await emitRouteDeclarations(projectRoot, routesDirectory, model.routes, declaration, bundle) : undefined
    await rename(temporary, target)
    if (publishDeclaration) await publishDeclaration()
    else { await rm(declaration, { force: true }); await rm(metadata, { force: true }) }
  } finally {
    await rm(temporary, { force: true })
  }
  return target
}

async function emitRouteDeclarations(projectRoot: string, routesDirectory: string, routes: Awaited<ReturnType<typeof readRouteDirectory>>['routes'], declaration: string, bundle: boolean) {
  const frameworkRoot = [resolve(import.meta.dirname, '../..'), resolve(import.meta.dirname, '..')].find((directory) => existsSync(resolve(directory, 'package.json')))
  if (!frameworkRoot) throw new Error('Sprindle package root is missing.')
  const definitionSource = resolve(frameworkRoot, 'src/routes/definition.ts')
  const publicTypes = resolve(frameworkRoot, 'dist-types/index.d.ts')
  const virtualDefinition = resolve(projectRoot, '.__sprindle_route_definition.ts')
  const overlay = routeLanguageOverlayForDeclarations(projectRoot, routesDirectory, virtualDefinition, definitionSource)
  const commonSourceRoot = commonPath(projectRoot, [...overlay.keys()])
  const mappedPath = (file: string) => containedRelativePath(commonSourceRoot, file)
  const compiler = resolveTypeScriptCompiler(frameworkRoot)
  const projectConfig = resolve(projectRoot, 'tsconfig.json')
  const shown = spawnSync(process.execPath, [compiler, '--showConfig', '-p', projectConfig], { cwd: projectRoot, encoding: 'utf8' })
  if (shown.error || shown.status !== 0) throw new Error(`TypeScript config failed: ${shown.error?.message ?? shown.stdout + shown.stderr}`)
  const effective = JSON.parse(shown.stdout) as { compilerOptions?: Record<string, unknown> }
  const ambientSources = [...overlay].filter(([file, source]) => file.endsWith('.ts') && !file.endsWith('.d.ts') && contributesGlobals(source)).map(([file]) => file)
  const sourceRoots = [...new Set([...routes.flatMap((route) => [route.sourcePath, ...route.scopes]), ...ambientSources, virtualDefinition])]
  const probeRoots = [...new Set([...sourceRoots.filter((file) => file !== virtualDefinition), ...[...overlay.keys()].filter((file) => file.endsWith('.d.ts') && !/\.[rs]\.d\.ts$/.test(file) && existsSync(file)), definitionSource, publicTypes])]
  const metadata = declaration.replace(/\.d\.ts$/, '.declarations.json')
  const declarationInput = declarationInputKey(projectRoot, routesDirectory, declaration, bundle, routes, overlay, effective, compiler, projectConfig, probeRoots)
  const inputKey = declarationInput?.key
  if (inputKey && validDeclarationMetadata(metadata, declaration, inputKey)) return async () => {}
  const input = mkdtempSync(resolve(tmpdir(), `sprindle-contract-input-${process.pid}-`))
  const stagedProject = resolve(input, mappedPath(projectRoot))
  const temporary = resolve(projectRoot, `.sprindle-contract-${process.pid}-${randomUUID()}`)
  let declarationTemporary: string | undefined
  let metadataTemporary: string | undefined
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
    const rootFiles = sourceRoots.map((file) => resolve(input, mappedPath(file)))
    mkdirSync(stagedProject, { recursive: true })
    const stagedConfig = resolve(stagedProject, 'tsconfig.json')
    writeFileSync(stagedConfig, JSON.stringify({ compilerOptions: options, files: rootFiles }))
    const emitted = spawnSync(process.execPath, [compiler, '-p', stagedConfig, '--pretty', 'false', '--listFiles'], { cwd: projectRoot, encoding: 'utf8' })
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
    const contentVersion = createHash('sha256').update(JSON.stringify(emittedContents)).digest('hex').slice(0, 24)
    let version = contentVersion
    let contractDirectory = resolve(dirname(declaration), 'contracts', version)
    if (lstatSync(contractDirectory, { throwIfNoEntry: false }) && !validContractDirectory(contractDirectory, dirname(declaration), emittedContents)) {
      version = `${contentVersion}-${randomUUID().slice(0, 8)}`
      contractDirectory = resolve(dirname(declaration), 'contracts', version)
    }
    const contract = routes.flatMap((route) => route.methods.map((method) => {
      const modulePath = `./contracts/${version}/` + mappedPath(route.sourcePath).replaceAll('\\', '/').replace(/\.ts$/, '')
      return `{ path: ${JSON.stringify(route.httpPath)}; method: ${JSON.stringify(method.toLowerCase())}; definition: typeof import(${JSON.stringify(modulePath)})[${JSON.stringify(method)}] }`
    })).join(' | ') || 'never'
    await mkdir(dirname(contractDirectory), { recursive: true })
    try { await rename(temporary, contractDirectory) } catch (error) {
      if (!existsSync(contractDirectory)) throw error
      await rm(temporary, { recursive: true, force: true })
    }
    declarationTemporary = `${declaration}.${process.pid}.${randomUUID()}.tmp`
    const declarationSource = `export type RouteContract = ${contract}\n`
    await writeFile(declarationTemporary, declarationSource)
    let finalInput: ReturnType<typeof declarationInputKey>, emittedExternal: string[] | undefined
    try {
      finalInput = declarationInput && declarationInputKey(projectRoot, routesDirectory, declaration, bundle, routes, routeLanguageOverlayForDeclarations(projectRoot, routesDirectory, virtualDefinition, definitionSource), effective, compiler, projectConfig, probeRoots, declarationInput.files)
      const inputRoot = realpathSync(input)
      emittedExternal = compilerFiles(emitted.stdout).map((file) => realpathSync(file)).filter((file) => containedRelativePathOrUndefined(inputRoot, file) === undefined)
    } catch { /* a cache proof failure does not invalidate successful output */ }
    if (inputKey && finalInput?.key === inputKey && emittedExternal?.every((file) => finalInput.realFiles.has(file))) {
      const files = emittedContents.map(([file, source]) => [`contracts/${version}/${file}`, contentHash(source)])
      metadataTemporary = `${metadata}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(metadataTemporary, JSON.stringify({ version: 1, input: inputKey, declaration: contentHash(declarationSource), contract: version, files }))
    }
    const prepared = declarationTemporary
    const preparedMetadata = metadataTemporary
    declarationTemporary = undefined
    metadataTemporary = undefined
    return async () => {
      try {
        await rename(prepared, declaration)
        if (preparedMetadata) await rename(preparedMetadata, metadata)
        else await rm(metadata, { force: true })
      } finally { await rm(prepared, { force: true }); if (preparedMetadata) await rm(preparedMetadata, { force: true }) }
    }
  } finally {
    await rm(input, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
    if (declarationTemporary) await rm(declarationTemporary, { force: true })
    if (metadataTemporary) await rm(metadataTemporary, { force: true })
  }
}

function routeLanguageOverlayForDeclarations(projectRoot: string, routesDirectory: string, virtualDefinition: string, definitionSource: string) {
  const overlay = routeLanguageOverlay(projectRoot, routesDirectory, new Map(), virtualDefinition)
  overlay.set(virtualDefinition, readFileSync(definitionSource, 'utf8'))
  for (const [file, source] of overlay) if (/\.[rs]\.d\.ts$/.test(file)) overlay.set(file, source.replace(/^export \* from .*$/m, `export * from '@southneuhof/sprindle'`))
  return overlay
}

function declarationInputKey(
  projectRoot: string,
  routesDirectory: string,
  declaration: string,
  bundle: boolean,
  routes: Awaited<ReturnType<typeof readRouteDirectory>>['routes'],
  overlay: Map<string, string>,
  effective: object,
  compiler: string,
  projectConfig: string,
  roots: string[],
  resolvedFiles?: string[],
) {
  try {
    const configs = localConfigInputs(projectConfig)
    const files = configs && (resolvedFiles ?? probeCompilerFiles(compiler, projectRoot, projectConfig, roots))
    if (!configs || !files?.length) return
    const compilerPackage = resolve(dirname(compiler), '../package.json')
    const compilerLoader = resolve(dirname(compiler), '../lib/tsc.js')
    const compilerResolver = resolve(dirname(compiler), '../lib/getExePath.js')
    const platformPackage = createRequire(compilerPackage).resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`)
    const executable = resolve(dirname(platformPackage), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
    const direct = [...files, compiler, compilerLoader, compilerResolver, compilerPackage, platformPackage, executable, fileURLToPath(import.meta.url), ...configs]
    const related = relatedInputFiles(direct, projectRoot)
    const contents = [...new Set([...direct, ...related])].sort().map((file) => [file, realpathSync(file), contentHash(readFileSync(file))])
    const local = [...overlay].sort(([left], [right]) => left.localeCompare(right))
    const routeInput = routes.map(({ sourcePath, scopes, httpPath, methods, parameters }) => ({ sourcePath, scopes, httpPath, methods, parameters }))
    const identity = { project: resolve(projectRoot), routes: resolve(projectRoot, routesDirectory), declaration: resolve(declaration), bundle, declarations: true }
    return { key: contentHash(JSON.stringify([identity, routeInput, roots, local, effective, contents])), files, realFiles: new Set(files.map((file) => realpathSync(file))) }
  } catch { return }
}

function probeCompilerFiles(compiler: string, projectRoot: string, projectConfig: string, roots: string[]) {
  const directory = resolve(projectRoot, '.sprindle')
  mkdirSync(directory, { recursive: true })
  const config = resolve(directory, `probe-${process.pid}-${randomUUID()}.json`)
  try {
    writeFileSync(config, JSON.stringify({ extends: projectConfig, compilerOptions: { allowImportingTsExtensions: false, skipLibCheck: true }, files: roots, include: [], exclude: [] }))
    const result = spawnSync(process.execPath, [compiler, '-p', config, '--pretty', 'false', '--listFilesOnly'], { cwd: projectRoot, encoding: 'utf8' })
    return result.error || result.status !== 0 ? undefined : compilerFiles(result.stdout)
  } finally { rmSync(config, { force: true }) }
}

function compilerFiles(output: string) {
  return output.split(/\r?\n/).map((file) => file.trim()).filter((file) => isAbsolute(file) && existsSync(file))
}

function localConfigInputs(configFile: string, seen = new Set<string>()): string[] | undefined {
  const file = resolve(configFile)
  if (seen.has(file)) return []
  seen.add(file)
  const value = parse(readFileSync(file, 'utf8')) as { extends?: string | string[] } | undefined
  const extended = typeof value?.extends === 'string' ? [value.extends] : value?.extends ?? []
  if (extended.some((entry) => !entry.startsWith('.') && !isAbsolute(entry))) return
  const parents = extended.map((entry) => { const target = resolve(dirname(file), entry); return extname(target) ? target : `${target}.json` })
  const inherited = parents.map((parent) => localConfigInputs(parent, seen))
  return inherited.some((files) => !files) ? undefined : [file, ...inherited.flatMap((files) => files!)]
}

function relatedInputFiles(files: string[], projectRoot: string) {
  const found = new Set<string>()
  const visited = new Set<string>()
  const names = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
  for (const source of files) {
    let directory = dirname(source)
    while (true) {
      if (visited.has(directory)) break
      for (const name of names) { const file = resolve(directory, name); if (existsSync(file)) found.add(file) }
      visited.add(directory)
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  let directory = resolve(projectRoot)
  while (true) {
    if (visited.has(directory)) break
    for (const name of names) { const file = resolve(directory, name); if (existsSync(file)) found.add(file) }
    visited.add(directory)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return [...found]
}

function validDeclarationMetadata(metadataFile: string, declaration: string, input: string) {
  try {
    const value = JSON.parse(readFileSync(metadataFile, 'utf8')) as unknown
    if (!value || typeof value !== 'object') return false
    const record = value as { version?: unknown; input?: unknown; declaration?: unknown; contract?: unknown; files?: unknown }
    if (record.version !== 1 || record.input !== input || typeof record.declaration !== 'string' || typeof record.contract !== 'string' || !/^[a-f0-9]{24}(?:-[a-f0-9]{8})?$/.test(record.contract) || !Array.isArray(record.files) || !record.files.length) return false
    const root = dirname(declaration)
    const realRoot = realpathSync(root)
    if (containedRelativePathOrUndefined(realRoot, realpathSync(declaration)) === undefined || contentHash(readFileSync(declaration, 'utf8')) !== record.declaration) return false
    const contractRoot = resolve(root, 'contracts', record.contract)
    const realContractRoot = realpathSync(contractRoot)
    if (containedRelativePathOrUndefined(realRoot, realContractRoot) === undefined) return false
    const expected = declarationFiles(contractRoot).map((file) => relative(root, file).replaceAll(sep, '/')).sort()
    const recorded = record.files.map((item) => Array.isArray(item) && typeof item[0] === 'string' ? item[0] : '').sort()
    if (JSON.stringify(recorded) !== JSON.stringify(expected)) return false
    return record.files.every((item) => {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string' || !item[0].startsWith(`contracts${sep}`) && !item[0].startsWith('contracts/')) return false
      const file = resolve(root, item[0])
      return containedRelativePathOrUndefined(realContractRoot, realpathSync(file)) !== undefined && contentHash(readFileSync(file, 'utf8')) === item[1]
    })
  } catch { return false }
}

function declarationContents(directory: string) {
  return declarationFiles(directory).sort().map((file) => [relative(directory, file).replaceAll(sep, '/'), readFileSync(file, 'utf8')])
}

function validContractDirectory(directory: string, outputRoot: string, contents: string[][]) {
  try {
    const root = realpathSync(outputRoot), contract = realpathSync(directory)
    if (containedRelativePathOrUndefined(root, contract) === undefined) return false
    const files = declarationFiles(directory)
    return files.every((file) => containedRelativePathOrUndefined(contract, realpathSync(file)) !== undefined) && JSON.stringify(declarationContents(directory)) === JSON.stringify(contents)
  } catch { return false }
}

function contentHash(source: string | Buffer) {
  return createHash('sha256').update(source).digest('hex')
}

function contributesGlobals(source: string) {
  const program = parseTypeScript(source, { sourceType: 'module', plugins: ['typescript'] }).program
  const isModule = program.body.some((statement) => statement.type === 'ImportDeclaration' || statement.type.startsWith('Export'))
  return !isModule || program.body.some((statement) => statement.type === 'TSModuleDeclaration' && statement.declare)
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
  const project = resolve(projectRoot), routesRoot = resolve(project, routesDirectory), watched = new Map<string, ReturnType<typeof watch>>()
  const directories = (directory: string): string[] => [directory, ...readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() && !entry.name.startsWith('.sprindle') && !['.git', 'dist', 'dist-tooling', 'node_modules'].includes(entry.name) ? directories(resolve(directory, entry.name)) : [])]
  const insideRoutes = (directory: string) => directory === routesRoot || directory.startsWith(`${routesRoot}/`)
  const inputFiles = new Map<string, Set<string>>()
  const refreshWatchers = () => {
    if (closed) return
    inputFiles.clear()
    for (const input of dependencyInputs.get(project) ?? []) {
      const directory = dirname(input)
      if (insideRoutes(directory)) continue
      let files = inputFiles.get(directory)
      if (!files) { files = new Set(); inputFiles.set(directory, files) }
      files.add(basename(input))
    }
    const wanted = new Set([...directories(routesRoot), ...inputFiles.keys()])
    for (const directory of wanted) if (!watched.has(directory)) {
      watched.set(directory, watch(directory, (_event, filename) => {
        if (filename?.toString().startsWith('.sprindle')) return
        const files = inputFiles.get(directory)
        if (files && filename && !files.has(filename.toString())) return
        if (!closed) { refreshWatchers(); schedule() }
      }))
    }
    for (const [directory, watcher] of watched) if (!wanted.has(directory)) { watcher.close(); watched.delete(directory) }
  }
  const compile = () => { if (closed) return; queue = queue.then(() => compileRouteManifest(projectRoot, routesDirectory, output, bundle, options).then(() => { if (!closed) { refreshWatchers(); onResult?.() } }, (error: Error) => { if (!closed) { refreshWatchers(); onResult?.(error) } })) }
  const schedule = () => { if (closed) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; compile() }, 100) }
  compile(); await queue
  refreshWatchers()
  const recursiveWatcher = watch(routesRoot, { recursive: true }, (_event, filename) => {
    const path = filename?.toString().replaceAll('\\', '/') ?? ''
    if (path.split('/').some((part) => part.startsWith('.sprindle')) || path.split('/').some((part) => ['.git', 'dist', 'dist-tooling', 'node_modules'].includes(part))) return
    if (!closed) schedule()
  })
  return { close: async () => { closed = true; recursiveWatcher.close(); if (timer) { clearTimeout(timer); timer = undefined }; await queue; for (const watcher of watched.values()) watcher.close(); watched.clear() } }
}
