import { expect, test } from 'claude-code/testing'
import { completeWithFallback, requestModel } from './model-completion'
import type { ResolvedModel } from './models'

const claude: ResolvedModel = { model: 'claude-haiku-5-5', provider: null, source: 'clauderipple', effort: 'low' }
const gpt: ResolvedModel = { model: 'gpt-6-luna', provider: 'assinatura-do-chatgpt', source: 'clauderipple', effort: 'low' }
const other: ResolvedModel = { model: 'gpt-6.1-sol', provider: 'assinatura-do-chatgpt', source: 'clauderipple', effort: 'medium' }

test('native Claude remains unqualified, and GPT is qualified exactly once', () => {
  expect(requestModel(claude)).toBe('claude-haiku-5-5')
  expect(requestModel(gpt)).toBe('assinatura-do-chatgpt:gpt-6-luna')
  expect(requestModel({ ...gpt, model: 'assinatura-do-chatgpt:gpt-6-luna' })).toBe('assinatura-do-chatgpt:gpt-6-luna')
})

test('success on the first worker causes no extra calls', async () => {
  const called: string[] = []
  const answer = await completeWithFallback({ candidates: [claude, gpt], request: { prompt: 'test' }, complete: async req => {
    called.push(String(req.model)); return { isAnswered: true, text: 'ok' }
  } })
  expect(called).toEqual(['claude-haiku-5-5'])
  expect(answer.model).toBe(claude.model)
  expect(answer.attempts).toHaveLength(1)
})

test('a 429-style API error on Haiku retries the configured GPT, recording both usages once', async () => {
  const called: Record<string, unknown>[] = []
  const spent: string[] = []
  const answer = await completeWithFallback({
    candidates: [claude, gpt, other], request: { prompt: 'test' },
    complete: async req => {
      called.push(req)
      return called.length === 1
        ? { isAnswered: false, reason: 'api-error', usage: { input_tokens: 2 } }
        : { isAnswered: true, text: 'gpt', usage: { input_tokens: 3 } }
    },
    onAttempt: async attempt => { if (attempt.result?.usage) spent.push(attempt.model) },
  })
  expect(called.map(x => x.model)).toEqual(['claude-haiku-5-5', 'assinatura-do-chatgpt:gpt-6-luna'])
  expect(called[1]?.effort).toBe('low')
  expect(answer.model).toBe('gpt-6-luna')
  expect(answer.attempts).toHaveLength(2)
  expect(spent).toEqual(['claude-haiku-5-5', 'gpt-6-luna'])
})

test('an exception with a retryable provider quota condition retries the next candidate', async () => {
  const answer = await completeWithFallback({
    candidates: [claude, gpt], request: { prompt: 'test' },
    complete: async req => {
      if (req.model === claude.model) throw new Error('429 rate_limit_error')
      return { isAnswered: true, text: 'fallback' }
    },
  })
  expect(answer.model).toBe('gpt-6-luna')
  expect(answer.attempts[0]?.error).toContain('429')
})

test('an unavailable model in the Claude Code selector can use the next configured provider', async () => {
  let calls = 0
  const answer = await completeWithFallback({
    candidates: [claude, gpt], request: { prompt: 'test' },
    complete: async () => {
      calls++
      if (calls === 1) throw new Error('400 model_not_selectable')
      return { isAnswered: true, text: 'ok' }
    },
  })
  expect(answer.model).toBe('gpt-6-luna')
  expect(calls).toBe(2)
})

test('non-retryable API results and thrown errors do not spend a second model call', async () => {
  let calls = 0
  const result = await completeWithFallback({
    candidates: [claude, gpt], request: { prompt: 'test' },
    complete: async () => { calls++; return { isAnswered: false, reason: 'invalid-request' } },
  })
  expect(result.attempts).toHaveLength(1)
  expect(calls).toBe(1)
  try {
    await completeWithFallback({
      candidates: [claude, gpt], request: { prompt: 'test' },
      complete: async () => { calls++; throw new Error('400 invalid prompt') },
    })
    throw new Error('expected rejection')
  } catch (error) { expect(String(error)).toContain('400 invalid prompt') }
  expect(calls).toBe(2)
})

test('user cancellation prevents any retry', async () => {
  const signal = { aborted: false }
  const seen: string[] = []
  try {
    await completeWithFallback({
      candidates: [claude, gpt], request: { prompt: 'test' }, options: { signal },
      complete: async req => {
        seen.push(String(req.model)); signal.aborted = true; throw new Error('429 rate limit')
      },
    })
    throw new Error('expected cancellation')
  } catch (error) { expect(String(error)).toContain('429') }
  expect(seen).toEqual([claude.model])
})

test('without Ripple, the legacy model keeps its low-effort helper behavior', async () => {
  const legacy: ResolvedModel = { model: 'haiku', provider: null, source: 'fallback' }
  const seen: Record<string, unknown>[] = []
  await completeWithFallback({ candidates: [legacy], request: { prompt: 'test' }, complete: async req => {
    seen.push(req); return { isAnswered: true }
  } })
  expect(seen).toEqual([{ model: 'haiku', effort: 'low', prompt: 'test' }])
})

test('exhausted candidates stop, without silently retrying legacy Haiku', async () => {
  const seen: string[] = []
  const answer = await completeWithFallback({ candidates: [claude, gpt], request: { prompt: 'test' }, complete: async req => {
    seen.push(String(req.model)); return { isAnswered: false, reason: 'api-error' }
  } })
  expect(seen).toEqual(['claude-haiku-5-5', 'assinatura-do-chatgpt:gpt-6-luna'])
  expect(answer.result.isAnswered).toBe(false)
})
