import type { ModelUsage } from 'claude-code'
import { effortOptions } from './effort-options'

export type ModelResolution = {
  model: string
  provider?: string | null
  effort?: string
  source: 'clauderipple' | 'fallback'
}

type CompletionResult = { isAnswered?: boolean; reason?: string; usage?: ModelUsage }

type CompleteDeps<T extends CompletionResult> = {
  resolve(): Promise<ModelResolution>
  complete(request: Record<string, unknown>, options?: unknown): Promise<T>
  fallbackModel: string
  request: Record<string, unknown>
  options?: unknown
}

/** Provider-qualify ClaudeRipple models so its proxy selects the exact configured provider. */
export function modelForRequest(resolved: ModelResolution): string {
  if (resolved.source !== 'clauderipple' || !resolved.provider) return resolved.model
  const prefix = `${resolved.provider}:`
  return resolved.model.startsWith(prefix) ? resolved.model : `${prefix}${resolved.model}`
}

/** Run the helper completion through the resolved model, then retain the legacy alias retry. */
export async function completeWithResolvedModel<T extends CompletionResult>({
  resolve,
  complete,
  fallbackModel,
  request,
  options,
}: CompleteDeps<T>): Promise<{ model: string; result: T; attempts: Array<{ model: string; result: T }> }> {
  const attempts: Array<{ model: string; result: T }> = []
  try {
    const resolved = await resolve()
    const result = await complete({
      model: modelForRequest(resolved),
      ...effortOptions(resolved),
      ...request,
    }, options)
    attempts.push({ model: resolved.model, result })
    if (result.isAnswered || result.reason !== 'api-error') {
      return { model: resolved.model, result, attempts }
    }
  } catch {
    // The alias is the second try.
  }

  const result = await complete({ model: fallbackModel, ...request }, options)
  attempts.push({ model: fallbackModel, result })
  return { model: fallbackModel, result, attempts }
}
