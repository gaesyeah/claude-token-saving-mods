import { expect, test } from 'claude-code/testing'
import { createModelCatalogLoader, normalizeModelCatalog, resolveModelFromCatalog } from './models'

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

test('worker resolves only the active explicit ladder rung and returns its effort', () => {
  const resolved = resolveModelFromCatalog(fixture(), 'light', 'legacy-light')
  expect(resolved).toEqual({ model: 'worker-model', provider: 'openai', effort: 'low', source: 'clauderipple' })
  expect(resolveModelFromCatalog(fixture(), 'hard', 'legacy-deep').model).toBe('legacy-deep')
  const noSettings = normalizeModelCatalog({ providers: [{ name: 'p', usable: true }], models: [{ model: 'worker-model', provider: 'p' }], presets: { coding: { rungs: { light: { target: 'worker-model' } } } } })
  expect(resolveModelFromCatalog(noSettings, 'light', 'legacy-light').model).toBe('legacy-light')
})

test('unknown, malformed and ambiguous configuration fails open to the existing model', () => {
  expect(normalizeModelCatalog(null)).toBe(null)
  expect(resolveModelFromCatalog(null, 'light', 'legacy-light').model).toBe('legacy-light')
  const ambiguous = normalizeModelCatalog({ providers: [{ name: 'p', usable: true }], models: [{ model: 'x', provider: 'p' }, { model: 'x', provider: 'p' }], settings: { mode: 'ladder', rungs: { light: { target: 'x' } } } })
  expect(resolveModelFromCatalog(ambiguous, 'light', 'legacy-light').model).toBe('legacy-light')
})

test('selected preset resolves only its configured rung and keeps its effort', () => {
  const catalog = normalizeModelCatalog({
    providers: [{ name: 'p', usable: true }],
    models: [{ model: 'preset-worker', provider: 'p' }],
    presets: {
      coding: { mode: 'ladder', rungs: { standard: { target: 'preset-worker', effort: 'high' } } },
      writing: { mode: 'ladder', rungs: { standard: { target: 'not-selected', effort: 'low' } } },
    },
  }, { preset: 'coding' })
  expect(resolveModelFromCatalog(catalog, 'standard', 'legacy-standard')).toEqual({
    model: 'preset-worker', provider: 'p', effort: 'high', source: 'clauderipple',
  })
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
    model: 'backup-worker', provider: 'p', effort: 'max', source: 'clauderipple',
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
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const catalog = normalizeModelCatalog({
      providers: [{ name: 'p', usable: true }],
      models: [{ model: 'worker', provider: 'p' }],
      settings: { mode: 'ladder', rungs: { light: { target: 'worker', effort } } },
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
    readConfig: async () => ({ adminPort: 4312 }),
    readSettings: async () => null,
    within: async <T,>(promise: Promise<T>, _ms: number, _what: string): Promise<T> => promise,
    ...rest,
    fetch: async (port: number) => {
      fetches++
      if (customFetch) return customFetch(port)
      return { ok: true, text: JSON.stringify({
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
    const invalid = loaderDeps({ readConfig: async () => ({ adminPort }) })
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
  expect(setup.fetchCount()).toBe(1)
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
  expect(setup.fetchCount()).toBe(1)
  expect((await load())?.models[0]?.model).toBe('worker')
  expect(setup.fetchCount()).toBe(1)
  setup.setTime(16_001)
  expect((await load())?.models[0]?.model).toBe('worker')
  expect(setup.fetchCount()).toBe(2)
})
