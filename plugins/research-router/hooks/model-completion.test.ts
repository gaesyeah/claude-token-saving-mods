import { expect, test } from 'claude-code/testing'
import { completeWithEffort, completeWithModel } from './model-completion'

test('forwards the ClaudeRipple model and omits an undeclared effort', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithEffort(async request => {
    calls.push(request)
    return { isAnswered: true }
  }, { model: 'qwen2.5:3b', provider: 'ollama-local', source: 'clauderipple' }, {
    prompt: 'test prompt',
    maxTokens: 400,
    timeoutMs: 30_000,
  })

  expect(calls).toEqual([{
    model: 'ollama-local:qwen2.5:3b',
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

test('research worker completion preserves the explicit model and omits absent effort', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithModel(async request => {
    calls.push(request)
    return { isAnswered: true }
  }, 'qwen2.5:3b', {
    system: 'system prompt',
    prompt: 'worker prompt',
    maxTokens: 800,
    timeoutMs: 60_000,
  })

  expect(calls).toEqual([{
    model: 'qwen2.5:3b',
    system: 'system prompt',
    prompt: 'worker prompt',
    maxTokens: 800,
    timeoutMs: 60_000,
  }])
})

test('research worker completion forwards a declared effort', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithModel(async request => {
    calls.push(request)
    return { isAnswered: true }
  }, 'worker-model', { prompt: 'worker prompt' }, 'high')

  expect(calls[0]).toEqual({ model: 'worker-model', effort: 'high', prompt: 'worker prompt' })
})
