import { effortOptions } from './effort-options'

export type CompletionResolution = {
  model: string
  effort?: string
  source: 'clauderipple' | 'fallback'
}

/** Keep the model and effort passed to the engine in one tested completion boundary. */
export function completeWithEffort<T>(
  complete: (request: Record<string, unknown>) => Promise<T>,
  resolved: CompletionResolution,
  request: Record<string, unknown>,
): Promise<T> {
  return complete({
    model: resolved.model,
    ...effortOptions(resolved),
    ...request,
  })
}
