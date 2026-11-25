import { expect, test } from 'claude-code/testing'

const BAND = { plugin: 'local-models', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } } }

// o.qmd: whether `command -v qmd` finds it; o.daemon: whether /health answers as qmd.
function engine(on: any, o: { qmd: boolean; daemon: boolean; runs: string[] }) {
  const store = new Map<string, unknown>()
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'local-models' } }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('state.get', (_: any, e: any) => ({ value: { value: store.get(`state:${e.key}`) ?? null, version: 1 } }))
  on('state.set', (_: any, e: any) => (store.set(`state:${e.key}`, e.value), { value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', () => new Promise(() => undefined))
  on('http.fetch', () => {
    if (!o.daemon) throw new Error('connection refused')
    return { value: { status: 200, ok: true, headers: {}, text: '{"status":"ok","uptime":1}' } }
  })
  on('process.run', (_: any, e: any) => {
    const script = e.argv[0] === '/bin/sh' ? String(e.argv[2]) : e.argv.join(' ')
    o.runs.push(script)
    if (script.startsWith('command -v qmd')) return { value: o.qmd ? { exitCode: 0, stdout: '/home/u/.volta/bin/qmd\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' } }
    if (script.includes('mcp --http --daemon')) return { value: { exitCode: 0, stdout: 'Started on http://localhost:8181/mcp (PID 42)', stderr: '' } }
    if (script.includes('npm install')) return { value: { exitCode: o.qmd ? 0 : 1, stdout: o.qmd ? 'added 1 package' : 'npm ERR! network', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return store
}

const start = ($: any) => $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

test('no qmd: the orange band offers it; installing it starts the daemon and says what comes next', async ($, on) => {
  const o = { qmd: false, daemon: false, runs: [] as string[] }
  const store = engine(on, o)
  await start($)
  expect(store.get('state:band')).toBe('offer')
  const ui = await $.ui.mount(BAND as any)
  expect(await ui.find({ key: 'install' })).toBeDefined()
  // The install itself succeeds: from now on qmd is found.
  o.qmd = true
  await ui.press({ key: 'install' })
  await settle()
  expect(o.runs.some(r => r.includes('npm install -g'))).toBe(true)
  expect(o.runs.some(r => r.includes('mcp --http --daemon'))).toBe(true)
  expect(store.get('daemon')).toBe('42')
  expect(String(store.get('state:band'))).toContain('qmd instalado')
  await (await $.ui.mount(BAND as any)).press({ key: 'ok' })
  expect(store.get('state:band')).toBe(null)
})

test('a failed install says why; "Agora não" is remembered, and /local-models install offers it again', async ($, on) => {
  const o = { qmd: false, daemon: false, runs: [] as string[] }
  const store = engine(on, o)
  await start($)
  await (await $.ui.mount(BAND as any)).press({ key: 'install' })
  await settle()
  expect(String(store.get('state:band'))).toContain('Não deu para instalar o qmd: npm ERR! network')
  await start($)
  await (await $.ui.mount(BAND as any)).press({ key: 'later' })
  await start($)
  expect(store.get('state:band')).toBe(null)
  await $.command.run({ command: 'local-models', args: 'install' } as any)
  expect(store.get('state:band')).toBe('offer')
})

test('with qmd, a chat start brings the daemon up once, and no band shows', async ($, on) => {
  const o = { qmd: true, daemon: false, runs: [] as string[] }
  const store = engine(on, o)
  await start($)
  await settle()
  expect(o.runs.filter(r => r.includes('mcp --http --daemon')).length).toBe(1)
  expect(store.get('state:band')).toBe(undefined)
  o.daemon = true
  await start($)
  await settle()
  expect(o.runs.filter(r => r.includes('mcp --http --daemon')).length).toBe(1)
})
