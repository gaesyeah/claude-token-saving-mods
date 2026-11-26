import { expect, test } from 'claude-code/testing'
import { normalizeModelCatalog, resolveModelCandidatesFromCatalog } from './models'
import { completeWithFallback } from './model-completion'

function fixture(overrides: Record<string, unknown> = {}) {
  return normalizeModelCatalog({
    agents: [{ name: 'gpt-luna', model: 'gpt-6-luna', provider: 'gpt', efforts: ['low'] }],
    providers: [{ name: 'gpt', usable: true }],
    models: [{ model: 'gpt-6-luna', provider: 'gpt' }],
    claudeLatest: { haiku: 'claude-haiku-5-5' }, claudeEfforts: ['low'],
  }, { settings: { rules: { general: { rungs: { light: [
    { target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' },
    { target: { agent: 'gpt-luna' }, effort: 'low' },
  ] } } }, ...overrides } })
}

test('judge uses the configured Low order and falls back Haiku -> GPT after 429', async () => {
  const candidates = resolveModelCandidatesFromCatalog(fixture(), 'judge', 'haiku')
  expect(candidates.map(c => c.model)).toEqual(['claude-haiku-5-5', 'gpt-6-luna'])
  const requests: string[] = []
  const done = await completeWithFallback({ candidates, request: { prompt: 'classify' }, complete: async input => {
    requests.push(String(input.model))
    return requests.length === 1 ? { isAnswered: false, reason: 'api-error', status: 429 } : { isAnswered: true, text: '{"level":"high"}' }
  } })
  expect(requests).toEqual(['claude-haiku-5-5', 'gpt:gpt-6-luna'])
  expect(done.model).toBe('gpt-6-luna')
})

test('an explicitly configured judge-only model comes first, then the Low candidates', () => {
  const c = fixture({ judge: 'model', judgeModel: 'judge-fast' })!
  c.models.push({ model: 'judge-fast', provider: 'gpt', judgeOnly: true })
  const candidates = resolveModelCandidatesFromCatalog(c, 'judge', 'haiku')
  expect(candidates.map(c => c.model)).toEqual(['judge-fast', 'claude-haiku-5-5', 'gpt-6-luna'])
})

test('unavailable configured alternatives cannot cause an arbitrary provider selection', () => {
  const c = fixture()!
  c.providers[0]!.models['gpt-6-luna'] = { reason: 'quota_exhausted' }
  expect(resolveModelCandidatesFromCatalog(c, 'judge', 'haiku').map(c => c.model)).toEqual(['claude-haiku-5-5'])
  expect(resolveModelCandidatesFromCatalog(null, 'judge', 'haiku').map(c => c.model)).toEqual(['haiku'])
})

test('invalid authentication response never causes provider failover', async () => {
  const candidates = resolveModelCandidatesFromCatalog(fixture(), 'judge', 'haiku')
  let n = 0
  const answer = await completeWithFallback({ candidates, request: { prompt: 'classify' }, complete: async () => {
    n++
    return { isAnswered: false, reason: 'api-error', status: 401, error: 'invalid API key' }
  } })
  expect(answer.attempts).toHaveLength(1)
  expect(n).toBe(1)
})
