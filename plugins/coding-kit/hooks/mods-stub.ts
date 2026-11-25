import { test as kitTest } from 'claude-code/testing'

// $.mods as mods-core adds it in a session; a test loads no other plugin. engine.create adds the noun
// and the hooks here answer its calls. They cannot reach the test's own fakes, so they answer from
// fixed values: home /home/u (what every test here sets), the switches a test puts in `switches`,
// and what is logged, appended or opened kept in `calls`.
export const switches: Record<string, unknown> = {}
export const calls: { method: string; args: unknown }[] = []
export const fakes: { append?: (path: string, text: string) => void } = {}

function core(on: any) {
  on('engine.create', async (_: any, e: any, next: any) => {
    const beneath = await next(e)
    const none = async () => {
      throw new Error('answered by the test hooks')
    }
    const names = ['paths', 'switches', 'readSwitches', 'writeSwitches', 'log', 'append', 'sh', 'ledger', 'open', 'openAsked', 'paneAllowed', 'paneClosed', 'prices', 'spent', 'spend', 'qmdFind', 'qmdUp', 'qmdQuery', 'qmdStart', 'qmdStop', 'judgeGuess', 'judgeRemember', 'judgeUsed', 'judgeSampled', 'judgeReset', 'judgeLine']
    return { ...beneath, mods: Object.fromEntries(names.map(n => [n, none])) }
  })
  on('mods.paths', () => ({ value: { home: '/home/u', claudeDir: '/home/u/.claude' } }))
  on('mods.switches', () => ({ value: { ...switches } }))
  on('mods.readSwitches', () => ({ value: { ...switches } }))
  on('mods.writeSwitches', (_: any, e: any) => {
    for (const [k, v] of Object.entries(e.set ?? {})) {
      if (v === null) delete switches[k]
      else switches[k] = v
    }
    return { value: undefined }
  })
  // Kept in calls; an append also goes to fakes.append, where a test writes its own fake files.
  for (const method of ['log', 'append', 'ledger'])
    on(`mods.${method}`, (_: any, e: any) => {
      calls.push({ method, args: e })
      if (method === 'append') fakes.append?.(e.path, e.text)
      return { value: undefined }
    })
  on('mods.open', (_: any, e: any) => (calls.push({ method: 'open', args: e }), { value: true }))
  on('mods.sh', (_: any, e: any) => (calls.push({ method: 'sh', args: e }), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('mods.spent', (_: any, e: any) => (calls.push({ method: 'spent', args: e }), { value: undefined }))
  on('mods.openAsked', () => ({ value: false }))
  on('mods.prices', () => ({ value: [] }))
  on('mods.paneAllowed', () => ({ value: true }))
  on('mods.paneClosed', () => ({ value: undefined }))
  on('mods.spend', () => ({ value: { today: [], week: [] } }))
  // No qmd and no local judge unless a test answers these itself.
}

// The kit's test, with $.mods answered as above; switches and calls start empty in each test.
export const test = (name: string, body: ($: any, on: any) => unknown) =>
  kitTest(name, async ($: any, on: any) => {
    for (const k of Object.keys(switches)) delete switches[k]
    calls.length = 0
    fakes.append = undefined
    core(on)
    await body($, on)
  })
