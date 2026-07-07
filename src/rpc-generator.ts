import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as ts from 'typescript'

type ActionKind = 'list' | 'detail' | 'create' | 'update' | 'delete' | 'custom'

type ActionDefinition = {
  method: string
  path: string
  kind: ActionKind
}

type ActionTree = {
  [key: string]: ActionDefinition | ActionTree
}

type ImportBinding = {
  imported: string
  moduleSpecifier: string
}

type ModelDefinition = {
  file: string
  exportName: string
  entityName: string
  entityImport: ImportBinding
  actions: ActionTree
}

type RouteDefinition = {
  file: string
  path: string
  modelImport: ImportBinding
}

type Route = {
  path: string
  method: string
  input: string
  status: 200 | 201
}

export type GenerateRpcOptions = {
  cwd?: string
}

const actionDefinitions = new Map<string, Promise<Map<string, ActionDefinition>>>()
const builtInActions: Record<string, ActionDefinition> = {
  create: { method: 'post', path: '', kind: 'create' },
  deleteAction: { method: 'delete', path: '/:id', kind: 'delete' },
  detail: { method: 'get', path: '/:id', kind: 'detail' },
  list: { method: 'get', path: '', kind: 'list' },
  update: { method: 'patch', path: '/:id', kind: 'update' },
}

export async function generateRpc(options: GenerateRpcOptions = {}) {
  const cwd = options.cwd ?? process.cwd()
  const srcDir = path.join(cwd, 'src')
  const routesDir = path.join(srcDir, 'routes')
  const generatedPath = path.join(srcDir, 'rpc.generated.ts')
  const files = await findFiles(routesDir)
  const definitions = (await Promise.all(files.map(readRouteDefinitions))).flat()

  const routes: Route[] = []
  const imports = new Map<string, string>()

  for (const definition of definitions) {
    const modelDefinitions = await readModelDefinitions(resolveTsImport(definition.file, definition.modelImport.moduleSpecifier))
    const modelDefinition = modelDefinitions.find((item) => item.exportName === definition.modelImport.imported)
    if (!modelDefinition) throw new Error(`Missing exported model "${definition.modelImport.imported}" for route "${definition.path}".`)

    const entityAlias = `${pascal(modelDefinition.entityName)}EntityModule`
    imports.set(entityAlias, importLine(modelDefinition, entityAlias, generatedPath))
    routes.push(...collectRoutes(modelDefinition.actions, definition.path, `${entityAlias}.${modelDefinition.entityImport.imported}`))
  }

  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  await mkdir(path.dirname(generatedPath), { recursive: true })
  await writeFile(generatedPath, renderGenerated([...imports.values()].sort(), routes))
  console.log(`Generated ${path.relative(cwd, generatedPath)} (${routes.length} routes)`)
}

async function readRouteDefinitions(file: string): Promise<RouteDefinition[]> {
  const text = await readFile(file, 'utf8')
  if (!text.includes('defineRoute')) return []

  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = readImports(sourceFile)
  const definitions: RouteDefinition[] = []

  for (const node of sourceFile.statements) {
    if (!ts.isVariableStatement(node) || !hasExport(node)) continue
    for (const declaration of node.declarationList.declarations) {
      if (!declaration.initializer) continue
      const config = getDefineRouteConfig(declaration.initializer)
      if (!config) continue

      const routePath = getObjectStringLiteral(config, 'path')
      const modelName = getObjectIdentifier(config, 'model')
      if (!routePath || !modelName) continue

      const modelImport = imports.get(modelName)
      if (!modelImport) throw new Error(`Model "${modelName}" in ${file} must be imported for RPC generation.`)
      definitions.push({ file, path: routePath, modelImport })
    }
  }

  return definitions
}

async function findFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) return findFiles(next)
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) return [next]
      return []
    }),
  )
  return files.flat()
}

async function readModelDefinitions(file: string): Promise<ModelDefinition[]> {
  const text = await readFile(file, 'utf8')
  if (!text.includes('defineModel')) return []

  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = readImports(sourceFile)
  const definitions: ModelDefinition[] = []

  for (const node of sourceFile.statements) {
    if (!ts.isVariableStatement(node) || !hasExport(node)) continue
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const config = getDefineModelConfig(declaration.initializer)
      if (!config) continue

      const entityName = getObjectIdentifier(config, 'entity')
      if (!entityName) throw new Error(`defineModel() in ${file} needs an identifier entity.`)

      const entityImport = imports.get(entityName)
      if (!entityImport) throw new Error(`Entity "${entityName}" in ${file} must be imported for RPC generation.`)

      const actions = getObjectLiteral(config, 'actions')
      if (!actions) throw new Error(`defineModel() in ${file} needs an actions object.`)

      definitions.push({
        file,
        exportName: declaration.name.text,
        entityName,
        entityImport,
        actions: await readActionTree(file, actions, imports),
      })
    }
  }

  return definitions
}

async function readActionTree(file: string, object: ts.ObjectLiteralExpression, imports: Map<string, ImportBinding>): Promise<ActionTree> {
  const actions: ActionTree = {}

  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const key = propertyNameText(property.name)
    if (!key) continue

    if (ts.isObjectLiteralExpression(property.initializer)) {
      actions[key] = await readActionTree(file, property.initializer, imports)
      continue
    }

    if (ts.isIdentifier(property.initializer)) throw new Error(`Action "${key}" in ${file} must be called before registration.`)
    if (!ts.isCallExpression(property.initializer) || !ts.isIdentifier(property.initializer.expression)) continue

    const binding = imports.get(property.initializer.expression.text)
    if (!binding) throw new Error(`Action "${property.initializer.expression.text}" in ${file} must be imported for RPC generation.`)
    actions[key] = await readActionDefinition(file, binding)
  }

  return actions
}

async function readActionDefinition(fromFile: string, binding: ImportBinding): Promise<ActionDefinition> {
  if (binding.moduleSpecifier === '@southneuhof/sprindle/actions') {
    const action = builtInActions[binding.imported]
    if (action) return action
  }

  if (!binding.moduleSpecifier.startsWith('.')) throw new Error(`Action "${binding.imported}" must come from @southneuhof/sprindle/actions or a relative module.`)

  const file = resolveTsImport(fromFile, binding.moduleSpecifier)
  const definitions = await readCustomActionDefinitions(file)
  const action = definitions.get(binding.imported)
  if (!action) throw new Error(`Missing exported action "${binding.imported}" in ${file}.`)
  return action
}

async function readCustomActionDefinitions(file: string) {
  let definitions = actionDefinitions.get(file)
  if (!definitions) {
    definitions = readCustomActionDefinitionsNow(file)
    actionDefinitions.set(file, definitions)
  }
  return definitions
}

async function readCustomActionDefinitionsNow(file: string) {
  const text = await readFile(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const definitions = new Map<string, ActionDefinition>()

  for (const node of sourceFile.statements) {
    if (!ts.isVariableStatement(node) || !hasExport(node)) continue
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const config = getDefineActionConfig(declaration.initializer)
      if (!config) continue

      const method = getObjectStringLiteral(config, 'method')
      if (!method) throw new Error(`defineAction() in ${file} needs a method.`)
      definitions.set(declaration.name.text, {
        method,
        path: getObjectStringLiteral(config, 'path') ?? '',
        kind: (getObjectStringLiteral(config, 'kind') as ActionKind | undefined) ?? 'custom',
      })
    }
  }

  return definitions
}

function readImports(sourceFile: ts.SourceFile) {
  const imports = new Map<string, ImportBinding>()
  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return
    const named = node.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) return
    for (const element of named.elements) {
      imports.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        moduleSpecifier: node.moduleSpecifier.text,
      })
    }
  })
  return imports
}

function hasExport(node: ts.VariableStatement) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function getDefineModelConfig(expression: ts.Expression) {
  if (!ts.isCallExpression(expression)) return undefined
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'defineModel') return undefined
  const [config] = expression.arguments
  return config && ts.isObjectLiteralExpression(config) ? config : undefined
}

function getDefineRouteConfig(expression: ts.Expression) {
  if (!ts.isCallExpression(expression)) return undefined
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'defineRoute') return undefined
  const [config] = expression.arguments
  return config && ts.isObjectLiteralExpression(config) ? config : undefined
}

function getDefineActionConfig(expression: ts.Expression) {
  if (!ts.isCallExpression(expression)) return undefined
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'defineAction') return undefined
  const [config] = expression.arguments
  return config && ts.isObjectLiteralExpression(config) ? config : undefined
}

function getObjectIdentifier(object: ts.ObjectLiteralExpression, key: string) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    if (property.name.text === key && ts.isIdentifier(property.initializer)) return property.initializer.text
  }
  return undefined
}

function getObjectStringLiteral(object: ts.ObjectLiteralExpression, key: string) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    if (property.name.text === key && ts.isStringLiteral(property.initializer)) return property.initializer.text
  }
  return undefined
}

function getObjectLiteral(object: ts.ObjectLiteralExpression, key: string) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    if (property.name.text === key && ts.isObjectLiteralExpression(property.initializer)) return property.initializer
  }
  return undefined
}

function propertyNameText(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function importLine(definition: ModelDefinition, alias: string, generatedPath: string) {
  const resolved = path.resolve(path.dirname(definition.file), definition.entityImport.moduleSpecifier)
  const specifier = toRelativeImport(path.dirname(generatedPath), resolved)
  return `import type * as ${alias} from '${specifier}'`
}

function toRelativeImport(fromDir: string, targetNoExtension: string) {
  const relative = path.relative(fromDir, targetNoExtension).replaceAll(path.sep, '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

function resolveTsImport(fromFile: string, moduleSpecifier: string) {
  const resolved = path.resolve(path.dirname(fromFile), moduleSpecifier)
  return resolved.endsWith('.ts') ? resolved : `${resolved}.ts`
}

function collectRoutes(actions: ActionTree, basePath: string, entityAlias: string) {
  const routes: Route[] = []
  walkActions(actions, [basePath], entityAlias, routes)
  return routes
}

function walkActions(actions: ActionTree, segments: string[], entityAlias: string, routes: Route[]) {
  for (const [key, value] of Object.entries(actions)) {
    if (isActionDefinition(value)) {
      const routePath = normalizePath(`/${[...segments, key].join('/')}${value.path}`)
      routes.push({
        path: routePath,
        method: `$${value.method}`,
        input: inputFor(value.kind, routePath, entityAlias),
        status: value.kind === 'create' ? 201 : 200,
      })
      continue
    }

    walkActions(value, [...segments, key], entityAlias, routes)
  }
}

function isActionDefinition(value: ActionDefinition | ActionTree): value is ActionDefinition {
  return typeof (value as ActionDefinition).method === 'string'
}

function inputFor(kind: ActionKind, routePath: string, entityAlias: string) {
  const parts: string[] = []
  if (kind === 'list') parts.push('{ query: ListQuery }')
  if (kind === 'create') parts.push(`{ json: z.input<typeof ${entityAlias}.schemas.create> }`)
  if (kind === 'update') parts.push(`{ json: z.input<typeof ${entityAlias}.schemas.update> }`)

  const params = paramInput(routePath)
  if (params) parts.push(params)

  return parts.length ? parts.join(' & ') : '{}'
}

function paramInput(routePath: string) {
  const params = [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1])
  if (!params.length) return undefined
  return `{ param: { ${params.map((param) => `${param}: string`).join('; ')} } }`
}

function normalizePath(value: string) {
  return value.replace(/\/+/g, '/')
}

function pascal(value: string) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('')
}

function renderGenerated(imports: string[], routes: Route[]) {
  return `/* eslint-disable */
// This file is generated by @southneuhof/sprindle/rpc-generator. Do not edit.

import type { Hono } from 'hono'
import type { z } from 'zod/v4'
import type { CustomRoutesSchema } from '@southneuhof/sprindle/routes'
import type { routes } from './routes'
${imports.join('\n')}

type ListQuery = {
  page?: string
  limit?: string
  search?: string
}

type JsonEndpoint<TInput, TStatus extends number = 200> = {
  input: TInput
  output: unknown
  outputFormat: 'json'
  status: TStatus
}

export type ModelRpcSchema = {
${routes.map(renderRoute).join('\n')}
}

export type RpcSchema = ModelRpcSchema & CustomRoutesSchema<typeof routes>

export type AppType = Hono<{}, RpcSchema>
`
}

function renderRoute(route: Route) {
  return `  '${route.path}': {
    '${route.method}': JsonEndpoint<${route.input}, ${route.status}>
  }`
}
