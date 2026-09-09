import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { API } from 'typescript/unstable/sync'
import { parse } from '@babel/parser'
import { parse as parseJsonc } from 'jsonc-parser'
import { routeFileLocation } from './route-files.ts'

type TextEdit = { start: number; end: number; text: string }
type CompilerLocation = { sourceFile?: { fileName: string }; fileName?: string; pos: number; end: number }
export type ToolingDiagnostic = { fileName?: string; pos?: number; end?: number; code: number; text: string }

function syntax(source: string) {
  try { return parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }).program }
  catch {
    const lines = [...source.matchAll(/\n/g)].map((match) => match.index + 1).reverse()
    for (const end of lines) try { return parse(source.slice(0, end), { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }).program } catch { /* try the preceding complete line */ }
    return parse('', { sourceType: 'module', plugins: ['typescript'] }).program
  }
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function projectFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && (entry.name.startsWith('.sprindle') || ['.git', 'dist', 'node_modules'].includes(entry.name))) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? projectFiles(path) : /\.(?:[cm]?ts|json)$/.test(entry.name) ? [path] : []
  })
}

function configFiles(file: string, seen = new Set<string>()): string[] {
  file = resolve(file); if (seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  const value = parseJsonc(readFileSync(file, 'utf8')) as { extends?: string | string[] } | undefined
  const values = typeof value?.extends === 'string' ? [value.extends] : value?.extends ?? []
  return [file, ...values.filter((item) => item.startsWith('.')).flatMap((item) => configFiles(resolve(dirname(file), item.endsWith('.json') ? item : `${item}.json`), seen))]
}

function sourceDependencies(files: string[], overlays: Map<string, string>) {
  const found = new Set(files)
  for (const file of found) {
    if (!/\.[cm]?ts$/.test(file)) continue
    for (const statement of syntax(overlays.get(file) ?? readFileSync(file, 'utf8')).body) {
      if (!('source' in statement) || !statement.source?.value?.startsWith('.')) continue
      const base = resolve(dirname(file), statement.source.value)
      const target = [base, `${base}.ts`, `${base}.mts`, `${base}.cts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
      if (target) found.add(target)
    }
  }
  return [...found]
}

/** Change only parsed module specifiers. Equal-length edits keep source positions exact. */
export function redirectSprindleImports(source: string, target: string) {
  const edits: TextEdit[] = []
  for (const statement of syntax(source).body) {
    if ((statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') && statement.source?.value === '@southneuhof/sprindle') {
      const { start, end } = statement.source
      if (start == null || end == null) continue
      const original = source.slice(start, end)
      const replacement = JSON.stringify(target)
      if (replacement.length > original.length) throw new Error(`Internal helper path ${target} is too long`)
      edits.push({ start, end, text: replacement.padEnd(original.length) })
    }
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source
}

function scopeParents(root: string, file: string, files: Set<string>) {
  const { segments } = routeFileLocation(root, file)
  return [root, ...segments.map((_, index) => join(root, ...segments.slice(0, index + 1)))]
    .reverse().map((path) => join(path, '+scope.ts')).find((candidate) => candidate !== file && files.has(candidate))
}

function contextProperty(source: string, name: string) {
  const program = syntax(source)
  for (const statement of program.body) {
    if (statement.type !== 'ExportDefaultDeclaration' || statement.declaration.type !== 'CallExpression') continue
    const config = statement.declaration.arguments[0]
    if (!config || config.type !== 'ObjectExpression') continue
    const context = config.properties.find((item) => item.type === 'ObjectProperty' && ((item.key.type === 'Identifier' && item.key.name === 'context') || (item.key.type === 'StringLiteral' && item.key.value === 'context')))
    if (!context || context.type !== 'ObjectProperty') continue
    const value = context.value
    if (value.type !== 'ArrowFunctionExpression' && value.type !== 'FunctionExpression') continue
    let returned
    if (value.body.type === 'ObjectExpression') returned = value.body
    else if (value.body.type === 'BlockStatement') returned = value.body.body.find((item) => item.type === 'ReturnStatement')?.argument
    if (returned?.type !== 'ObjectExpression') continue
    for (const property of returned.properties) if (property.type === 'ObjectProperty' && property.key.start != null && property.key.end != null && ((property.key.type === 'Identifier' && property.key.name === name) || (property.key.type === 'StringLiteral' && property.key.value === name))) return { pos: property.key.start, end: property.key.end }
  }
}

function helperDeclaration(root: string, file: string, files: Set<string>, definition: string, publicTypes: string) {
  const directory = dirname(file)
  const { parameters } = routeFileLocation(root, file)
  const parentFile = scopeParents(root, file, files)
  const parent = parentFile ? `typeof import(${JSON.stringify('./' + relative(directory, parentFile).replace(/\.ts$/, ''))}).default` : 'ScopeView<{}, never>'
  const params = `{${parameters.map((name) => `${JSON.stringify(name)}: string`).join(';')}}`
  const definitionImport = relative(directory, definition).replaceAll(sep, '/').replace(/\.ts$/, '')
  const specifier = definitionImport.startsWith('.') ? definitionImport : `./${definitionImport}`
  const publicImport = relative(directory, publicTypes).replaceAll(sep, '/').replace(/\.d\.ts$/, '')
  const publicSpecifier = publicImport.startsWith('.') ? publicImport : `./${publicImport}`
  return `
export * from ${JSON.stringify(publicSpecifier)}
import type { DefineFileCreate, DefineFileDelete, DefineFileDetail, DefineFileList, DefineFileRoute, DefineFileScope, DefineFileUpdate, ScopeView } from ${JSON.stringify(specifier)}
type Parent = ${parent}
type Params = ${params}
export declare const defineScope: DefineFileScope<Parent, Params>
export declare const defineRoute: DefineFileRoute<Parent, Params>
export declare const list: DefineFileList<Parent, Params>
export declare const detail: DefineFileDetail<Parent, Params>
export declare const create: DefineFileCreate<Parent, Params>
export declare const update: DefineFileUpdate<Parent, Params>
export declare const deleteRoute: DefineFileDelete<Parent, Params>
`
}

export function createRouteLanguage(projectRoot: string, routesDirectory = 'routes') {
  const root = resolve(projectRoot, routesDirectory)
  const config = join(projectRoot, 'tsconfig.json')
  const definitionFile = [resolve(import.meta.dirname, '../routes/definition.ts'), resolve(import.meta.dirname, '../src/routes/definition.ts')].find(existsSync)
  if (!definitionFile) throw new Error('Sprindle route definitions are missing from this package')
  const definition: string = definitionFile
  const publicTypesFile = [resolve(import.meta.dirname, '../../dist-types/index.d.ts'), resolve(import.meta.dirname, '../dist-types/index.d.ts')].find(existsSync)
  if (!publicTypesFile) throw new Error('Sprindle public type declarations are missing; prepare the package first')
  const publicTypes: string = publicTypesFile
  const open = new Map<string, string>()
  let virtual = new Map<string, string>()
  let snapshot: ReturnType<API['updateSnapshot']> | undefined
  const start = () => new API({ cwd: projectRoot, fs: { readFile: (file) => virtual.get(file), fileExists: (file) => virtual.has(file) || undefined } })
  let api = start()

  function refresh() {
    const next = routeLanguageOverlay(projectRoot, routesDirectory, open, definition, publicTypes)
    const created = [...next.keys()].filter((file) => !virtual.has(file))
    const deleted = [...virtual.keys()].filter((file) => !next.has(file))
    const changed = [...next.keys()].filter((file) => virtual.has(file) && virtual.get(file) !== next.get(file))
    virtual = next
    if (snapshot && (created.length || deleted.length)) { snapshot.dispose(); api.close(); api = start(); snapshot = undefined }
    snapshot?.dispose()
    snapshot = api.updateSnapshot({ openProjects: snapshot ? [] : [config], fileChanges: { created, deleted, changed } })
    const project = snapshot.getProject(config)
    if (!project) throw new Error(`TypeScript did not open ${config}`)
    return project
  }

  return {
    open(file: string, text: string) { open.set(resolve(file), text) },
    closeDocument(file: string) { open.delete(resolve(file)) },
    diagnostics(): ToolingDiagnostic[] {
      const program = refresh().program
      return [...program.getConfigFileParsingDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
        .map(({ fileName, pos, end, code, text }) => ({ fileName, pos, end, code, text }))
    },
    completions(file: string, position: number) { return refresh().checker.getCompletionsAtPosition(resolve(file), position)?.entries ?? [] },
    type(file: string, position: number, expanded = false) { const project = refresh(); const type = project.checker.getTypeAtPosition(resolve(file), position); return type && project.checker.typeToString(type, undefined, expanded ? 1 | 64 | 8_388_608 : undefined) },
    definitions(file: string, position: number) {
      const project = refresh()
      const symbol = project.checker.getSymbolAtPosition(resolve(file), position)
      const found = (symbol?.declarations ?? []).map((item) => item as unknown as CompilerLocation).flatMap(({ sourceFile, fileName, pos, end }) => fileName || sourceFile ? [{ fileName: fileName ?? sourceFile!.fileName, pos, end }] : [])
      const physical = found.filter((item) => !/\.[sr]\.d\.ts$/.test(item.fileName))
      if (physical.length) return physical
      const name = symbol?.name
      if (!name) return []
      const files = new Set(walk(root))
      const { segments } = routeFileLocation(root, resolve(file))
      const scopes = [root, ...segments.map((_, index) => join(root, ...segments.slice(0, index + 1)))].reverse().map((item) => join(item, '+scope.ts')).filter((item) => files.has(item))
      for (const scope of scopes) { const location = contextProperty(open.get(scope) ?? readFileSync(scope, 'utf8'), name); if (location) return [{ fileName: scope, ...location }] }
      return []
    },
    rename(file: string, position: number) {
      const project = refresh()
      const symbol = project.checker.getSymbolAtPosition(resolve(file), position)
      if (!symbol) return []
      const directoryParameters = routeFileLocation(root, resolve(file)).parameters
      if (directoryParameters.includes(symbol.name)) throw new Error(`Parameter rename requires a directory move: ${symbol.name}`)
      const definitions = this.definitions(file, position)
      if (definitions.some((item) => item.fileName.endsWith(`${sep}+scope.ts`))) throw new Error(`Context property rename is unavailable because complete references cannot be proven: ${symbol.name}`)
      throw new Error(`Rename is unavailable because complete references cannot be proven: ${symbol.name}`)
    },
    close() { snapshot?.dispose(); api.close() },
  }
}

export function routeLanguageOverlay(
  projectRoot: string,
  routesDirectory = 'routes',
  open = new Map<string, string>(),
  definitionFile?: string,
  publicTypesFile?: string,
) {
  const root = resolve(projectRoot, routesDirectory)
  const config = join(projectRoot, 'tsconfig.json')
  const definition = definitionFile ?? [resolve(import.meta.dirname, '../routes/definition.ts'), resolve(import.meta.dirname, '../src/routes/definition.ts')].find(existsSync)
  const publicTypes = publicTypesFile ?? [resolve(import.meta.dirname, '../../dist-types/index.d.ts'), resolve(import.meta.dirname, '../dist-types/index.d.ts')].find(existsSync)
  if (!definition || !publicTypes) throw new Error('Sprindle route definition declarations are missing; prepare the package first')
  const routeFiles = [...walk(root), ...open.keys()]
  const entryFiles = routeFiles.filter((file) => /\/(?:\+scope|\+server)\.ts$/.test(file))
  const paths = new Set([...entryFiles, ...sourceDependencies(entryFiles, open).filter((file) => file.startsWith(root + sep) && file.endsWith('.ts'))])
  const next = new Map<string, string>()
  const dependencies = sourceDependencies([...projectFiles(projectRoot), ...configFiles(config), ...open.keys()], open)
  for (const file of dependencies) next.set(file, open.get(file) ?? readFileSync(file, 'utf8'))
  for (const file of paths) {
    const isScope = file.endsWith('/+scope.ts')
    const helper = isScope ? '.s' : '.r'
    next.set(file, redirectSprindleImports(open.get(file) ?? readFileSync(file, 'utf8'), `./${helper}`))
    next.set(join(dirname(file), `${helper}.d.ts`), helperDeclaration(root, file, paths, definition, publicTypes))
  }
  next.set(config, open.get(config) ?? readFileSync(config, 'utf8'))
  return next
}
