import type { RouteHandlerArgs, RoutePipeline, ValidationIssue } from '../model/route-types'

export type PipelineContext = {
  pipeline?: RoutePipeline<RouteHandlerArgs>
}

export async function runRoutePipeline<TArgs extends RouteHandlerArgs>(
  args: TArgs,
  modelPipeline: RoutePipeline<TArgs> | undefined,
  routePipeline: RoutePipeline<TArgs> | undefined,
  action: (args: TArgs) => Response | Promise<Response>,
) {
  try {
    await runBefore(args, modelPipeline)
    await runBefore(args, routePipeline)

    const authResponse = (await runAuthorize(args, modelPipeline)) ?? (await runAuthorize(args, routePipeline))
    if (authResponse) return authResponse

    const validationResponse = (await runValidate(args, modelPipeline)) ?? (await runValidate(args, routePipeline))
    if (validationResponse) return validationResponse

    let response = await action(args)
    response = (await runAfter(args, response, routePipeline)) ?? response
    response = (await runAfter(args, response, modelPipeline)) ?? response
    return response
  } catch (error) {
    const response = (await runError(args, error, routePipeline)) ?? (await runError(args, error, modelPipeline))
    if (response) return response
    throw error
  }
}

export function normalizePipeline<TArgs extends RouteHandlerArgs>(pipeline: RoutePipeline<TArgs> | undefined) {
  return pipeline as RoutePipeline<RouteHandlerArgs> | undefined
}

function list<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

async function runBefore<TArgs extends RouteHandlerArgs>(args: TArgs, pipeline: RoutePipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.before)) {
    const patch = await hook(args)
    if (patch) Object.assign(args.state, patch)
  }
}

async function runAuthorize<TArgs extends RouteHandlerArgs>(args: TArgs, pipeline: RoutePipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.authorize)) {
    const result = await hook(args)
    if (result instanceof Response) return result
    if (result) return args.c.json({ error: 'forbidden', issues: normalizeIssues(result) }, 403)
  }
  return undefined
}

async function runValidate<TArgs extends RouteHandlerArgs>(args: TArgs, pipeline: RoutePipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.validate)) {
    const result = await hook(args)
    if (result) return args.c.json({ error: 'validation_error', issues: normalizeIssues(result) }, 400)
  }
  return undefined
}

async function runAfter<TArgs extends RouteHandlerArgs>(args: TArgs, response: Response, pipeline: RoutePipeline<TArgs> | undefined) {
  let next = response
  for (const hook of list(pipeline?.after)) next = (await hook({ ...args, response: next })) ?? next
  return next
}

async function runError<TArgs extends RouteHandlerArgs>(args: TArgs, error: unknown, pipeline: RoutePipeline<TArgs> | undefined) {
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
