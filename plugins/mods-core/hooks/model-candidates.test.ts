import { expect, test } from 'claude-code/testing'
import { normalizeModelCatalog, resolveModelCandidatesFromCatalog, resolveModelFromCatalog } from './models'

const catalog = (overrides: Record<string, unknown> = {}) => normalizeModelCatalog({
  agents: [
    { name: 'luna', provider: 'gpt', model: 'gpt-6-luna', efforts: ['low'] },
    { name: 'sol', provider: 'gpt', model: 'gpt-6.1-sol', efforts: ['medium'] },
    { name: 'astra', provider: 'gpt', model: 'gpt-6-astra', efforts: ['high'] },
  ],
  providers: [{ name: 'gpt', usable: true }],
  models: [
    { provider: 'gpt', model: 'gpt-6-luna' },
    { provider: 'gpt', model: 'gpt-6.1-sol' },
    { provider: 'gpt', model: 'gpt-6-astra' },
  ],
  claudeLatest: { haiku: 'claude-haiku-5-5' },
}, { settings: {
  rules: { general: { rungs: {
    light: [
      { target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' },
      { target: { agent: 'luna' }, effort: 'low' },
      { target: { agent: 'luna' }, effort: 'low' },
    ],
    standard: [{ target: { agent: 'sol' }, effort: 'medium' }],
    hard: [{ target: { agent: 'astra' }, effort: 'high' }],
  } } }, ...overrides,
} })

test('ordered light candidates prefer native Claude, then GPT, then the next rung', () => {
  const candidates = resolveModelCandidatesFromCatalog(catalog(), 'light', 'haiku')
  expect(candidates.map(x => x.model)).toEqual(['claude-haiku-5-5', 'gpt-6-luna', 'gpt-6.1-sol'])
  expect(candidates[0]?.provider).toBe(null)
  expect(candidates[1]?.provider).toBe('gpt')
  expect(candidates[1]?.effort).toBe('low')
  expect(resolveModelFromCatalog(catalog(), 'light', 'haiku')).toEqual(candidates[0])
})

test('unavailable GPT models are skipped without changing the saved rung', () => {
  const c = catalog()!
  c.providers[0]!.models['gpt-6-luna'] = { reason: 'quota_exhausted' }
  expect(resolveModelCandidatesFromCatalog(c, 'light', 'haiku').map(x => x.model)).toEqual(['claude-haiku-5-5', 'gpt-6.1-sol'])
})

test('missing ripple settings use the one legacy alias, without inventing models', () => {
  expect(resolveModelCandidatesFromCatalog(null, 'light', 'haiku')).toEqual([{ model: 'haiku', provider: null, source: 'fallback' }])
  expect(resolveModelCandidatesFromCatalog(catalog({ rules: {} }), 'light', 'haiku')).toEqual([{ model: 'haiku', provider: null, source: 'fallback' }])
})

test('a missing native Claude login provider must not produce a qualified anthropic id', () => {
  const c = catalog()!
  expect(c.providers.find(x => x.name === 'anthropic')).toBeUndefined()
  expect(resolveModelCandidatesFromCatalog(c, 'light', 'haiku')[0]).toMatchObject({ model: 'claude-haiku-5-5', provider: null })
})

test('judge role uses the configured Low candidates in order as its failover', () => {
  const c = catalog()!
  expect(resolveModelCandidatesFromCatalog(c, 'judge', 'haiku').map(x => x.model))
    .toEqual(['claude-haiku-5-5', 'gpt-6-luna', 'gpt-6.1-sol'])
})
