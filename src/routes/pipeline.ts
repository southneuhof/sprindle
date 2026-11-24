import type { RouteAuthorizeArgs, RouteErrorArgs, RouteHandlerArgs, RoutePipeline, ValidationIssue } from '../model/route-types'

function list<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

export async function runBefore<TArgs extends RouteHandlerArgs>(args: TArgs, pipeline: RoutePipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.before)) {
    const patch = await hook(args)
    if (patch) Object.assign(args.state, patch)
  }
}

export async function runAuthorize<TArgs extends RouteHandlerArgs>(args: RouteAuthorizeArgs<TArgs>, pipeline: RoutePipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.authorize)) {
    const result = await hook(args)
    if (result instanceof Response) return result
    if (result) return args.c.json({ error: 'forbidden', issues: normalizeIssues(result) }, 403)
  }
  return undefined
}

export async function runValidate<TArgs extends RouteHandlerArgs>(args: TArgs, pipeline: RoutePipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.validate)) {
    const result = await hook(args)
    if (result) return args.c.json({ error: 'validation_error', issues: normalizeIssues(result) }, 400)
  }
  return undefined
}

export async function runAfter<TArgs extends RouteHandlerArgs>(args: TArgs, response: Response, pipeline: RoutePipeline<TArgs> | undefined) {
  let next = response
  for (const hook of list(pipeline?.after)) next = (await hook({ ...args, response: next })) ?? next
  return next
}

export async function runError<TArgs extends RouteHandlerArgs>(args: RouteErrorArgs<TArgs>, pipeline: RoutePipeline<TArgs> | undefined) {
  for (const hook of list(pipeline?.error)) {
    const response = await hook(args)
    if (response) return response
  }
  return undefined
}

function normalizeIssues(issue: ValidationIssue | ValidationIssue[]) {
  const issues = Array.isArray(issue) ? issue : [issue]
  return issues.map((item) => (typeof item === 'string' ? { message: item } : item))
}
