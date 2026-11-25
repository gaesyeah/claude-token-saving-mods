/** ClaudeRipple model catalogue normalization and fail-open selection rules. */
export type ModelRole = 'judge' | 'light' | 'standard' | 'hard' | 'plan'
export type CatalogModel = { model: string; provider: string; name?: string; judgeOnly: boolean }
export type CatalogAgent = { name: string; model: string; provider: string }
export type ModelCatalog = { agents: CatalogAgent[]; models: CatalogModel[]; providers: { name: string; type?: string; usable: boolean }[]; presets: unknown; settings: unknown; zen: { configured: boolean; model: string } }
export type ResolvedModel = { model: string; provider: string | null; effort?: string; source: 'clauderipple' | 'fallback' }

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function normalizeModelCatalog(value: unknown, settings: unknown = null): ModelCatalog | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, any>
  if (!Array.isArray(data.models) || !Array.isArray(data.providers)) return null
  const agents = Array.isArray(data.agents) ? data.agents
    .filter((x: any) => x && typeof x.name === 'string' && typeof x.model === 'string' && typeof x.provider === 'string')
    .map((x: any) => ({ name: x.name, model: x.model, provider: x.provider })) : []
  const providers = data.providers.filter((x: any) => x && typeof x.name === 'string')
    .map((x: any) => ({ name: x.name, type: typeof x.type === 'string' ? x.type : undefined, usable: x.usable === true }))
  const usable = new Set(providers.filter(x => x.usable).map(x => x.name))
  const models = data.models.filter((x: any) => x && typeof x.model === 'string' && x.model.length > 0 && typeof x.provider === 'string' && usable.has(x.provider))
    .map((x: any) => ({ model: x.model, provider: x.provider, name: typeof x.name === 'string' ? x.name : undefined, judgeOnly: x.judgeOnly === true }))
  return { agents, models, providers, presets: data.presets && typeof data.presets === 'object' ? data.presets : {}, settings: settings ?? data.settings ?? null, zen: { configured: data.zen?.configured === true, model: typeof data.zen?.model === 'string' ? data.zen.model : '' } }
}

export type ModelCatalogLoaderDeps = {
  now(): Promise<number>
  readConfig(): Promise<unknown | null>
  fetch(port: number, endpoint: '/api/mod-options' | '/api/mod-settings'): Promise<{ ok: boolean; text: string }>
  within<T>(promise: Promise<T>, ms: number, what: string): Promise<T>
}

/** Loads ClaudeRipple's optional loopback catalogue and active worker ladder. */
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
        const data = config as Record<string, any>
        // ClaudeRipple's current config exposes the proxy port; its admin UI/API
        // listens on the immediately following port. Respect adminPort if present.
        const configuredPort = data.adminPort ?? (Number.isInteger(data.listen?.port) ? data.listen.port + 1 : NaN)
        const port = Number(configuredPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null
        const optionsResponse = await deps.within(deps.fetch(port, '/api/mod-options'), 1500, 'ClaudeRipple model catalogue')
        if (!optionsResponse.ok) return null
        let settings: unknown = null
        try {
          const settingsResponse = await deps.within(deps.fetch(port, '/api/mod-settings'), 1500, 'ClaudeRipple worker settings')
          if (settingsResponse.ok) settings = JSON.parse(settingsResponse.text)
        } catch {
          // The catalogue remains useful without settings; callers retain their fallbacks.
        }
        return normalizeModelCatalog(JSON.parse(optionsResponse.text), settings)
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

/** Resolve only explicit ladder entries and exact catalogue agent IDs; never infer from names. */
export function resolveModelFromCatalog(catalog: ModelCatalog | null, role: ModelRole, fallback: string): ResolvedModel {
  if (!catalog) return { model: fallback, provider: null, source: 'fallback' }
  if (role === 'judge') {
    const zen = catalog.zen.configured ? catalog.models.filter(x => x.model === catalog.zen.model) : []
    if (zen.length === 1) return { model: zen[0]!.model, provider: zen[0]!.provider, source: 'clauderipple' }
    const candidates = catalog.models.filter(x => x.judgeOnly)
    return candidates.length === 1 ? { model: candidates[0]!.model, provider: candidates[0]!.provider, source: 'clauderipple' } : { model: fallback, provider: null, source: 'fallback' }
  }

  const saved = catalog.settings && typeof catalog.settings === 'object' ? catalog.settings as Record<string, any> : null
  const settings = saved && saved.settings && typeof saved.settings === 'object' ? saved.settings as Record<string, any> : saved
  // Current API shape: settings.rules.general. Keep support for the earlier
  // flat ladder shape so older ClaudeRipple builds fail neither forward nor back.
  const general = settings?.rules?.general
  const ladder = general?.mode === 'ladder' && general.rungs && typeof general.rungs === 'object'
    ? general
    : settings?.mode === 'ladder' && settings.rungs && typeof settings.rungs === 'object' ? settings : null
  if (!ladder) return { model: fallback, provider: null, source: 'fallback' }

  const configured = ladder.rungs?.[role]
  const entries = Array.isArray(configured) ? configured : configured && typeof configured === 'object' ? [configured] : []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const target = entry.target
    let model = ''
    let provider = ''

    if (target && typeof target === 'object' && typeof target.agent === 'string') {
      // ClaudeRipple rules store an agent slug, not the provider model ID.
      const matches = catalog.agents.filter(x => x.name === target.agent)
      if (matches.length === 1) {
        model = matches[0]!.model
        provider = matches[0]!.provider
      }
    } else {
      model = typeof target === 'string' ? target : target && typeof target.model === 'string' ? target.model : ''
      provider = target && typeof target === 'object' && typeof target.provider === 'string' ? target.provider : ''
    }

    if (model) {
      const matches = catalog.models.filter(x => x.model === model && (!provider || x.provider === provider) && !x.judgeOnly)
      if (matches.length === 1) {
        const effort = typeof entry.effort === 'string' && EFFORTS.has(entry.effort) ? entry.effort : undefined
        return { model, provider: matches[0]!.provider, effort, source: 'clauderipple' }
      }
    }

    // Legacy ladder entries may specify a backup model directly.
    const backup = entry.backup
    const backupModel = typeof backup === 'string' ? backup : backup && typeof backup.model === 'string' ? backup.model : ''
    const backupProvider = backup && typeof backup === 'object' && typeof backup.provider === 'string' ? backup.provider : ''
    if (backupModel) {
      const matches = catalog.models.filter(x => x.model === backupModel && (!backupProvider || x.provider === backupProvider) && !x.judgeOnly)
      if (matches.length === 1) {
        const effort = typeof entry.effort === 'string' && EFFORTS.has(entry.effort) ? entry.effort : undefined
        return { model: backupModel, provider: matches[0]!.provider, effort, source: 'clauderipple' }
      }
    }
  }
  return { model: fallback, provider: null, source: 'fallback' }
}
