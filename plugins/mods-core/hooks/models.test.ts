import { expect, test } from 'claude-code/testing'
import { normalizeModelCatalog, resolveModelFromCatalog } from './models'

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
