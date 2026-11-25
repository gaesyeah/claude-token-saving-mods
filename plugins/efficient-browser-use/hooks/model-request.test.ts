import { expect, test } from 'claude-code/testing'
import { modelForRequest } from './model-request'

test('provider-qualifies Ripple model IDs and preserves existing prefixes', () => {
  expect(modelForRequest({ model: 'qwen2.5:3b', provider: 'ollama-local', source: 'clauderipple' })).toBe('ollama-local:qwen2.5:3b')
  expect(modelForRequest({ model: 'ollama-local:qwen2.5:3b', provider: 'ollama-local', source: 'clauderipple' })).toBe('ollama-local:qwen2.5:3b')
})

test('keeps fallback model aliases unchanged', () => {
  expect(modelForRequest({ model: 'haiku', provider: null, source: 'fallback' })).toBe('haiku')
})
