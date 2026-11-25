import { effortOptions } from './effort-options'

export type CompletionResolution = {
  model: string
  provider?: string | null
  effort?: string
  source: 'clauderipple' | 'fallback'
}

/** Provider-qualify ClaudeRipple models so its proxy selects the exact configured provider. */
export function modelForRequest(resolved: CompletionResolution): string {
  if (resolved.source !== 'clauderipple' || !resolved.provider) return resolved.model
  const prefix = `${resolved.provider}:`
  return resolved.model.startsWith(prefix) ? resolved.model : `${prefix}${resolved.model}`
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
  return completeWithModel(complete, modelForRequest(resolved), request, options.effort)
}
