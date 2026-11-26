import { expect, test } from 'claude-code/testing'
import { warmFailure } from './warm-policy'

test('cache-clock retries its same-session fork after 20 seconds, then stops at three failures', () => {
  expect(warmFailure(0, 1_000)).toEqual({ failures: 1, retryAt: 21_000, stop: false })
  expect(warmFailure(1, 21_000)).toEqual({ failures: 2, retryAt: 41_000, stop: false })
  expect(warmFailure(2, 41_000)).toEqual({ failures: 3, retryAt: 61_000, stop: true })
})
