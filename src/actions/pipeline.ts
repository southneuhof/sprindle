import type { ActionHandlerArgs, ActionPipeline, ValidationIssue } from '../model/action-types'

export type PipelineContext = {
  pipeline?: ActionPipeline<ActionHandlerArgs>
}

export async function runActionPipeline<TArgs extends ActionHandlerArgs>(
  args: TArgs,
  modelPipeline: ActionPipeline<TArgs> | undefined,
  actionPipeline: ActionPipeline<TArgs> | undefined,
  handler: (args: TArgs) => Response | Promise<Response>,
) {
  try {
    await runBefore(args, modelPipeline)
    await runBefore(args, actionPipeline)

    const authResponse = (await runAuthorize(args, modelPipeline)) ?? (await runAuthorize(args, actionPipeline))
    if (authResponse) return authResponse

    const validationResponse = (await runValidate(args, modelPipeline)) ?? (await runValidate(args, actionPipeline))
    if (validationResponse) return validationResponse

    let response = await handler(args)
    response = (await runAfter(args, response, actionPipeline)) ?? response
    response = (await runAfter(args, response, modelPipeline)) ?? response
    return response
  } catch (error) {
    const response = (await runError(args, error, actionPipeline)) ?? (await runError(args, error, modelPipeline))
    if (response) return response
    throw error
  }
}

export function normalizePipeline<TArgs extends ActionHandlerArgs>(pipeline: ActionPipeline<TArgs> | undefined) {
  return pipeline as ActionPipeline<ActionHandlerArgs> | undefined
}

function list<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

async function runBefore<TArgs extends ActionHandlerArgs>(args: TArgs, pipeline: ActionPipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.before)) {
    const patch = await hook(args)
    if (patch) Object.assign(args.state, patch)
  }
}

async function runAuthorize<TArgs extends ActionHandlerArgs>(args: TArgs, pipeline: ActionPipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.authorize)) {
    const result = await hook(args)
    if (result instanceof Response) return result
    if (result) return args.c.json({ error: 'forbidden', issues: normalizeIssues(result) }, 403)
  }
  return undefined
}

async function runValidate<TArgs extends ActionHandlerArgs>(args: TArgs, pipeline: ActionPipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.validate)) {
    const result = await hook(args)
    if (result) return args.c.json({ error: 'validation_error', issues: normalizeIssues(result) }, 400)
  }
  return undefined
}

async function runAfter<TArgs extends ActionHandlerArgs>(args: TArgs, response: Response, pipeline: ActionPipeline<TArgs> | undefined) {
  let next = response
  for (const hook of list(pipeline?.after)) next = (await hook({ ...args, response: next })) ?? next
  return next
}

async function runError<TArgs extends ActionHandlerArgs>(args: TArgs, error: unknown, pipeline: ActionPipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.error)) {
    const response = await hook({ ...args, error })
    if (response) return response
  }
  return undefined
}

function normalizeIssues(issue: ValidationIssue | ValidationIssue[]) {
  const issues = Array.isArray(issue) ? issue : [issue]
  return issues.map((item) => (typeof item === 'string' ? { message: item } : item))
}
