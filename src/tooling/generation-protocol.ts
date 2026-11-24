export type GenerationRequest = {
  projectRoot: string
  routesDirectory: string
  output: string
  bundle: boolean
  dependencyInputs: string[]
}

export type GenerationDependencies = { type: 'dependencies'; dependencyInputs: string[] }

export type GenerationResponse =
  | { type: 'result'; ok: true; target: string; dependencyInputs: string[] }
  | { type: 'result'; ok: false; error: { message: string; stack?: string }; dependencyInputs: string[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isGenerationRequest(value: unknown): value is GenerationRequest {
  return isObject(value)
    && typeof value.projectRoot === 'string'
    && typeof value.routesDirectory === 'string'
    && typeof value.output === 'string'
    && typeof value.bundle === 'boolean'
    && isStringArray(value.dependencyInputs)
}

export function isGenerationDependencies(value: unknown): value is GenerationDependencies {
  return isObject(value) && value.type === 'dependencies' && isStringArray(value.dependencyInputs)
}

export function hasGenerationResultEnvelope(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.type === 'result' && isStringArray(value.dependencyInputs)
}

export function isGenerationResponse(value: unknown): value is GenerationResponse {
  return hasGenerationResultEnvelope(value)
    && (value.ok === true && typeof value.target === 'string'
      || value.ok === false
        && isObject(value.error)
        && typeof value.error.message === 'string'
        && (value.error.stack === undefined || typeof value.error.stack === 'string'))
}
