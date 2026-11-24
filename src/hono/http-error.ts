import type { Context } from 'hono'
import { toHttpError } from '../errors'

export function httpErrorResponse(c: Context, error: unknown) {
  const httpError = toHttpError(error)
  if (!httpError) return undefined
  const { code, message, issues, status } = httpError
  return c.json({ error: code, message: message || undefined, issues }, status as 400)
}
