import { expect } from 'claude-code/testing'
import { fakes, test } from './mods-stub'

// The local judge lives in mods-core ($.mods.judge*), which tests its rules; here, how Effort Optimizer
// uses it: a local answer skips Sonnet, a sample asks Sonnet too and reports back, a paid answer is kept.
type J = { guess: string | null; sample: boolean; paid: string; asked: number; sampled: boolean[]; kept: string[]; requests: Record<string, unknown>[] }

function engine(on: any, j: J, resolved?: { model: string; provider: string; source: 'clauderipple' }) {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('command.register', () => ({ value: { command: 'effort-optimizer' } }))
  const store = new Map<string, unknown>([['mode', 'auto']])
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  for (const ev of ['clock.every', 'clock.sleep', 'ui.status', 'ui.invalidate', 'ui.toast']) on(ev, () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('config.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', (_: any, e: any) => (j.asked += 1, j.requests.push(e), { value: { isAnswered: true, text: JSON.stringify({ level: j.paid, why: 'x' }) } }))
  if (resolved) fakes.modelResolve = () => ({ ...resolved, effort: undefined })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'stop', ref: 's', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 500 } }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  })
  on('mods.judgeGuess', () => ({ value: j.guess ? { label: j.guess, file: `/x/${j.guess}--a.md`, n: 2, score: 0.9 } : null }))
  on('mods.judgeUsed', () => ({ value: j.sample }))
  on('mods.judgeSampled', (_: any, e: any) => (j.sampled.push(e.agreed), { value: false }))
  on('mods.judgeRemember', (_: any, e: any) => (j.kept.push(`${e.collection}:${e.label}`), { value: undefined }))
  on('mods.judgeLine', (_: any, e: any) => ({ value: `Local judge line for ${e.paid}` }))
}

let n = 0
async function prompt($: any, text: string) {
  n += 1
  await $.prompt.submit({ text, origin: { kind: 'composer' } })
  for await (const _ of $.turn.step({ turnId: `t${n}`, index: 0, effort: 'medium', model: 'claude-opus-5-5', messages: [] } as any)) {
    // drain
  }
  for (let i = 0; i < 200; i++) await Promise.resolve()
}
const start = ($: any) => $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)

test('a local answer skips Sonnet; a sampled one asks Sonnet too, reports whether they agree and keeps its answer', async ($, on) => {
  const j: J = { guess: 'high', sample: false, paid: 'high', asked: 0, sampled: [], kept: [], requests: [] }
  engine(on, j)
  await start($)
  await prompt($, 'refatore o parser')
  expect(j.asked).toBe(0)
  j.sample = true
  j.paid = 'low'
  await prompt($, 'refatore o parser de novo')
  expect(j.asked).toBe(1)
  expect(j.sampled).toEqual([false])
  expect(j.kept).toEqual(['effort-examples:low'])
  const r = (await $.command.run({ command: 'effort-optimizer', args: '' } as any)) as any
  expect(r.text).toContain('Local judge line for Sonnet')
})

test('no local answer: Sonnet picks, and its answer becomes an example', async ($, on) => {
  const j: J = { guess: null, sample: false, paid: 'medium', asked: 0, sampled: [], kept: [], requests: [] }
  engine(on, j)
  await start($)
  await prompt($, 'migre o banco')
  expect(j.asked).toBe(1)
  expect(j.kept).toEqual(['effort-examples:medium'])
})

test('a Ripple judge uses the provider-qualified model and does not send unsupported effort', async ($, on) => {
  const j: J = { guess: null, sample: false, paid: 'medium', asked: 0, sampled: [], kept: [], requests: [] }
  engine(on, j, { model: 'qwen2.5:3b', provider: 'ollama-local', source: 'clauderipple' })
  await start($)
  await prompt($, 'migre o banco')
  expect(j.asked).toBe(1)
  expect(j.requests[0]).toMatchObject({ model: 'ollama-local:qwen2.5:3b' })
  expect(j.requests[0]).not.toHaveProperty('effort')
})
