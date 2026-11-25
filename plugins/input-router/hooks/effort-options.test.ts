import { expect, test } from 'claude-code/testing'
import { effortOptions } from './effort-options'

test('forwards only declared ClaudeRipple effort and preserves the fallback default', () => {
  expect(effortOptions({ source: 'clauderipple' })).toEqual({})
  expect(effortOptions({ source: 'clauderipple', effort: 'medium' })).toEqual({ effort: 'medium' })
  expect(effortOptions({ source: 'fallback' })).toEqual({ effort: 'low' })
})
