import type { ResolvedModel } from './models'

export type CompletionResult = { isAnswered?: boolean; reason?: string; status?: number; error?: unknown; usage?: unknown }
export type ModelAttempt<T> = { model: string; result?: T; error?: string }

export function requestModel(candidate: ResolvedModel): string {
  if (candidate.source !== 'clauderipple' || !candidate.provider) return candidate.model
  const prefix = `${candidate.provider}:`
  return candidate.model.startsWith(prefix) ? candidate.model : `${prefix}${candidate.model}`
}

const retryable = (error: unknown) => /(?:^|\D)(?:429|502|503|504)(?:\D|$)|rate.?limit|quota|overload|temporarily unavailable|capacity|timeout|timed out|ECONNRESET|ETIMEDOUT|model_not_selectable|model unavailable/i.test(String(error))
const aborted = (error: unknown, options: unknown): boolean =>
  (options as { signal?: { aborted?: boolean } } | undefined)?.signal?.aborted === true ||
  (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' && /abort/i.test(error.message)))

function retryableResponse(result: CompletionResult): boolean {
  if (result.reason === 'timeout') return true
  if (result.reason === 'api-error') {
    const status = Number(result.status)
    if (result.status !== undefined && Number.isInteger(status) && status >= 400 && status < 500 && ![408, 429].includes(status)) {
      return retryable(result.error)
    }
    return true // Older engines report only the generic api-error reason.
  }
  return retryable(result.reason)
}

/** Bounded failover for helpers. Only retry unavailable models, never aborted or malformed calls. */
export async function completeWithFallback<T extends CompletionResult>({
  candidates, complete, request, options, onAttempt,
}: {
  candidates: ResolvedModel[]
  complete(input: Record<string, unknown>, options?: unknown): Promise<T>
  request: Record<string, unknown>
  options?: unknown
  onAttempt?(attempt: ModelAttempt<T>): Promise<void>
}): Promise<{ model: string; result: T; attempts: ModelAttempt<T>[] }> {
  const attempts: ModelAttempt<T>[] = []
  let lastError: unknown
  for (const candidate of candidates.slice(0, 8)) {
    if ((options as { signal?: { aborted?: boolean } } | undefined)?.signal?.aborted) throw new Error('Model call aborted')
    const model = requestModel(candidate)
    try {
      const input = { ...Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'model' && key !== 'effort')), model, ...(candidate.effort ? { effort: candidate.effort } : candidate.source === 'fallback' ? { effort: 'low' } : {}) }
      const result = await complete(input, options)
      const attempt: ModelAttempt<T> = { model: candidate.model, result }
      attempts.push(attempt)
      if (onAttempt) await onAttempt(attempt).catch(() => undefined)
      if (result.isAnswered || !retryableResponse(result)) return { model: candidate.model, result, attempts }
      lastError = undefined
    } catch (error) {
      if (aborted(error, options) || !retryable(error)) throw error
      lastError = error
      attempts.push({ model: candidate.model, error: String(error) })
    }
  }
  const last = attempts[attempts.length - 1]
  if (last?.result) return { model: last.model, result: last.result, attempts }
  throw lastError ?? new Error('No available helper model')
}
