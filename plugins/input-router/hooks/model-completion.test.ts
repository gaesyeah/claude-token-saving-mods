import { expect, test } from 'claude-code/testing'
import { normalizeModelCatalog, resolveModelFromCatalog } from '../../mods-core/hooks/models'
import { completeWithResolvedModel } from './model-completion'

const qwenCatalog = () => normalizeModelCatalog({
  agents: [
    { name: 'qwen2-5-3b', model: 'qwen2.5:3b', provider: 'ollama-local', efforts: [] },
  ],
  providers: [
    { name: 'ollama-local', type: 'openai-compatible', usable: true },
  ],
  models: [
    { model: 'qwen2.5:3b', provider: 'ollama-local', name: 'qwen2.5:3b', judgeOnly: false },
  ],
}, {
  settings: {
    rules: {
      general: {
        mode: 'ladder',
        rungs: {
          light: [
            { target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' },
            { target: { agent: 'qwen2-5-3b' }, effort: 'medium' },
          ],
        },
      },
    },
  },
})

test('input-router sends the resolved ClaudeRipple model without an undeclared effort', async () => {
  const catalog = qwenCatalog()
  const calls: Array<{ request: Record<string, unknown>; options: unknown }> = []
  const result = await completeWithResolvedModel({
    resolve: async () => resolveModelFromCatalog(catalog, 'light', 'claude-haiku-5-5'),
    complete: async (request, options) => {
      calls.push({ request, options })
      return { isAnswered: true, reason: 'answered' }
    },
    fallbackModel: 'haiku',
    request: { prompt: 'test prompt', system: 'test system', maxTokens: 400 },
    options: { signal: 'test-signal' },
  })

  expect(result.model).toBe('qwen2.5:3b')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.request).toEqual({
    model: 'qwen2.5:3b',
    prompt: 'test prompt',
    system: 'test system',
    maxTokens: 400,
  })
  expect(calls[0]?.request).not.toHaveProperty('effort')
  expect(calls[0]?.options).toEqual({ signal: 'test-signal' })
})

test('input-router preserves low effort for the existing fallback model', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithResolvedModel({
    resolve: async () => ({ model: 'legacy-helper', source: 'fallback' }),
    complete: async request => {
      calls.push(request)
      return { isAnswered: true, reason: 'answered' }
    },
    fallbackModel: 'haiku',
    request: { prompt: 'fallback test' },
  })

  expect(calls).toEqual([{
    model: 'legacy-helper',
    effort: 'low',
    prompt: 'fallback test',
  }])
})

test('input-router retries the legacy alias after an API error without carrying worker effort', async () => {
  const calls: Record<string, unknown>[] = []
  await completeWithResolvedModel({
    resolve: async () => ({ model: 'qwen2.5:3b', effort: 'medium', source: 'clauderipple' }),
    complete: async request => {
      calls.push(request)
      return calls.length === 1
        ? { isAnswered: false, reason: 'api-error' }
        : { isAnswered: true, reason: 'answered' }
    },
    fallbackModel: 'haiku',
    request: { prompt: 'retry test' },
  })

  expect(calls).toEqual([
    { model: 'qwen2.5:3b', effort: 'medium', prompt: 'retry test' },
    { model: 'haiku', prompt: 'retry test' },
  ])
})
