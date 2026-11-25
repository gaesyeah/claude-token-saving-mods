import { expect, test } from 'claude-code/testing'
import { adminPortFromConfig, createModelCatalogLoader, normalizeModelCatalog, resolveModelFromCatalog } from './models'

const fixture = (overrides: Record<string, unknown> = {}) => normalizeModelCatalog({
  providers: [{ name: 'openai', type: 'openai', usable: true }, { name: 'offline', usable: false }],
  models: [
    { model: 'judge-model', provider: 'openai', judgeOnly: true },
    { model: 'not-usable', provider: 'offline', judgeOnly: true },
    { model: 'worker-model', provider: 'openai', judgeOnly: false },
  ],
  presets: { coding: { rungs: { light: { target: { provider: 'openai', model: 'worker-model' }, effort: 'low' } } } },
  settings: { mode: 'ladder', rungs: { light: { target: { provider: 'openai', model: 'worker-model' }, effort: 'low' } } },
  ...overrides,
})

test('catalogue excludes models from unavailable providers', () => {
  const catalog = fixture()!
  expect(catalog.models.map(x => x.model)).toEqual(['judge-model', 'worker-model'])
})

test('judge resolves configured Zen or a unique usable judgeOnly model only', () => {
  expect(resolveModelFromCatalog(fixture(), 'judge', 'legacy-judge').model).toBe('judge-model')
  const ambiguous = normalizeModelCatalog({ providers: [{ name: 'p', usable: true }], models: [{ model: 'a', provider: 'p', judgeOnly: true }, { model: 'b', provider: 'p', judgeOnly: true }] })
  expect(resolveModelFromCatalog(ambiguous, 'judge', 'legacy-judge').model).toBe('legacy-judge')
  const zen = normalizeModelCatalog({ providers: [{ name: 'p', usable: true }], models: [{ model: 'a', provider: 'p', judgeOnly: true }, { model: 'b', provider: 'p', judgeOnly: true }], zen: { configured: true, model: 'b' } })
  expect(resolveModelFromCatalog(zen, 'judge', 'legacy-judge').model).toBe('b')
})

test('worker resolves only the active explicit ladder rung and leaves undeclared effort unset', () => {
  const resolved = resolveModelFromCatalog(fixture(), 'light', 'legacy-light')
  expect(resolved).toEqual({ model: 'worker-model', provider: 'openai', effort: undefined, source: 'clauderipple' })
  expect(resolveModelFromCatalog(fixture(), 'hard', 'legacy-deep').model).toBe('legacy-deep')
  const noSettings = normalizeModelCatalog({ providers: [{ name: 'p', usable: true }], models: [{ model: 'worker-model', provider: 'p' }], presets: { coding: { rungs: { light: { target: 'worker-model' } } } } })
  expect(resolveModelFromCatalog(noSettings, 'light', 'legacy-light').model).toBe('legacy-light')
})

test('current ClaudeRipple ladder resolves exact agent IDs and tries ordered entries', () => {
  const catalog = normalizeModelCatalog({
    agents: [{ name: 'qwen2-5-3b', model: 'qwen2.5:3b', provider: 'ollama-local', efforts: [], billing: 'free' }],
    providers: [{ name: 'ollama-local', type: 'openai-compatible', usable: true }],
    models: [{ model: 'qwen2.5:3b', provider: 'ollama-local', name: 'qwen2.5:3b', judgeOnly: false }],
  }, {
    settings: {
      rules: { general: { mode: 'ladder', rungs: {
        light: [
          { target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' },
          { target: { agent: 'qwen2-5-3b' }, effort: 'medium' },
        ],
      } } },
    },
    revision: 0,
    stored: false,
  })
  expect(catalog?.agents).toEqual([{ name: 'qwen2-5-3b', model: 'qwen2.5:3b', provider: 'ollama-local', efforts: [] }])
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy-light')).toEqual({
    model: 'qwen2.5:3b', provider: 'ollama-local', effort: undefined, source: 'clauderipple',
  })
})

test('agent IDs must resolve uniquely to a usable non-judge model', () => {
  const catalog = normalizeModelCatalog({
    agents: [
      { name: 'worker', model: 'worker-model', provider: 'p', efforts: ['max'] },
      { name: 'ambiguous', model: 'worker-model', provider: 'p' },
      { name: 'ambiguous', model: 'other-worker-model', provider: 'p' },
      { name: 'judge-agent', model: 'judge-model', provider: 'p' },
    ],
    providers: [{ name: 'p', usable: true }],
    models: [
      { model: 'worker-model', provider: 'p', judgeOnly: false },
      { model: 'other-worker-model', provider: 'p', judgeOnly: false },
      { model: 'judge-model', provider: 'p', judgeOnly: true },
    ],
  }, { settings: { rules: { general: { mode: 'ladder', rungs: {
    light: [
      { target: { agent: 'missing' }, effort: 'low' },
      { target: { agent: 'ambiguous' }, effort: 'medium' },
      { target: { agent: 'judge-agent' }, effort: 'high' },
      { target: { agent: 'worker' }, effort: 'max' },
    ],
  } } } } })
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy-light')).toEqual({
    model: 'worker-model', provider: 'p', effort: 'max', source: 'clauderipple',
  })
})

test('unknown, malformed and ambiguous configuration fails open to the existing model', () => {
  expect(normalizeModelCatalog(null)).toBe(null)
  expect(resolveModelFromCatalog(null, 'light', 'legacy-light').model).toBe('legacy-light')
  const ambiguous = normalizeModelCatalog({ providers: [{ name: 'p', usable: true }], models: [{ model: 'x', provider: 'p' }, { model: 'x', provider: 'p' }], settings: { mode: 'ladder', rungs: { light: { target: 'x' } } } })
  expect(resolveModelFromCatalog(ambiguous, 'light', 'legacy-light').model).toBe('legacy-light')
})

test('unavailable primary target uses only a valid configured backup', () => {
  const catalog = normalizeModelCatalog({
    providers: [{ name: 'p', usable: true }, { name: 'offline', usable: false }],
    models: [{ model: 'backup-worker', provider: 'p' }, { model: 'offline-worker', provider: 'offline' }],
    settings: { mode: 'ladder', rungs: { hard: {
      target: { provider: 'offline', model: 'offline-worker' },
      backup: { provider: 'p', model: 'backup-worker' },
      effort: 'max',
    } } },
  })
  expect(resolveModelFromCatalog(catalog, 'hard', 'legacy-hard')).toEqual({
    model: 'backup-worker', provider: 'p', effort: undefined, source: 'clauderipple',
  })
})

test('invalid selected preset, missing rung and invalid target all preserve fallback', () => {
  const catalog = normalizeModelCatalog({
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'worker', provider: 'p' }],
    presets: { coding: { mode: 'ladder', rungs: { light: { target: 'worker' } } } },
  }, { preset: 'missing' })
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy-light').model).toBe('legacy-light')
  const selected = normalizeModelCatalog({
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'worker', provider: 'p' }],
  }, { mode: 'ladder', rungs: { standard: { target: 'worker' } } })
  expect(resolveModelFromCatalog(selected, 'light', 'legacy-light').model).toBe('legacy-light')
  expect(resolveModelFromCatalog(selected, 'standard', 'legacy-standard').model).toBe('worker')
})

test('malformed catalog structures fail closed without throwing', () => {
  for (const value of [undefined, null, false, 1, 'catalog', [], {}, { models: {}, providers: [] }, { models: [], providers: {} }]) {
    expect(normalizeModelCatalog(value)).toBe(null)
  }
})

test('judgeOnly models remain judge candidates but cannot be worker targets or backups', () => {
  const catalog = normalizeModelCatalog({
    providers: [{ name: 'p', usable: true }],
    models: [
      { model: 'judge', provider: 'p', judgeOnly: true },
      { model: 'worker', provider: 'p', judgeOnly: false },
    ],
    settings: { mode: 'ladder', rungs: {
      light: { target: 'judge' },
      standard: { target: 'missing', backup: 'judge' },
      hard: { target: 'worker' },
    } },
  })
  expect(resolveModelFromCatalog(catalog, 'judge', 'legacy-judge').model).toBe('judge')
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy-light').model).toBe('legacy-light')
  expect(resolveModelFromCatalog(catalog, 'standard', 'legacy-standard').model).toBe('legacy-standard')
  expect(resolveModelFromCatalog(catalog, 'hard', 'legacy-hard').model).toBe('worker')
})

test('invalid configured effort is omitted so callers retain their safe default', () => {
  for (const effort of ['', 'turbo', 'MAX', 3, null]) {
    const catalog = normalizeModelCatalog({
      providers: [{ name: 'p', usable: true }],
      models: [{ model: 'worker', provider: 'p' }],
      settings: { mode: 'ladder', rungs: { light: { target: 'worker', effort } } },
    })
    expect(resolveModelFromCatalog(catalog, 'light', 'legacy-light')).toEqual({
      model: 'worker', provider: 'p', effort: undefined, source: 'clauderipple',
    })
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const catalog = normalizeModelCatalog({
      agents: [{ name: 'worker-agent', model: 'worker', provider: 'p', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      providers: [{ name: 'p', usable: true }],
      models: [{ model: 'worker', provider: 'p' }],
      settings: { rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'worker-agent' }, effort }] } } } },
    })
    expect(resolveModelFromCatalog(catalog, 'light', 'legacy-light').effort).toBe(effort)
  }
})

const loaderDeps = (overrides: Record<string, any> = {}) => {
  let time = 1_000
  let fetches = 0
  const customFetch = overrides.fetch
  const rest = { ...overrides }; delete rest.fetch
  const deps = {
    now: async () => time,
    readConfig: async () => ({ admin: { port: 4312 } }),
    within: async <T,>(promise: Promise<T>, _ms: number, _what: string): Promise<T> => promise,
    ...rest,
    fetch: async (port: number, endpoint: string) => {
      fetches++
      if (customFetch) return customFetch(port, endpoint)
      return { ok: true, text: JSON.stringify(endpoint === '/api/mod-settings' ? { settings: null } : {
        providers: [{ name: 'p', usable: true }],
        models: [{ model: 'worker', provider: 'p' }],
      }) }
    },
  }
  return { deps, setTime: (n: number) => { time = n }, fetchCount: () => fetches }
}

test('catalogue loader handles absent config, invalid ports, HTTP errors, malformed JSON and timeout', async () => {
  const absent = loaderDeps({ readConfig: async () => null })
  expect(await createModelCatalogLoader(absent.deps)()).toBe(null)

  for (const adminPort of [0, -1, 65536, 1.5, 'not-a-port']) {
    const invalid = loaderDeps({ readConfig: async () => ({ admin: { port: adminPort } }) })
    expect(await createModelCatalogLoader(invalid.deps)()).toBe(null)
    expect(invalid.fetchCount()).toBe(0)
  }

  const failedHttp = loaderDeps({ fetch: async () => ({ ok: false, text: 'server error' }) })
  expect(await createModelCatalogLoader(failedHttp.deps)()).toBe(null)

  const malformed = loaderDeps({ fetch: async () => ({ ok: true, text: '{not json' }) })
  expect(await createModelCatalogLoader(malformed.deps)()).toBe(null)

  const timeout = loaderDeps({ within: async <T,>(_promise: Promise<T>, _ms: number, _what: string): Promise<T> => { throw new Error('timeout') } })
  expect(await createModelCatalogLoader(timeout.deps)()).toBe(null)
})

test('catalogue loader keeps the in-flight request visible until the cache is populated', async () => {
  let releaseResponse!: (value: { ok: boolean; text: string }) => void
  let markStarted!: () => void
  let markCacheClock!: () => void
  let releaseCacheClock!: (value: number) => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const cacheClockStarted = new Promise<void>(resolve => { markCacheClock = resolve })
  const pendingResponse = new Promise<{ ok: boolean; text: string }>(resolve => { releaseResponse = resolve })
  const pendingCacheClock = new Promise<number>(resolve => { releaseCacheClock = resolve })
  let nowCalls = 0
  const setup = loaderDeps({
    now: async () => {
      nowCalls++
      if (nowCalls === 2) {
        markCacheClock()
        return pendingCacheClock
      }
      return 1_000
    },
    fetch: async () => { markStarted(); return pendingResponse },
  })
  const load = createModelCatalogLoader(setup.deps)
  const first = load()
  await started
  releaseResponse({ ok: true, text: JSON.stringify({
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'worker', provider: 'p' }],
  }) })
  await cacheClockStarted
  const arrivingDuringCache = load()
  releaseCacheClock(1_000)
  const [a, b] = await Promise.all([first, arrivingDuringCache])
  expect(a?.models[0]?.model).toBe('worker')
  expect(b?.models[0]?.model).toBe('worker')
  expect(setup.fetchCount()).toBe(2)
})

test('catalogue loader shares concurrent requests and caches success for 15 seconds', async () => {
  let release!: (value: { ok: boolean; text: string }) => void
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const pendingResponse = new Promise<{ ok: boolean; text: string }>(resolve => { release = resolve })
  const setup = loaderDeps({ fetch: async () => { markStarted(); return pendingResponse } })
  const load = createModelCatalogLoader(setup.deps)
  const first = load()
  const second = load()
  await started
  release({ ok: true, text: JSON.stringify({
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'worker', provider: 'p' }],
  }) })
  const [a, b] = await Promise.all([first, second])
  expect(a?.models[0]?.model).toBe('worker')
  expect(b?.models[0]?.model).toBe('worker')
  expect(setup.fetchCount()).toBe(2)
  expect((await load())?.models[0]?.model).toBe('worker')
  expect(setup.fetchCount()).toBe(2)
  setup.setTime(16_001)
  expect((await load())?.models[0]?.model).toBe('worker')
  expect(setup.fetchCount()).toBe(4)
})

test('loader derives the admin port from listen.port and reads the real mod-settings API shape', async () => {
  const calls: string[] = []
  const setup = loaderDeps({
    readConfig: async () => ({ admin: { port: 8792 }, listen: { port: 8790 } }),
    fetch: async (port: number, endpoint: string) => {
      calls.push(`${port}${endpoint}`)
      if (endpoint === '/api/mod-options') return { ok: true, text: JSON.stringify({
        agents: [{ name: 'qwen2-5-3b', model: 'qwen2.5:3b', provider: 'ollama-local', efforts: ['medium'] }],
        providers: [{ name: 'ollama-local', usable: true }],
        models: [{ model: 'qwen2.5:3b', provider: 'ollama-local' }],
      }) }
      return { ok: true, text: JSON.stringify({ settings: { rules: { general: { mode: 'ladder', rungs: {
        light: [{ target: { agent: 'qwen2-5-3b' }, effort: 'medium' }],
      } } } } }) }
    },
  })
  const catalog = await createModelCatalogLoader(setup.deps)()
  expect(calls).toEqual(['8792/api/mod-options', '8792/api/mod-settings'])
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy-light')).toEqual({
    model: 'qwen2.5:3b', provider: 'ollama-local', effort: 'medium', source: 'clauderipple',
  })
})


test('admin port follows config.admin.port, then listen.port + 1', () => {
  expect(adminPortFromConfig({ admin: { port: 8792 }, listen: { port: 8790 } })).toBe(8792)
  expect(adminPortFromConfig({ listen: { port: 8790 } })).toBe(8791)
  expect(adminPortFromConfig({ adminPort: 4312 })).toBe(null)
  expect(adminPortFromConfig({ admin: { port: 65536 } })).toBe(null)
})

test('active operating mode replaces the base general ladder', () => {
  const catalog = normalizeModelCatalog({
    agents: [
      { name: 'base-agent', model: 'base', provider: 'p', efforts: ['low'] },
      { name: 'mode-agent', model: 'mode', provider: 'p', efforts: ['high'] },
    ],
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'base', provider: 'p' }, { model: 'mode', provider: 'p' }],
  }, { settings: {
    rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'base-agent' }, effort: 'low' }] } } },
    modes: [{ id: 'work', name: 'Work', rungs: { light: [{ target: { agent: 'mode-agent' }, effort: 'high' }] } }],
    activeMode: 'work',
  } })
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy').model).toBe('mode')
})

test('provider switches, allow and allowKnown are respected', () => {
  const base = {
    agents: [
      { name: 'worker', model: 'worker-model', provider: 'p', efforts: ['low'] },
      { name: 'other', model: 'other-model', provider: 'p', efforts: ['low'] },
    ],
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'worker-model', provider: 'p' }, { model: 'other-model', provider: 'p' }],
  }
  const disabled = normalizeModelCatalog(base, { settings: {
    providers: { p: false },
    rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'worker' }, effort: 'low' }] } } },
  } })
  expect(resolveModelFromCatalog(disabled, 'light', 'legacy').model).toBe('legacy')
  const denied = normalizeModelCatalog(base, { settings: {
    allow: ['other'],
    allowKnown: ['worker', 'other'],
    rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'worker' }, effort: 'low' }] } } },
  } })
  expect(resolveModelFromCatalog(denied, 'light', 'legacy').model).toBe('legacy')
  const newlyAdded = normalizeModelCatalog(base, { settings: {
    allow: ['other'],
    allowKnown: ['other'],
    rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'worker' }, effort: 'low' }] } } },
  } })
  expect(resolveModelFromCatalog(newlyAdded, 'light', 'legacy').model).toBe('worker-model')
})

test('native general-purpose workers resolve through ClaudeRipple claudeLatest and allow-list key', () => {
  const catalog = normalizeModelCatalog({
    providers: [{ name: 'anthropic', usable: true }],
    models: [],
    claudeLatest: { opus: 'claude-opus-5-5' },
    claudeEfforts: ['low', 'medium', 'high'],
  }, { settings: {
    allow: ['general-purpose:opus'],
    allowKnown: ['general-purpose:opus'],
    rules: { general: { mode: 'ladder', rungs: { plan: [{ target: { agent: 'general-purpose', model: 'opus' }, effort: 'high' }] } },
  } })
  expect(resolveModelFromCatalog(catalog, 'plan', 'legacy')).toEqual({
    model: 'claude-opus-5-5', provider: 'anthropic', effort: 'high', source: 'clauderipple',
  })
})

test('unknown effort capabilities do not forward an unverified effort', () => {
  const catalog = normalizeModelCatalog({
    agents: [{ name: 'worker', model: 'm', provider: 'p', efforts: [] }],
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'm', provider: 'p' }],
  }, { settings: { rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'worker' }, effort: 'medium' }] } } } } })
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy').effort).toBeUndefined()
})

test('provider-specific model exhaustion skips the agent', () => {
  const catalog = normalizeModelCatalog({
    agents: [{ name: 'worker', model: 'm', provider: 'p', efforts: ['low'] }],
    providers: [{ name: 'p', usable: true, models: { m: { reason: 'quota_exhausted' } } }],
    models: [{ model: 'm', provider: 'p' }],
  }, { settings: { rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'worker' }, effort: 'low' }] } } } } })
  expect(resolveModelFromCatalog(catalog, 'light', 'legacy').model).toBe('legacy')
})
