import { expect, test } from 'claude-code/testing'
import { afterSample, decide, freshStats, isQmdHealth, judgeLine, rerankOf } from './qmd'
import { addCall, rowsOf, usdOf } from './spend'

test('qmd: the reranker read back from the blend, and only qmd counts as up', async () => {
  expect(Math.round(rerankOf(0.75 + 0.25 * 0.9) * 100) / 100).toBe(0.9)
  expect(Math.round(rerankOf(0.375 + 0.25 * 0.7) * 100) / 100).toBe(0.7)
  expect(Math.round(rerankOf(0.25 + 0.25 * 0.1) * 100) / 100).toBe(0.1)
  expect(isQmdHealth('{"status":"ok","uptime":3}')).toBe(true)
  expect(isQmdHealth('<html>nginx</html>')).toBe(false)
})

test('the local judge answers only when the nearest is very close and the close ones agree', async () => {
  const L = ['low', 'medium', 'high']
  expect(decide([{ name: 'high--a.md', rerank: 0.9 }, { name: 'high--b.md', rerank: 0.7 }, { name: 'low--c.md', rerank: 0.1 }], L)?.label).toBe('high')
  expect(decide([{ name: 'high--a.md', rerank: 0.6 }, { name: 'high--b.md', rerank: 0.6 }], L)).toBe(null)
  expect(decide([{ name: 'high--a.md', rerank: 0.9 }, { name: 'low--b.md', rerank: 0.7 }], L)).toBe(null)
  expect(decide([{ name: 'high--a.md', rerank: 0.95 }, { name: 'low--b.md', rerank: 0.1 }], L)).toBe(null)
})

test('samples that agree too little stop the local judge, and the status line says so', async () => {
  let s = freshStats()
  for (let i = 0; i < 4; i++) s = afterSample(s, true)
  expect(s.stopped).toBe(false)
  s = afterSample(afterSample(s, false), false)
  expect(s.stopped).toBe(true)
  expect(judgeLine(s, 40, 'Sonnet')).toContain('stopped')
  expect(judgeLine(freshStats(), 10, 'Sonnet')).toContain('learning, 10/30')
})

test('the mods\' spend: list prices per family, summed per mod and model, the dearest first', async () => {
  expect(usdOf('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBe(0.6)
  let day = addCall({}, 'vault', 'claude-haiku-5-5', { input_tokens: 3000, output_tokens: 200 })
  day = addCall(day, 'vault', 'haiku', { input_tokens: 1000, output_tokens: 100 })
  day = addCall(day, 'effort-optimizer', 'claude-sonnet-5-5', { input_tokens: 2000, output_tokens: 50 })
  const rows = rowsOf([day, day])
  expect(rows[0]).toEqual({ mod: 'effort-optimizer', model: 'Sonnet', calls: 2, in: 4000, out: 100, usd: 0.009 })
  expect(rows[1]!.mod).toBe('vault')
  expect(rows[1]!.calls).toBe(4)
})
