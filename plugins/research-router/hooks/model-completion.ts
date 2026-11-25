import { effortOptions } from './effort-options'

export type CompletionResolution = {
  model: string
  effort?: string
  source: 'clauderipple' | 'fallback'
}

/** Keep the model and optional declared effort passed to the engine in one tested boundary. */
export function completeWithModel<T>(
  complete: (request: Record<string, unknown>) => Promise<T>,
  model: string,
  request: Record<string, unknown>,
  effort?: string,
): Promise<T> {
  return complete({
    model,
    ...(effort ? { effort } : {}),
    ...request,
  })
}

export function completeWithEffort<T>(
  complete: (request: Record<string, unknown>) => Promise<T>,
  resolved: CompletionResolution,
  request: Record<string, unknown>,
): Promise<T> {
  const options = effortOptions(resolved)
  return completeWithModel(complete, resolved.model, request, options.effort)
}
