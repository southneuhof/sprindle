import type { Context, MiddlewareHandler } from 'hono'
import type { z } from 'zod'

export type RouteParameters = Record<string, string>
export type ScopeView<TContext extends object = {}, TEntity = unknown, TPublicEntity = TEntity, TIdentity = unknown> = { context: TContext; entity: TEntity; publicEntity: TPublicEntity; identity: TIdentity }
export type ScopeContext<TParent extends ScopeView, TContext extends object> = Omit<TParent['context'], keyof TContext> & TContext
export type ScopeEntity<TParent extends ScopeView, TEntity> = [TEntity] extends [never] ? TParent['entity'] : TEntity
export type ScopePublicEntity<TParent extends ScopeView, TEntity> = [TEntity] extends [never] ? TParent['publicEntity'] : TEntity
export type EntityRecord<TScope extends ScopeView<object, unknown>> = TScope['entity'] extends { schemas: { select: infer TSchema extends z.ZodType } } ? z.output<TSchema> : Record<string, unknown>
export type PublicEntityRecord<TScope extends ScopeView<object, unknown>> = TScope['publicEntity'] extends { schemas: { select: infer TSchema extends z.ZodType } } ? z.output<TSchema> : Record<string, unknown>
export type EntityCreateInput<TScope extends ScopeView<object, unknown>> = TScope['entity'] extends { schemas: { create: infer TSchema extends z.ZodType } } ? z.input<TSchema> : Record<string, unknown>
export type EntityUpdateInput<TScope extends ScopeView<object, unknown>> = TScope['entity'] extends { schemas: { update: infer TSchema extends z.ZodType } } ? z.input<TSchema> : Record<string, unknown>
export type EntityCreateValue<TScope extends ScopeView<object, unknown>> = TScope['entity'] extends { schemas: { create: infer TSchema extends z.ZodType } } ? z.output<TSchema> : Record<string, unknown>
export type EntityUpdateValue<TScope extends ScopeView<object, unknown>> = TScope['entity'] extends { schemas: { update: infer TSchema extends z.ZodType } } ? z.output<TSchema> : Record<string, unknown>

export type FileRequestArgs<TParams extends RouteParameters, TContext extends object, TIdentity = unknown> = { c: Context; params: TParams; context: TContext; identity: () => Promise<TIdentity> }
export type FileRouteArgs<TParams extends RouteParameters, TContext extends object, TState extends object = {}, TIdentity = unknown> = FileRequestArgs<TParams, TContext, TIdentity> & { state: TState }
export type FileValidationIssue = string | { field?: string; message: string }
type Hook<T> = T | T[]
export type FilePipeline<TArgs extends FileRouteArgs<RouteParameters, object, object>> = {
  before?: Hook<(args: TArgs) => Partial<TArgs['state']> | void | Promise<Partial<TArgs['state']> | void>>
  authorize?: Hook<(args: Omit<TArgs, 'state'>) => Response | FileValidationIssue | void | Promise<Response | FileValidationIssue | void>>
  validate?: Hook<(args: TArgs) => FileValidationIssue | FileValidationIssue[] | void | Promise<FileValidationIssue | FileValidationIssue[] | void>>
  after?: Hook<(args: TArgs & { response: Response }) => Response | void | Promise<Response | void>>
  error?: Hook<(args: Omit<TArgs, 'state'> & { state?: TArgs['state']; error: unknown }) => Response | void | Promise<Response | void>>
}
type ScopeCurrent<TParent extends ScopeView<object, unknown>, TContext extends object, TEntity, TIdentity> = ScopeView<ScopeContext<TParent, TContext>, ScopeEntity<TParent, TEntity>, ScopePublicEntity<TParent, TEntity>, TIdentity>
type ScopeEnrich<TScope extends ScopeView<object, unknown>, TSchema extends z.ZodType> = { schema: TSchema; run: (record: EntityRecord<TScope>, args: FileRequestArgs<RouteParameters, TScope['context'], TScope['identity']>) => z.output<TSchema> | Promise<z.output<TSchema>> }
type EnrichedEntity<TEntity, TSchema extends z.ZodType> = TEntity extends { schemas: infer TSchemas } ? Omit<TEntity, 'schemas'> & { schemas: Omit<TSchemas, 'select'> & { select: TSchema } } : TEntity
export type FileScopeConfig<TParent extends ScopeView<object, unknown>, TParams extends RouteParameters, TContext extends object, TEntity, TSchema extends z.ZodType, TIdentity> = {
  context?: (args: FileRequestArgs<TParams, TParent['context'], TIdentity>) => TContext | Promise<TContext>
  identity?: (args: Pick<FileRequestArgs<TParams, TParent['context'], TParent['identity']>, 'c'>) => TIdentity | Promise<TIdentity>
  before?: FilePipeline<FileRouteArgs<TParams, ScopeCurrent<TParent, TContext, TEntity, TIdentity>['context'], {}, TIdentity>>['before']
  authorize?: FilePipeline<FileRouteArgs<TParams, ScopeCurrent<TParent, TContext, TEntity, TIdentity>['context'], {}, TIdentity>>['authorize']
  validate?: FilePipeline<FileRouteArgs<TParams, ScopeCurrent<TParent, TContext, TEntity, TIdentity>['context'], {}, TIdentity>>['validate']
  after?: FilePipeline<FileRouteArgs<TParams, ScopeCurrent<TParent, TContext, TEntity, TIdentity>['context'], {}, TIdentity>>['after']
  error?: FilePipeline<FileRouteArgs<TParams, ScopeCurrent<TParent, TContext, TEntity, TIdentity>['context'], {}, TIdentity>>['error']
  entity?: TEntity
  enrich?: ScopeEnrich<ScopeCurrent<TParent, TContext, TEntity, TIdentity>, TSchema>
}
export type FileRouteConfig<TParams extends RouteParameters, TContext extends object, TState extends object, TOutput, TIdentity = unknown> = FilePipeline<FileRouteArgs<TParams, TContext, TState, TIdentity>> & {
  openapi?: { requestBody?: unknown }; middleware?: MiddlewareHandler[]
  state?: (args: FileRequestArgs<TParams, TContext, TIdentity>) => TState | Promise<TState>
  action: (args: FileRouteArgs<TParams, TContext, TState, TIdentity>) => TOutput | Promise<TOutput>
}
export type FileRouteDefinition<TInput, TOutput, TKind extends string = 'route'> = { readonly input?: TInput; readonly output?: TOutput; readonly kind?: TKind }
export type DefineFileScope<TParent extends ScopeView<object, unknown>, TParams extends RouteParameters> = <TContext extends object = {}, TEntity = never, TSchema extends z.ZodType = never, TIdentity = TParent['identity']>(config: FileScopeConfig<TParent, TParams, TContext, TEntity, TSchema, TIdentity>) => ScopeView<ScopeContext<TParent, TContext>, ScopeEntity<TParent, TEntity>, [TSchema] extends [never] ? ScopePublicEntity<TParent, TEntity> : EnrichedEntity<ScopeEntity<TParent, TEntity>, TSchema>, TIdentity>
export type DefineFileRoute<TParent extends ScopeView, TParams extends RouteParameters> = <TState extends object = {}, TOutput = Response | object, TBody extends z.ZodType | undefined = undefined>(config: FileRouteConfig<TParams, TParent['context'], TState, TOutput, TParent['identity']> & { openapi?: { requestBody?: TBody } }) => FileRouteDefinition<TBody extends z.ZodType ? { json: z.input<TBody> } : unknown, Awaited<TOutput>>

export type ListState = { query: Record<string, unknown> & { page: number; limit: number }; where?: unknown }
export type DetailState = { id: string; where?: unknown }
export type CreateState<TInput> = { input: TInput; values: Partial<TInput> | undefined }
export type UpdateState<TInput> = { id: string; input: TInput; values: Partial<TInput> | undefined; where?: unknown }
export type DeleteState = DetailState
type RecordEnrich<TArgs, TRecord> = (record: TRecord, args: TArgs) => TRecord | void | Promise<TRecord | void>
export type DefineFileList<TParent extends ScopeView, TParams extends RouteParameters> = (config?: FilePipeline<FileRouteArgs<TParams, TParent['context'], ListState, TParent['identity']>> & {
  query?: { defaultSort?: string; enumFilters?: Record<string, readonly string[]> }
  enrich?: (rows: PublicEntityRecord<TParent>[], args: FileRouteArgs<TParams, TParent['context'], ListState, TParent['identity']>) => PublicEntityRecord<TParent>[] | void | Promise<PublicEntityRecord<TParent>[] | void>
  run?: (args: FileRouteArgs<TParams, TParent['context'], ListState, TParent['identity']>) => { data: EntityRecord<TParent>[]; total: number } | Promise<{ data: EntityRecord<TParent>[]; total: number }>
}) => FileRouteDefinition<unknown, { data: PublicEntityRecord<TParent>[]; page: number; limit: number; total: number }, 'list'>
export type DefineFileDetail<TParent extends ScopeView, TParams extends RouteParameters> = (config?: FilePipeline<FileRouteArgs<TParams, TParent['context'], DetailState, TParent['identity']>> & { param?: keyof TParams; enrich?: RecordEnrich<FileRouteArgs<TParams, TParent['context'], DetailState, TParent['identity']>, PublicEntityRecord<TParent>> }) => FileRouteDefinition<unknown, { data: PublicEntityRecord<TParent> } | { error: 'not_found' }, 'detail'>
export type DefineFileCreate<TParent extends ScopeView, TParams extends RouteParameters> = (config?: FilePipeline<FileRouteArgs<TParams, TParent['context'], CreateState<EntityCreateValue<TParent>>, TParent['identity']>> & { enrich?: RecordEnrich<FileRouteArgs<TParams, TParent['context'], CreateState<EntityCreateValue<TParent>>, TParent['identity']>, PublicEntityRecord<TParent>>; run?: (args: FileRouteArgs<TParams, TParent['context'], CreateState<EntityCreateValue<TParent>>, TParent['identity']>) => EntityRecord<TParent> | Promise<EntityRecord<TParent>> }) => FileRouteDefinition<EntityCreateInput<TParent>, { data: PublicEntityRecord<TParent> }, 'create'>
export type DefineFileUpdate<TParent extends ScopeView, TParams extends RouteParameters> = (config?: FilePipeline<FileRouteArgs<TParams, TParent['context'], UpdateState<EntityUpdateValue<TParent>>, TParent['identity']>> & { param?: keyof TParams; enrich?: RecordEnrich<FileRouteArgs<TParams, TParent['context'], UpdateState<EntityUpdateValue<TParent>>, TParent['identity']>, PublicEntityRecord<TParent>>; run?: (args: FileRouteArgs<TParams, TParent['context'], UpdateState<EntityUpdateValue<TParent>>, TParent['identity']>) => EntityRecord<TParent> | null | undefined | Promise<EntityRecord<TParent> | null | undefined> }) => FileRouteDefinition<EntityUpdateInput<TParent>, { data: PublicEntityRecord<TParent> } | { error: 'not_found' }, 'update'>
export type DefineFileDelete<TParent extends ScopeView, TParams extends RouteParameters> = (config?: FilePipeline<FileRouteArgs<TParams, TParent['context'], DeleteState, TParent['identity']>> & { param?: keyof TParams; run?: (args: FileRouteArgs<TParams, TParent['context'], DeleteState, TParent['identity']>) => void | Promise<void> }) => FileRouteDefinition<unknown, { ok: true } | { error: 'not_found' }, 'delete'>
export type FileResourceDefinition<TScope extends ScopeView, TKind extends string, TParams extends RouteParameters = RouteParameters> =
  TKind extends 'list' ? ReturnType<DefineFileList<TScope, TParams>> :
  TKind extends 'detail' ? ReturnType<DefineFileDetail<TScope, TParams>> :
  TKind extends 'create' ? ReturnType<DefineFileCreate<TScope, TParams>> :
  TKind extends 'update' ? ReturnType<DefineFileUpdate<TScope, TParams>> :
  TKind extends 'delete' ? ReturnType<DefineFileDelete<TScope, TParams>> : never
