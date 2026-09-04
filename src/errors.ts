export type ErrorIssue = { field?: string; message: string }

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly issues?: ErrorIssue[]

  constructor(status: number, code: string, message?: string, issues?: ErrorIssue[]) {
    // No message means no `message` key in the envelope; the code carries the meaning.
    super(message ?? '')
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.issues = issues
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError
}

export function validationError(messageOrIssues: string | ErrorIssue[]) {
  return typeof messageOrIssues === 'string'
    ? new HttpError(400, 'validation_error', messageOrIssues)
    : new HttpError(400, 'validation_error', undefined, messageOrIssues)
}

/**
 * Maps an unknown thrown value onto the contract: HttpErrors pass through and
 * schema (Zod) failures become 400 validation errors. Everything else is not
 * ours to render.
 */
export function toHttpError(error: unknown): HttpError | undefined {
  if (isHttpError(error)) return error
  if (!isSchemaError(error)) return undefined
  return validationError(
    error.issues.map((issue) => {
      const field = Array.isArray(issue.path) ? issue.path.join('.') : undefined
      return field ? { field, message: issue.message } : { message: issue.message }
    }),
  )
}

type SchemaError = { issues: { path?: unknown[]; message: string }[] }

function isSchemaError(value: unknown): value is SchemaError {
  return Boolean(
    value instanceof Error &&
      value.name === 'ZodError' &&
      Array.isArray((value as unknown as SchemaError).issues) &&
      (value as unknown as SchemaError).issues.every((issue) => typeof issue?.message === 'string'),
  )
}

export function unauthorized(message?: string) {
  return new HttpError(401, 'unauthorized', message)
}

export function forbidden(message?: string) {
  return new HttpError(403, 'forbidden', message)
}

export function notFound(message?: string) {
  return new HttpError(404, 'not_found', message)
}
