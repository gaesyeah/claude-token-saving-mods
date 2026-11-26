import { expect, test } from 'claude-code/testing'
import { workerFallbackLine } from './worker-fallback'

const first = { model: 'claude-haiku-5-5', provider: null, source: 'clauderipple' as const, effort: 'low' }
const second = { model: 'gpt-6-luna', provider: 'chatgpt', source: 'clauderipple' as const, effort: 'low' }

test('proxy marker binds primary and ordered fallback without changing the subagent prompt', () => {
  const line = workerFallbackLine('mr-001', 'claude-haiku-5-5', [first, second])!
  expect(line).toContain('clauderipple-ladder')
  const encoded = /^<!-- clauderipple-ladder (\S+) -->$/.exec(line)?.[1]!
  const payload = JSON.parse(decodeURIComponent(encoded))
  expect(payload).toEqual({ pick: 'mr-001', model: 'claude-haiku-5-5', fallbacks: ['chatgpt:gpt-6-luna@low'] })
})

test('no marker for a user-pinned model, absent Ripple, or a single candidate', () => {
  expect(workerFallbackLine('mr-1', 'claude-opus-5-5', [first, second])).toBe(null)
  expect(workerFallbackLine('mr-1', 'haiku', [{ model: 'haiku', provider: null, source: 'fallback' }])).toBe(null)
  expect(workerFallbackLine('mr-1', 'claude-haiku-5-5', [first])).toBe(null)
})

test('candidate fallback list is unique and bounded to the chosen primary', () => {
  const line = workerFallbackLine('mr-2', 'claude-haiku-5-5', [first, first, second, second])!
  const encoded = /^<!-- clauderipple-ladder (\S+) -->$/.exec(line)?.[1]!
  expect(JSON.parse(decodeURIComponent(encoded)).fallbacks).toEqual(['chatgpt:gpt-6-luna@low'])
})
