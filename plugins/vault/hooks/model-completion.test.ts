import { expect, test } from 'claude-code/testing'
import { completeWithEffort } from './model-completion'

test('forwards the ClaudeRipple model and omits an undeclared effort', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithEffort(async request => {
    calls.push(request)
    return { isAnswered: true }
  }, { model: 'qwen2.5:3b', source: 'clauderipple' }, {
    prompt: 'test prompt',
    maxTokens: 400,
    timeoutMs: 30_000,
  })

  expect(calls).toEqual([{
    model: 'qwen2.5:3b',
    prompt: 'test prompt',
    maxTokens: 400,
    timeoutMs: 30_000,
  }])
})

test('forwards only an effort declared by the resolver', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithEffort(async request => {
    calls.push(request)
    return { isAnswered: true }
  }, { model: 'worker-model', effort: 'medium', source: 'clauderipple' }, {
    prompt: 'test prompt',
  })

  expect(calls[0]).toEqual({ model: 'worker-model', effort: 'medium', prompt: 'test prompt' })
})

test('preserves the legacy low effort for fallback completions', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithEffort(async request => {
    calls.push(request)
    return { isAnswered: true }
  }, { model: 'legacy-model', source: 'fallback' }, {
    prompt: 'test prompt',
  })

  expect(calls[0]).toEqual({ model: 'legacy-model', effort: 'low', prompt: 'test prompt' })
})
