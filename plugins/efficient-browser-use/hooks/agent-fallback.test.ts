import { expect, test } from 'claude-code/testing'
import { retryableAgentFailure } from './model-request'

test('image helper retries provider quota and unavailable-model errors only', () => {
  expect(retryableAgentFailure('429 rate_limit_error')).toBe(true)
  expect(retryableAgentFailure('model_not_selectable')).toBe(true)
  expect(retryableAgentFailure('Provider temporarily unavailable')).toBe(true)
  expect(retryableAgentFailure('user denied permission')).toBe(false)
  // A host denial is terminal even when its wording contains a retry keyword.
  expect(retryableAgentFailure('model unavailable', true)).toBe(false)
  expect(retryableAgentFailure('invalid tool input')).toBe(false)
})
