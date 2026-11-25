export type ModelResolution = { effort?: string; source: 'clauderipple' | 'fallback' }

/** Forward declared effort capabilities; keep the legacy low override only for fallback models. */
export function effortOptions(resolved: ModelResolution): { effort?: string } {
  if (resolved.effort) return { effort: resolved.effort }
  return resolved.source === 'fallback' ? { effort: 'low' } : {}
}
