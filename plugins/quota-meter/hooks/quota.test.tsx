import { expect } from 'claude-code/testing'
import { switches, test } from './mods-stub'

const opened: string[] = []
let store = new Map<string, unknown>()
const view = () => store.get('state:view') as any

function engine(on: any, status: (string | undefined)[], switches = '') {
  opened.length = 0
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ turnId: e.turnId, text: e.answer }))
  on('command.run', () => ({ text: '' }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('clock.now', () => ({ value: 1000 }))
  on('fs.exists', (_: any, e: any) => ({ value: !!switches && e.path.endsWith('/switches.json') }))
  on('fs.read', () => ({ value: switches }))
  on('ui.status', (_: any, e: any) => {
    status.push(e.text)
    return { value: undefined }
  })
  store = new Map<string, unknown>()
  on('state.get', (_: any, e: any) => ({ value: { value: store.get(`state:${e.key}`) ?? null, version: 1 } }))
  on('state.set', (_: any, e: any) => (store.set(`state:${e.key}`, e.value), { value: undefined }))
  on('ui.open', (_: any, e: any) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
}

const limits = (five: number, week: number) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: '2026-11-18T03:00:00Z' },
  { kind: 'seven_day', percentUsed: week },
]

async function turn($: any, id: string, five: number, week: number, agentId?: string) {
  await $.turn.start({ text: 'oi', turnId: id, agentId })
  await $.session.measure({ context: {}, rateLimits: limits(five, week), changed: ['rateLimits'] })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, agentId, reason: 'answer' })
}

test('averages the points each main-chat turn spends and shows them in the pane, not the status line', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, status)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  await $.session.measure({ context: {}, rateLimits: limits(10, 40), changed: ['rateLimits'] } as any)
  await turn($, 't1', 11, 40)
  await turn($, 't2', 11, 40)
  // A subagent's turn inside t3 counts as part of t3, not as a turn of its own.
  await $.turn.start({ text: 'oi', turnId: 't3' } as any)
  await turn($, 'sub', 30, 50, 'agent-1')
  await $.session.measure({ context: {}, rateLimits: limits(31, 50), changed: ['rateLimits'] } as any)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
  expect(view().line).toBe('Cota 5h 31,0% (~7,0 pt/turno) · semana 50,0%')
  expect(status.filter(Boolean)).toEqual([])
  const r: any = await $.command.run({ command: 'quota', args: 'status' } as any)
  expect(r.text).toContain('5h: 31,0% usado, ~7,0 pt por turno, dá para ~9 turnos assim')
  expect(r.text).toContain('semana: 50,0% usado, ~3,3 pt por turno')
})

test('a window that renews during a turn is not counted as a negative spend', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, status)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  await $.session.measure({ context: {}, rateLimits: limits(95, 40), changed: ['rateLimits'] } as any)
  await turn($, 't1', 2, 41)
  expect(view().line).toBe('Cota 5h 2,0% · semana 41,0%')
})

test('off in the /mods switchboard: no pane view', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, status, '{"quota-meter": false}')
  switches['quota-meter'] = false
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  await turn($, 't1', 11, 40)
  expect(view()).toBe(undefined)
})

const PANE = { plugin: 'quota-meter', component: 'Pane', requestId: 'quota-meter', surface: 'desktop', props: { title: 'Quota Meter', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } }

test('/quota opens the pane; past 80% it opens by itself, once a chat; the pane shows the limits and the mods\' spend', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, status)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  await turn($, 't1', 50, 60)
  expect(opened).toEqual([])
  const r: any = await $.command.run({ command: 'quota', args: '' } as any)
  expect(r.text).toContain('painel aberto ao lado')
  expect(opened).toEqual(['quota-meter'])
  opened.length = 0
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  await turn($, 't2', 81, 60)
  await turn($, 't3', 82, 60)
  expect(opened).toEqual(['quota-meter'])
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: '82,0%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h: 82,0% usado/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Nenhuma chamada.' })).toBeDefined()
})
