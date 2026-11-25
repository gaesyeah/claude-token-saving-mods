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

/** Keep the model and effort passed to the engine in one tested completion boundary. */
export function completeWithEffort<T>(
  complete: (request: Record<string, unknown>) => Promise<T>,
  resolved: CompletionResolution,
  request: Record<string, unknown>,
): Promise<T> {
  return complete({
    model: modelForRequest(resolved),
    ...effortOptions(resolved),
    ...request,
  })
}
