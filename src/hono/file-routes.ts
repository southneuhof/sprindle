import type { Context, Hono, MiddlewareHandler } from 'hono'
import { toHttpError, validationError } from '../errors'
import { attachDataWriteHook, getDataWriteHook } from '../model/data-write'
import { isDomainEntity } from '../model/domain-schema'
import { isSourceBound } from '../model/source-bound'
import type { ModelRuntimeContext } from '../source'
import { listQuerySchema, normalizeListQuery } from '../validation'
import { isFileRoute, type RuntimeRouteDefinition } from '../routes/define-route'
import { isFileScope } from '../routes/define-scope'
import { runAfter, runAuthorize, runBefore, runError, runValidate } from '../routes/pipeline'
import type { RouteErrorArgs, RouteHandlerArgs, RoutePipeline } from '../model/route-types'
import type { SprindleInstallOptions } from './index'

export type FileRouteManifestEntry = {
  sourcePath: string
  httpPath: string
  parameters: string[]
  methods: string[]
  scopes: unknown[]
  handlers: Record<string, unknown>
}

export type FileRouteManifest = readonly FileRouteManifestEntry[]
const MANIFEST_KEY = 'sprindle:manifest'

export function getRouteManifest(c: Context) {
  const manifest = c.get(MANIFEST_KEY as never) as FileRouteManifest | undefined
  if (!manifest) throw new Error('Sprindle routes are not installed.')
  return manifest
}

export function assertRouteEntitiesBound(manifest: FileRouteManifest) {
  for (const entry of manifest) for (const value of entry.scopes) {
    if (!isFileScope(value) || !value.config.entity) continue
    if (isDomainEntity(value.config.entity) && !isSourceBound(value.config.entity.source)) throw new Error(`${entry.sourcePath}: entity "${value.config.entity.name}" is not bound to a database.`)
  }
}

export function bindRouteEntities(manifest: FileRouteManifest, entities: readonly ModelRuntimeContext['entity'][]) {
  const sources = new Map(entities.map((entity) => [entity.name, entity.source]))
  for (const entry of manifest) for (const value of entry.scopes) {
    if (!isFileScope(value) || !value.config.entity || !isDomainEntity(value.config.entity)) continue
    const source = sources.get(value.config.entity.name)
    if (!source) throw new Error(`${entry.sourcePath}: no registered domain entity matches "${value.config.entity.name}".`)
    value.config.entity.source = source
  }
}

type Args = { c: Context; params: Record<string, string>; context: Record<string, unknown>; identity: () => Promise<unknown>; state: Record<string, unknown> }
type Layer = Record<string, unknown>
type EnteredLayer = { layer: Layer; identity: Args['identity']; context: Record<string, unknown> }
type RuntimeEntity = ModelRuntimeContext['entity'] & { schemas: { create: { parse(input: unknown): unknown }; update: { parse(input: unknown): unknown }; select: { parse(input: unknown): unknown } } }
type RuntimeMeta = { name: string; entity?: RuntimeEntity; enrich?: ModelRuntimeContext['enrich']; enrichContext?: Record<string, unknown>; enrichIdentity?: Args['identity'] }
const RESERVED_CONTEXT_KEYS = new Set(['entity', 'enrich', 'identity', 'pipeline', 'source'])

const asPipeline = (value: Layer) => value as unknown as RoutePipeline
const asPipelineArgs = (value: Args) => value as unknown as RouteHandlerArgs

export function resolveScopeMetadata(scopes: readonly unknown[], fallbackName: string): RuntimeMeta {
  let runtime: RuntimeMeta = { name: fallbackName }
  for (const value of scopes) {
    if (!isFileScope(value)) continue
    runtime = applyScopeMetadata(runtime, value.config as Layer, fallbackName)
  }
  return runtime
}

function applyScopeMetadata(runtime: RuntimeMeta, config: Layer, fallbackName: string, context?: Record<string, unknown>, identity?: Args['identity']): RuntimeMeta {
  if (config.entity) runtime = { name: (config.entity as { name?: string }).name ?? fallbackName, entity: config.entity as RuntimeEntity }
  if (config.enrich) runtime = { ...runtime, enrich: config.enrich as ModelRuntimeContext['enrich'], enrichContext: context, enrichIdentity: identity }
  return runtime
}

export function installFileRoutes<TApp extends Hono<any, any>>(app: TApp, manifest: FileRouteManifest, options: SprindleInstallOptions = {}): TApp {
  app.use('*', async (c, next) => { c.set(MANIFEST_KEY as never, manifest as never); await next() })
  const logger = options.logger
  app.use('*', async (c, next) => { if (logger) c.set('logger', logger); await next() })

  const groups = new Map<string, { entry: FileRouteManifestEntry; methods: Set<string>; parameters: string[] }>()
  const orderedEntries = [...manifest].sort((left, right) => routeSpecificity(right.httpPath) - routeSpecificity(left.httpPath))
  for (const entry of orderedEntries) {
    for (const scope of entry.scopes) validateScope(entry, scope)
    const declared = new Set(entry.methods)
    if (declared.has('HEAD') && !declared.has('GET')) validateDefinition(entry, 'HEAD')
    const pathKey = normalizeRoutePath(entry.httpPath)
    const group = groups.get(pathKey)
    const duplicateMethod = group && entry.methods.find((method) => group.methods.has(method))
    if (duplicateMethod && group) throw new Error(`${entry.sourcePath}: duplicate ${duplicateMethod} ${pathKey}; also ${group.entry.sourcePath}`)
    if (group && group.parameters.join('/') !== entry.parameters.join('/')) throw new Error(`${entry.sourcePath}: parameter names for ${pathKey} conflict with ${group.entry.sourcePath}.`)
    const current = group ?? { entry, methods: new Set<string>(), parameters: entry.parameters }
    groups.set(pathKey, current)
    for (const method of [...entry.methods].sort((left, right) => left === 'HEAD' ? -1 : right === 'HEAD' ? 1 : 0)) {
      current.methods.add(method)
      validateDefinition(entry, method)
      mount(app, manifest, entry, method, options)
    }
  }
  const fallbacks = [...groups.values()].sort((left, right) => routeSpecificity(right.entry.httpPath) - routeSpecificity(left.entry.httpPath))
  for (const { entry, methods } of fallbacks) app.all(entry.httpPath, (c) => {
    const allow = allowHeader(methods)
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: allow } })
    return c.json({ error: 'method_not_allowed' }, 405, { Allow: allow })
  })
  return app
}

function normalizeRoutePath(path: string) { return path.replace(/:[^/]+/g, ':parameter') }
function routeSpecificity(path: string) { return path.split('/').filter((part) => part && !part.startsWith(':')).length }

function validateScope(entry: FileRouteManifestEntry, value: unknown) {
  if (!isFileScope(value)) throw new Error(`${entry.sourcePath}: invalid scope definition.`)
  const entity = value.config.entity as Record<string, unknown> | undefined
  if (!entity) return
  const schemas = entity.schemas as Record<string, unknown> | undefined
  const source = entity.source as Record<string, unknown> | undefined
  for (const name of ['create', 'update', 'select']) if (typeof (schemas?.[name] as { parse?: unknown } | undefined)?.parse !== 'function') throw new Error(`${entry.sourcePath}: entity scope needs schemas.${name}.parse().`)
  for (const name of ['list', 'detail', 'create', 'update', 'delete', 'materialize']) if (typeof source?.[name] !== 'function') throw new Error(`${entry.sourcePath}: entity scope needs source.${name}().`)
}

function validateDefinition(entry: FileRouteManifestEntry, method: string) {
  const route = entry.handlers[method]
  if (!isFileRoute(route)) throw new Error(`${entry.sourcePath}: ${method} must use a Sprindle route helper.`)
  const allowed: Record<RuntimeRouteDefinition['kind'], string[]> = { route: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'], list: ['GET'], detail: ['GET'], create: ['POST'], update: ['PATCH'], delete: ['DELETE'] }
  if (!allowed[route.kind].includes(method)) throw new Error(`${entry.sourcePath}: ${route.kind} cannot be exported as ${method}.`)
  if (route.kind !== 'route') {
    const scope = [...entry.scopes].reverse().find((value) => isFileScope(value) && value.config.entity)
    if (!scope) throw new Error(`${entry.sourcePath}: ${route.kind} needs an entity scope.`)
    if (['detail', 'update', 'delete'].includes(route.kind)) {
      const param = String(route.config.param ?? 'id')
      if (!entry.parameters.includes(param)) throw new Error(`${entry.sourcePath}: ${route.kind} needs parameter ${param}.`)
    }
  }
}

function allowHeader(methods: Set<string>) {
  const allowed = new Set(methods)
  if (allowed.has('GET')) allowed.add('HEAD')
  allowed.add('OPTIONS')
  return [...allowed].sort().join(', ')
}

function mount(app: Hono, manifest: FileRouteManifest, entry: FileRouteManifestEntry, method: string, options: SprindleInstallOptions, handlerMethod = method) {
  const definition = entry.handlers[handlerMethod] as RuntimeRouteDefinition
  const handler = async (c: Context) => {
    const route = definition
    const params = Object.fromEntries(entry.parameters.map((name) => [name, c.req.param(name) ?? ''])) as Record<string, string>
    for (const [name, value] of Object.entries(params)) if (!value) throw validationError([{ field: name, message: 'Required path parameter.' }])
    const identityValues = new Map<unknown, Promise<unknown>>()
    const installedResolver = options.identity ? () => options.identity!(c) : () => null
    const memoizedIdentity = (resolver: () => unknown) => () => {
      let value = identityValues.get(resolver)
      if (!value) { value = Promise.resolve(resolver()); identityValues.set(resolver, value) }
      return value
    }
    let identity = memoizedIdentity(installedResolver)
    let context: Record<string, unknown> = { ...options.context }
    const entered: EnteredLayer[] = options.pipeline ? [{ layer: options.pipeline as Layer, identity, context }] : []
    let runtime: RuntimeMeta = { name: entry.httpPath }
    let state: Record<string, unknown> | undefined
    try {
      if (options.pipeline) {
        const denied = await runAuthorize(asPipelineArgs({ c, params, context, identity, state: {} }), asPipeline(options.pipeline as Layer))
        if (denied) return denied
      }
      for (const value of entry.scopes) {
        if (!isFileScope(value)) throw new Error(`${entry.sourcePath}: invalid scope definition.`)
        const config = value.config as Layer
        if (config.identity) identity = memoizedIdentity(() => (config.identity as (args: { c: Context }) => unknown)({ c }))
        const base = { c, params, context, identity, state: {} }
        const patch = config.context ? await (config.context as (args: Omit<Args, 'state'> & { state: Record<string, unknown> }) => unknown)(base) : undefined
        if (patch && typeof patch === 'object') assertContextPatch(patch as Record<string, unknown>, entry.sourcePath)
        context = { ...context, ...(patch && typeof patch === 'object' ? patch : {}) }
        runtime = applyScopeMetadata(runtime, config, entry.httpPath, context, identity)
        entered.push({ layer: config, identity, context })
        const denied = await runAuthorize(asPipelineArgs({ ...base, context }), asPipeline(config))
        if (denied) return denied
      }
      const args = { c, params, context, identity, state: {} }
      entered.push({ layer: route.config, identity, context })
      const denied = await runAuthorize(asPipelineArgs(args), asPipeline(route.config))
      if (denied) return denied
      state = await createState(route, args, runtime)
      const complete = { ...args, state }
      if (route.kind === 'create' || route.kind === 'update') await applyDataWrite(route.kind, complete, options, runtime)
      for (const enteredLayer of entered) await runBefore(asPipelineArgs({ ...complete, identity: enteredLayer.identity, context: enteredLayer.context }), asPipeline(enteredLayer.layer))
      for (const enteredLayer of entered) { const invalid = await runValidate(asPipelineArgs({ ...complete, identity: enteredLayer.identity, context: enteredLayer.context }), asPipeline(enteredLayer.layer)); if (invalid) return invalid }
      let response = await action(route, complete, runtime)
      for (const enteredLayer of entered.slice().reverse()) response = (await runAfter(asPipelineArgs({ ...complete, identity: enteredLayer.identity, context: enteredLayer.context }), response, asPipeline(enteredLayer.layer))) ?? response
      if (handlerMethod !== method) return new Response(null, { status: response.status, headers: response.headers })
      return response
    } catch (error) {
      const args = { c, params, context, state: state ?? {}, error }
      for (const enteredLayer of entered.slice().reverse()) { const response = await runError({ ...args, identity: enteredLayer.identity, context: enteredLayer.context } as unknown as RouteErrorArgs, asPipeline(enteredLayer.layer)); if (response) return response }
      const httpError = toHttpError(error)
      if (httpError) return c.json({ error: httpError.code, message: httpError.message || undefined, issues: httpError.issues }, httpError.status as 400)
      throw error
    }
  }
  const middleware = (definition.config.middleware ?? []) as MiddlewareHandler[]
  if (method === 'HEAD') app.use(entry.httpPath, async (c, next) => c.req.method === 'HEAD' ? runMiddleware(c, middleware, handler) : next())
  else app.on([method], [entry.httpPath], ...middleware, handler)
}

async function runMiddleware(c: Context, middleware: MiddlewareHandler[], handler: (c: Context) => Promise<Response>) {
  let index = -1
  const dispatch = async (nextIndex: number): Promise<Response> => {
    if (nextIndex <= index) throw new Error('next() called more than once')
    index = nextIndex
    const current = middleware[nextIndex]
    if (!current) return handler(c)
    let downstream: Response | undefined
    const result = await current(c, async () => { downstream = await dispatch(nextIndex + 1); c.res = downstream })
    return result ?? c.res ?? downstream
  }
  return dispatch(0)
}

function assertContextPatch(patch: Record<string, unknown>, sourcePath: string) {
  const key = Object.keys(patch).find((name) => RESERVED_CONTEXT_KEYS.has(name))
  if (key) throw new Error(`${sourcePath}: scope context cannot set reserved key "${key}".`)
}

async function createState(route: RuntimeRouteDefinition, args: Args, runtime: RuntimeMeta): Promise<Record<string, unknown>> {
  const config = route.config
  if (route.kind === 'route') return config.state ? await (config.state as (args: Args) => Promise<Record<string, unknown>> | Record<string, unknown>)(args) : {}
  if (route.kind === 'list') { const query = listQuerySchema.parse(normalizeListQuery(args.c.req.query())); const policy = config.query as { defaultSort?: string; enumFilters?: Record<string, readonly string[]> } | undefined; if (policy?.defaultSort && (query.sort == null || query.sort === '')) query.sort = policy.defaultSort; for (const [key, allowed] of Object.entries(policy?.enumFilters ?? {})) { const value = query[key]; if (value !== undefined && value !== '' && !allowed.includes(value as string)) throw validationError(`Query parameter "${key}" must be one of: ${allowed.join(', ')}.`) }; return { query, where: undefined } }
  if (route.kind === 'create') { const raw = await args.c.req.json(); return { input: runtime.entity!.schemas.create.parse(raw), values: undefined } }
  const param = String(config.param ?? 'id'); const id = args.params[param]; if (!id) throw validationError([{ field: param, message: 'Required path parameter.' }])
  if (route.kind === 'update') { const raw = await args.c.req.json(); return { id, input: runtime.entity!.schemas.update.parse(raw), values: undefined, where: undefined } }
  return { id, where: undefined }
}

async function applyDataWrite(kind: 'create' | 'update', args: Args, options: SprindleInstallOptions, meta: RuntimeMeta) {
  const runtime = { ...args.context, ...meta } as ModelRuntimeContext
  attachDataWriteHook(runtime, options.dataWrite)
  const values = await getDataWriteHook(runtime)?.({ c: args.c, context: runtime, identity: args.identity, operation: kind })
  if (values) args.state.values = { ...(args.state.values as object | undefined), ...values }
}

async function action(route: RuntimeRouteDefinition, args: Args, meta: RuntimeMeta): Promise<Response> {
  const config = route.config
  if (route.kind === 'route') return response(args.c, await (config.action as (args: Args) => unknown)(args))
  const runtime = { ...args.context, ...meta } as ModelRuntimeContext
  const source = runtime.entity.source
  if (route.kind === 'list') {
    const result = config.run ? await (config.run as (args: Args) => Promise<{ data: unknown[]; total: number }> | { data: unknown[]; total: number })(args) : await source.list({ query: args.state.query as Record<string, unknown>, where: args.state.where, context: runtime })
    let data = Array.isArray(result) ? result : result.data; const total = Array.isArray(result) ? result.length : result.total
    data = await Promise.all(data.map((record) => publicRecord(record, args, meta)))
    if (config.enrich) data = (await (config.enrich as (rows: unknown[], args: Args) => Promise<unknown[]>)(data, args)) ?? data
    return args.c.json({ data, page: (args.state.query as { page: number }).page, limit: (args.state.query as { limit: number }).limit, total })
  }
  if (route.kind === 'delete') { if (config.run) await (config.run as (args: Args) => unknown)(args); else if (!await source.delete({ id: args.state.id as string, where: args.state.where, context: runtime })) return args.c.json({ error: 'not_found' }, 404); return args.c.json({ ok: true }) }
  let raw: unknown
  if (config.run) raw = await (config.run as (args: Args) => unknown)(args)
  else if (route.kind === 'detail') raw = await source.detail({ id: args.state.id as string, where: args.state.where, context: runtime })
  else if (route.kind === 'create') raw = await source.create({ input: args.state.input, inputParsed: true, values: args.state.values as Record<string, unknown> | undefined, context: runtime })
  else raw = await source.update({ id: args.state.id as string, input: args.state.input, inputParsed: true, values: args.state.values as Record<string, unknown> | undefined, where: args.state.where, context: runtime })
  if (!raw && route.kind !== 'create') return args.c.json({ error: 'not_found' }, 404)
  let data = await publicRecord(raw, args, meta)
  if (config.enrich) data = (await (config.enrich as (record: unknown, args: Args) => Promise<unknown>)(data, args)) ?? data
  return args.c.json({ data }, route.kind === 'create' ? 201 : 200)
}

async function publicRecord(record: unknown, args: Args, meta: RuntimeMeta) { const enrich = meta.enrich as { schema: { parse(value: unknown): unknown }; run(record: unknown, args: Args): unknown } | undefined; return enrich ? enrich.schema.parse(await enrich.run(record, { ...args, context: meta.enrichContext ?? args.context, identity: meta.enrichIdentity ?? args.identity })) : record }
function response(c: Context, value: unknown) { return value instanceof Response ? value : c.json(value as object) }
