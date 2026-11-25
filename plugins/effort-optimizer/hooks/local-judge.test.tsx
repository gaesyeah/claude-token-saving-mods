import { expect, test } from 'claude-code/testing'

// The daemon's blend for vector rank k: 0.75/k + 0.25 × rerank.
const row = (name: string, k: number, rerank: number) => ({ file: `qmd://effort-examples/${name}`, score: 0.75 / k + 0.25 * rerank })
const NEAR = [row('high--a.md', 1, 0.9), row('high--b.md', 2, 0.7), row('low--c.md', 3, 0.1)]

function engine(on: any, o: { examples: number; rows: unknown[]; paid: string; asked: number; wrote: string[] }) {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('command.register', () => ({ value: { command: 'effort-optimizer' } }))
  const store = new Map<string, unknown>([['mode', 'auto']])
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  // A timeout never fires: the fake daemon always answers in time.
  on('clock.after', () => new Promise(() => undefined))
  for (const ev of ['clock.every', 'clock.sleep', 'ui.status', 'ui.invalidate', 'ui.toast']) on(ev, () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('config.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', (_: any, e: any) => (o.wrote.push(e.path), { value: undefined }))
  on('fs.list', () => ({ value: Array.from({ length: o.examples }, (_, i) => ({ name: `low--${i}.md`, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  // findQmd's shell finds qmd; every other command just succeeds.
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/x/qmd\n', stderr: '' } }))
  on('http.fetch', (_: any, e: any) => ({
    value: { status: 200, ok: true, headers: {}, text: e.url.endsWith('/health') ? '{"status":"ok","uptime":1}' : JSON.stringify({ results: o.rows }) },
  }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ((o.asked += 1), { value: { isAnswered: true, text: JSON.stringify({ level: o.paid, why: 'x' }) } }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'stop', ref: 's', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 500 } }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  })
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
const status = async ($: any) => ((await $.command.run({ command: 'effort-optimizer', args: '' } as any)) as any).text as string

test('close, agreeing examples answer without Sonnet; every 5th is also asked of Sonnet and counted', async ($, on) => {
  const o = { examples: 40, rows: NEAR, paid: 'high', asked: 0, wrote: [] as string[] }
  engine(on, o)
  await start($)
  for (let i = 0; i < 4; i++) await prompt($, `refatore o parser ${i}`)
  expect(o.asked).toBe(0)
  await prompt($, 'refatore o parser 4')
  expect(o.asked).toBe(1)
  expect(await status($)).toContain('Local judge: 5 answers without Sonnet; 1 in 5 also asked Sonnet: agreed 1/1')
})

test('far or disagreeing examples, or too few of them, leave the pick to Sonnet, which becomes an example', async ($, on) => {
  const o = { examples: 40, rows: [row('high--a.md', 1, 0.9), row('low--b.md', 2, 0.7)], paid: 'medium', asked: 0, wrote: [] as string[] }
  engine(on, o)
  await start($)
  await prompt($, 'migre o banco')
  expect(o.asked).toBe(1)
  expect(o.wrote.some(p => p.includes('/effort-optimizer/examples/medium--'))).toBe(true)
  o.rows = [row('high--a.md', 1, 0.6), row('high--b.md', 2, 0.6)]
  await prompt($, 'outra coisa')
  expect(o.asked).toBe(2)
  o.examples = 10
  o.rows = NEAR
  await prompt($, 'mais uma')
  expect(o.asked).toBe(3)
  expect(await status($)).toContain('learning, 10/30')
})

test('samples that disagree stop the local judge, and reset-local starts it again', async ($, on) => {
  const o = { examples: 40, rows: NEAR, paid: 'low', asked: 0, wrote: [] as string[] }
  engine(on, o)
  await start($)
  for (let i = 0; i < 25; i++) await prompt($, `refatore ${i}`)
  // 5 samples, none agreeing: stopped.
  expect(o.asked).toBe(5)
  expect(await status($)).toContain('stopped')
  await prompt($, 'refatore de novo')
  expect(o.asked).toBe(6)
  await $.command.run({ command: 'effort-optimizer', args: 'reset-local' } as any)
  await prompt($, 'refatore mais')
  expect(o.asked).toBe(6)
})
