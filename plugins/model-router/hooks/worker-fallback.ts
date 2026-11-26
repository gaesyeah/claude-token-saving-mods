/** Proxy-side fallback for a subagent when the Ripple UI's worker-routing mod is disabled.
 * ClaudeRipple validates every target against its current saved allow-list and rungs.
 * This is an opt-in compatibility boundary with its current ladder metadata format.
 */
export type WorkerCandidate = { model: string; provider: string | null; effort?: string; source: 'clauderipple' | 'fallback' }

export function workerRequestModel(candidate: WorkerCandidate): string {
  return candidate.provider && candidate.source === 'clauderipple' && !candidate.model.startsWith(`${candidate.provider}:`)
    ? `${candidate.provider}:${candidate.model}` : candidate.model
}

export function workerFallbackLine(pick: string, primary: string, candidates: WorkerCandidate[]): string | null {
  if (!/^[\w-]{1,100}$/.test(pick)) return null
  if (!candidates.length || candidates[0]!.source !== 'clauderipple' || workerRequestModel(candidates[0]!) !== primary) return null
  const seen = new Set([primary, primary.replace(/@[a-z]+$/, '')])
  const fallbacks: string[] = []
  for (const candidate of candidates.slice(1)) {
    if (candidate.source !== 'clauderipple') continue
    const model = workerRequestModel(candidate)
    if (!model || seen.has(model) || seen.has(model.replace(/@[a-z]+$/, ''))) continue
    seen.add(model)
    seen.add(model.replace(/@[a-z]+$/, ''))
    fallbacks.push(`${model}${candidate.effort ? `@${candidate.effort}` : ''}`)
  }
  if (!fallbacks.length) return null
  return `<!-- clauderipple-ladder ${encodeURIComponent(JSON.stringify({ pick, model: primary, fallbacks }))} -->`
}
