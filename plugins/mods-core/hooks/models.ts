/** ClaudeRipple model catalogue normalization and fail-open selection rules. */
export type ModelRole = 'judge' | 'light' | 'standard' | 'hard' | 'plan'
export type CatalogAgent = { name: string; model: string; provider: string; efforts: string[] }
export type CatalogModel = { model: string; provider: string; name?: string; judgeOnly: boolean }
export type CatalogProvider = { name: string; type?: string; usable: boolean; models: Record<string, unknown> }
export type ModelCatalog = {
  agents: CatalogAgent[]
  models: CatalogModel[]
  providers: CatalogProvider[]
  presets: unknown
  settings: unknown
  zen: { configured: boolean; model: string }
  claudeEfforts: string[]
  claudeLatest: Record<string, string>
}
export type ResolvedModel = { model: string; provider: string | null; effort?: string; source: 'clauderipple' | 'fallback' }

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []

export function adminPortFromConfig(value: unknown): number | null {
  const config = record(value)
  const configured = config.admin?.port ?? (Number.isInteger(config.listen?.port) ? config.listen.port + 1 : NaN)
  const port = Number(configured)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

export function normalizeModelCatalog(value: unknown, settings: unknown = null): ModelCatalog | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, any>
  if (!Array.isArray(data.models) || !Array.isArray(data.providers)) return null
  const agents: CatalogAgent[] = Array.isArray(data.agents) ? data.agents
    .filter((x: any) => x && typeof x.name === 'string' && typeof x.model === 'string' && typeof x.provider === 'string')
    .map((x: any) => ({ name: x.name, model: x.model, provider: x.provider, efforts: strings(x.efforts).filter(e => EFFORTS.has(e)) })) : []
  const providers: CatalogProvider[] = data.providers.filter((x: any) => x && typeof x.name === 'string')
    .map((x: any) => ({
      name: x.name,
      type: typeof x.type === 'string' ? x.type : undefined,
      usable: x.usable === true,
      models: record(x.models),
    }))
  const usable = new Set(providers.filter(x => x.usable).map(x => x.name))
  const models = data.models.filter((x: any) =>
    x && typeof x.model === 'string' && x.model.length > 0 &&
    typeof x.provider === 'string' && usable.has(x.provider))
    .map((x: any) => ({
      model: x.model,
      provider: x.provider,
      name: typeof x.name === 'string' ? x.name : undefined,
      judgeOnly: x.judgeOnly === true,
    }))
  const zenModel = typeof data.zen?.model === 'string' ? data.zen.model : ''
  const zenMatches = models.filter(x => x.model === zenModel || x.model === `${x.provider}:${zenModel}`)
  return {
    agents, models, providers,
    presets: data.presets && typeof data.presets === 'object' ? data.presets : {},
    settings: settings ?? data.settings ?? null,
    zen: { configured: data.zen?.configured === true, model: zenMatches.length === 1 ? zenMatches[0]!.model : zenModel },
    claudeEfforts: strings(data.claudeEfforts).filter(e => EFFORTS.has(e)),
    claudeLatest: Object.fromEntries(Object.entries(record(data.claudeLatest)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  }
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
        const port = adminPortFromConfig(config)
        if (port === null) return null
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
      if (pending === request) pending = null
    }
  }
}

function effectiveSettings(catalog: ModelCatalog): Record<string, any> {
  const response = record(catalog.settings)
  const settings = response.settings && typeof response.settings === 'object' ? record(response.settings) : response
  const activeMode = typeof settings.activeMode === 'string'
    ? (Array.isArray(settings.modes) ? settings.modes.find((m: any) => m?.id === settings.activeMode) : undefined)
    : undefined
  return {
    ...settings,
    effectiveRungs: activeMode?.rungs ?? settings.rules?.general?.rungs ?? settings.rungs,
  }
}

function allowed(agent: string, provider: string, settings: Record<string, any>): boolean {
  const allow = strings(settings.allow)
  const known = strings(settings.allowKnown)
  return !allow.length || allow.includes(agent) || allow.includes(provider) || (known.length > 0 && !known.includes(agent))
}

function providerFor(catalog: ModelCatalog, provider: string): CatalogProvider | undefined {
  return catalog.providers.find(x => x.name === provider)
}

function modelEntry(catalog: ModelCatalog, model: string, provider: string): CatalogModel | undefined {
  const matches = catalog.models.filter(x =>
    x.provider === provider && (x.model === model || x.model === `${provider}:${model}`))
  return matches.length === 1 ? matches[0] : undefined
}

function providerModelUnavailable(provider: CatalogProvider, model: string): boolean {
  const entries = provider.models
  return Boolean(entries[model] ?? entries[`${provider.name}:${model}`])
}

function effortFor(entry: any, agent: CatalogAgent | undefined, catalog: ModelCatalog, native = false): string | undefined {
  const effort = typeof entry?.effort === 'string' && EFFORTS.has(entry.effort) ? entry.effort : undefined
  if (!effort) return undefined
  const supported = native ? catalog.claudeEfforts : agent?.efforts ?? []
  // Empty means ClaudeRipple has no declared capability data; do not send an unverified effort.
  return supported.includes(effort) ? effort : undefined
}

function resolveAgentTarget(catalog: ModelCatalog, settings: Record<string, any>, target: any, entry: any): ResolvedModel | null {
  if (!target || typeof target !== 'object' || typeof target.agent !== 'string') return null
  const agentName = target.agent

  if (agentName === 'general-purpose') {
    const alias = typeof target.model === 'string' && target.model ? target.model : 'sonnet'
    const latest = catalog.claudeLatest[alias]
    const provider = providerFor(catalog, 'anthropic')
    if (!latest || (settings.providers?.anthropic === false) || !allowed(`general-purpose:${alias}`, 'anthropic', settings)) return null
    if (provider && !provider.usable) return null
    return { model: latest, provider: 'anthropic', effort: effortFor(entry, undefined, catalog, true), source: 'clauderipple' }
  }

  const agents = catalog.agents.filter(x => x.name === agentName)
  if (agents.length !== 1) return null
  const agent = agents[0]!
  const provider = providerFor(catalog, agent.provider)
  if (!provider?.usable || settings.providers?.[agent.provider] === false) return null
  if (!allowed(agentName, agent.provider, settings)) return null
  const model = modelEntry(catalog, agent.model, agent.provider)
  if (!model || model.judgeOnly || providerModelUnavailable(provider, agent.model)) return null
  return { model: agent.model, provider: agent.provider, effort: effortFor(entry, agent, catalog), source: 'clauderipple' }
}

function resolveLegacyModel(catalog: ModelCatalog, settings: Record<string, any>, raw: unknown, entry: any): ResolvedModel | null {
  const model = typeof raw === 'string' ? raw : record(raw).model
  const providerName = typeof record(raw).provider === 'string' ? record(raw).provider : ''
  if (typeof model !== 'string' || !model) return null
  const matches = catalog.models.filter(x => x.model === model && (!providerName || x.provider === providerName) && !x.judgeOnly)
  if (matches.length !== 1) return null
  const provider = providerFor(catalog, matches[0]!.provider)
  if (!provider?.usable || settings.providers?.[provider.name] === false || providerModelUnavailable(provider, model)) return null
  if (!allowed(model, provider.name, settings)) return null
  return { model, provider: provider.name, effort: effortFor(entry, undefined, catalog), source: 'clauderipple' }
}

/** Resolve only explicit ClaudeRipple entries and exact catalogue IDs; never infer from names. */
export function resolveModelFromCatalog(catalog: ModelCatalog | null, role: ModelRole, fallback: string): ResolvedModel {
  if (!catalog) return { model: fallback, provider: null, source: 'fallback' }
  const settings = effectiveSettings(catalog)
  if (role === 'judge') {
    const zen = catalog.zen.configured
      ? catalog.models.filter(x => x.model === catalog.zen.model || x.model.endsWith(`:${catalog.zen.model}`))
      : []
    const zenUsable = zen.filter(x => settings.providers?.[x.provider] !== false && !providerModelUnavailable(providerFor(catalog, x.provider)!, x.model))
    if (zenUsable.length === 1) return { model: zenUsable[0]!.model, provider: zenUsable[0]!.provider, source: 'clauderipple' }
    const candidates = catalog.models.filter(x => x.judgeOnly && settings.providers?.[x.provider] !== false)
    return candidates.length === 1 ? { model: candidates[0]!.model, provider: candidates[0]!.provider, source: 'clauderipple' } : { model: fallback, provider: null, source: 'fallback' }
  }

  const rungs = settings.effectiveRungs
  if (!rungs || typeof rungs !== 'object') return { model: fallback, provider: null, source: 'fallback' }
  const configured = rungs[role]
  const entries = Array.isArray(configured) ? configured : configured && typeof configured === 'object' ? [configured] : []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const resolved = resolveAgentTarget(catalog, settings, entry.target, entry)
      ?? resolveLegacyModel(catalog, settings, entry.target, entry)
    if (resolved) return resolved

    const backup = entry.backup
    const backupResolved = backup && typeof backup === 'object' && typeof backup.agent === 'string'
      ? resolveAgentTarget(catalog, settings, backup, entry)
      : resolveLegacyModel(catalog, settings, backup, entry)
    if (backupResolved) return backupResolved
  }
  return { model: fallback, provider: null, source: 'fallback' }
}
