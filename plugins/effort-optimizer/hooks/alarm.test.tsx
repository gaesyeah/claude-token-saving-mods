import { expect } from 'claude-code/testing'
import { test } from './mods-stub'

function engine(on: any, o: { picks: string[]; asked: string[]; toasts: string[]; wrote: number }) {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('command.register', () => ({ value: { command: 'effort-optimizer' } }))
  const store = new Map<string, unknown>([['mode', 'auto']])
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('config.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('session.messages', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => {
    o.toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('model.complete', (_: any, e: any) => {
    o.asked.push(e.prompt)
    return { value: { isAnswered: true, text: JSON.stringify({ level: o.picks.shift() ?? 'medium', why: 'x' }) } }
  })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'stop', ref: 's', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: e.effort === 'high' ? 1000 : 60_000, cache_creation_input_tokens: e.effort === 'high' ? o.wrote : 500 } }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  })
}

async function prompt($: any, text: string, n: number) {
  await $.prompt.submit({ text, origin: { kind: 'composer' } })
  for await (const _ of $.turn.step({ turnId: `t${n}`, index: 0, effort: 'medium', model: 'claude-opus-5-5', messages: [] } as any)) {
    // drain
  }
}

for (const bust of [true, false]) {
  test(`a level move that ${bust ? 'rewrites' : 'keeps'} the cache ${bust ? 'stops' : 'does not stop'} further changes in the chat`, async ($, on) => {
    const o = { picks: ['medium', 'high', 'high'], asked: [] as string[], toasts: [] as string[], wrote: bust ? 70_000 : 800 }
    engine(on, o)
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
    await prompt($, 'oi', 1)
    await prompt($, 'migre o banco de dados', 2)
    await prompt($, 'e agora?', 3)
    expect(o.asked.length).toBe(bust ? 2 : 3)
    expect(o.toasts.some(t => t.includes('reescreveu o cache'))).toBe(bust)
  })
}

test('the classifier knows the coding criteria', async ($, on) => {
  const o = { picks: ['high'], asked: [] as string[], toasts: [] as string[], wrote: 0 }
  engine(on, o)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  await prompt($, 'por que esse teste falha?', 1)
  expect(o.asked[0]).toContain('diagnosing a bug, explaining how code behaves, or reviewing a diff is at least medium')
  expect(o.asked[0]).toContain('data or database migration is high')
})
