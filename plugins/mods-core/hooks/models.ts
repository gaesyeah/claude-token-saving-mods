/** ClaudeRipple model catalogue normalization and fail-open selection rules. */
export type ModelRole = 'judge' | 'light' | 'standard' | 'hard' | 'plan'
export type CatalogModel = { model: string; provider: string; name?: string; judgeOnly: boolean }
export type ModelCatalog = { models: CatalogModel[]; providers: { name: string; type?: string; usable: boolean }[]; presets: unknown; settings: unknown; zen: { configured: boolean; model: string } }
export type ResolvedModel = { model: string; provider: string | null; effort?: string; source: 'clauderipple' | 'fallback' }

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function normalizeModelCatalog(value: unknown, settings: unknown = null): ModelCatalog | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, any>
  if (!Array.isArray(data.models) || !Array.isArray(data.providers)) return null
  const providers = data.providers.filter((x: any) => x && typeof x.name === 'string')
    .map((x: any) => ({ name: x.name, type: typeof x.type === 'string' ? x.type : undefined, usable: x.usable === true }))
  const usable = new Set(providers.filter(x => x.usable).map(x => x.name))
  const models = data.models.filter((x: any) => x && typeof x.model === 'string' && x.model.length > 0 && typeof x.provider === 'string' && usable.has(x.provider))
    .map((x: any) => ({ model: x.model, provider: x.provider, name: typeof x.name === 'string' ? x.name : undefined, judgeOnly: x.judgeOnly === true }))
  return { models, providers, presets: data.presets && typeof data.presets === 'object' ? data.presets : {}, settings: settings ?? data.settings ?? null, zen: { configured: data.zen?.configured === true, model: typeof data.zen?.model === 'string' ? data.zen.model : '' } }
}

export type ModelCatalogLoaderDeps = {
  now(): Promise<number>
  readConfig(): Promise<unknown | null>
  readSettings(): Promise<unknown | null>
  fetch(port: number): Promise<{ ok: boolean; text: string }>
  within<T>(promise: Promise<T>, ms: number, what: string): Promise<T>
}

/** Loads ClaudeRipple's optional local catalogue; failures are cached briefly and fail open. */
export function createModelCatalogLoader(deps: ModelCatalogLoaderDeps): () => Promise<ModelCatalog | null> {
  let cache: { at: number; value: ModelCatalog | null } | null = null
  let pending: Promise<ModelCatalog | null> | null = null
  return async () => {
    const now = await deps.now()
    if (cache && now - cache.at < 15_000) return cache.value
    if (pending) return pending
    const request = (async () => {
      try {
        const config = await deps.readConfig()
        if (!config || typeof config !== 'object' || Array.isArray(config)) return null
        const port = Number((config as Record<string, unknown>).adminPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null
        const response = await deps.within(deps.fetch(port), 1500, 'ClaudeRipple model catalogue')
        if (!response.ok) return null
        const settings = await deps.readSettings().catch(() => null)
        return normalizeModelCatalog(JSON.parse(response.text), settings)
      } catch {
        return null
      }
    })()
    pending = request
    try {
      const value = await request
      cache = { at: await deps.now(), value }
      return value
    } finally {
      // Keep the in-flight promise visible until its result is cached. Otherwise a
      // caller arriving in this small gap can start a duplicate HTTP request.
      if (pending === request) pending = null
    }
  }
}

/** Only explicit preset targets are accepted; names and marketing labels are never heuristics. */
export function resolveModelFromCatalog(catalog: ModelCatalog | null, role: ModelRole, fallback: string): ResolvedModel {
  if (!catalog) return { model: fallback, provider: null, source: 'fallback' }
  if (role === 'judge') {
    const zen = catalog.zen.configured ? catalog.models.filter(x => x.model === catalog.zen.model) : []
    if (zen.length === 1) return { model: zen[0]!.model, provider: zen[0]!.provider, source: 'clauderipple' }
    const candidates = catalog.models.filter(x => x.judgeOnly)
    return candidates.length === 1 ? { model: candidates[0]!.model, provider: candidates[0]!.provider, source: 'clauderipple' } : { model: fallback, provider: null, source: 'fallback' }
  }
  // Prefer the user's persisted global ladder, not the first of several available presets.
  // A named preset is accepted only when the settings explicitly select its exact key.
  const saved = catalog.settings && typeof catalog.settings === 'object' ? catalog.settings as Record<string, any> : null
  const settings = saved && saved.settings && typeof saved.settings === 'object' ? saved.settings as Record<string, any> : saved
  let ladder: any = settings && settings.mode === 'ladder' && settings.rungs && typeof settings.rungs === 'object' ? settings : null
  if (!ladder && settings && typeof settings.preset === 'string' && catalog.presets && typeof catalog.presets === 'object') {
    const selected = (catalog.presets as Record<string, any>)[settings.preset]
    if (selected && typeof selected === 'object') ladder = selected.rungs && typeof selected.rungs === 'object' ? selected : selected
  }
  if (!ladder) return { model: fallback, provider: null, source: 'fallback' }
  const rung = ladder.rungs?.[role]
  if (!rung || typeof rung !== 'object') return { model: fallback, provider: null, source: 'fallback' }
  const readTarget = (target: any) => {
    const model = typeof target === 'string' ? target : target && typeof target.model === 'string' ? target.model : ''
    const provider = target && typeof target === 'object' && typeof target.provider === 'string' ? target.provider : ''
    if (!model) return null
    // judgeOnly models are reserved for the judge and must never run worker tasks.
    const matches = catalog.models.filter(x => x.model === model && (!provider || x.provider === provider) && !x.judgeOnly)
    return matches.length === 1 ? { model, provider: matches[0]!.provider } : null
  }
  const selected = readTarget(rung.target) ?? readTarget(rung.backup)
  const effort = typeof rung.effort === 'string' && EFFORTS.has(rung.effort) ? rung.effort : undefined
  if (selected) return { ...selected, effort, source: 'clauderipple' }
  return { model: fallback, provider: null, source: 'fallback' }
}
