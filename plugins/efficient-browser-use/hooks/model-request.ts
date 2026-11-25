export type ResolvedModel = { model: string; provider: string | null; source: 'clauderipple' | 'fallback' }

/** Provider-qualify ClaudeRipple models so its proxy selects the exact configured provider. */
export function modelForRequest(resolved: ResolvedModel): string {
  if (resolved.source !== 'clauderipple' || !resolved.provider) return resolved.model
  const prefix = `${resolved.provider}:`
  return resolved.model.startsWith(prefix) ? resolved.model : `${prefix}${resolved.model}`
}
