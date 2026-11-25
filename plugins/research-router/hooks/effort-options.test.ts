import { expect, test } from 'claude-code/testing'
import { effortOptions } from './effort-options'

test('forwards only declared ClaudeRipple effort and preserves the fallback default', () => {
  expect(effortOptions({ model: 'qwen2.5:3b', source: 'clauderipple' })).toEqual({})
  expect(effortOptions({ model: 'worker', source: 'clauderipple', effort: 'medium' })).toEqual({ effort: 'medium' })
  expect(effortOptions({ model: 'claude-haiku-5-5', source: 'fallback' })).toEqual({ effort: 'low' })
})
