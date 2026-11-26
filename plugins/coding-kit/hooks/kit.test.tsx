import { expect, mock } from 'claude-code/testing'
import { calls, test } from './mods-stub'
// A slice of catalog.json (a test can not import JSON).
const catalogJson = {"groups": [{"id": "plan", "title": "Planejar"}, {"id": "build", "title": "Construir"}, {"id": "fix", "title": "Corrigir"}, {"id": "review", "title": "Revisar"}, {"id": "tools", "title": "Ferramentas"}], "items": [{"id": "grill-me", "kind": "skill", "group": "plan", "label": "Interrogar o plano", "command": "/coding-kit:grill-me", "description": "Entrevista em rodadas até o plano ficar claro, com uma resposta recomendada para cada pergunta. Use antes de uma funcionalidade grande ou ainda nebulosa.", "source": "mattpocock/skills (MIT)"}, {"id": "systematic-debugging", "kind": "skill", "group": "fix", "label": "Depurar a fundo", "command": "/coding-kit:systematic-debugging", "description": "Acha a causa raiz antes de mexer no código: reproduz, compara, testa uma hipótese por vez. Para bug difícil ou que já resistiu a uma tentativa.", "source": "obra/superpowers (MIT)", "hint": "stack ?trace|traceback|exception|\\berro\\b|\\berror\\b|n[aã]o funciona|quebrou|falhando|\\bbug\\b|nullpointer|undefined is not|segfault"}, {"id": "context7", "kind": "mcp", "group": "tools", "label": "Context7", "server": "context7", "fill": "use context7 para ", "description": "Documentação atualizada de bibliotecas (React, Spring, Prisma...). Servidor remoto, sem instalar nada local; suas ferramentas ficam atrás da busca e só custam contexto quando usadas.", "install": [["claude", "mcp", "add", "--scope", "user", "--transport", "http", "context7", "https://mcp.context7.com/mcp"]], "uninstall": [["claude", "mcp", "remove", "--scope", "user", "context7"]]}, {"id": "serena", "repo": "https://github.com/oraios/serena", "kind": "mcp", "group": "tools", "label": "Serena (busca semântica e refatoração)", "server": "serena", "needs": ["uvx"], "fill": "Use o Serena (ative este projeto primeiro, se ainda não estiver ativo) para ", "description": "Acha onde cada função ou classe é definida e quem a usa, via LSP, e edita símbolo a símbolo. Rende em refatorar projetos grandes; em projetos pequenos pouco ajuda.", "install": [["claude", "mcp", "add", "--scope", "user", "serena", "--", "uvx", "--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "--context", "claude-code", "--open-web-dashboard", "false"]], "uninstall": [["claude", "mcp", "remove", "--scope", "user", "serena"]]}, {"id": "codebase-memory", "kind": "mcp", "group": "tools", "label": "codebase-memory (grafo do código)", "server": "codebase-memory", "exclusive": "code-intel", "needs": ["npx"], "fill": "Use o grafo do codebase-memory (indexe o repositório se preciso) para ", "description": "Indexa o código num grafo local que dura entre chats: quem chama cada função, imports e rotas HTTP. Responde perguntas de estrutura sem ler arquivo por arquivo.", "install": [["claude", "mcp", "add", "--scope", "user", "codebase-memory", "--", "npx", "-y", "codebase-memory-mcp"]], "uninstall": [["claude", "mcp", "remove", "--scope", "user", "codebase-memory"]]}, {"id": "graphify", "kind": "mcp", "group": "tools", "label": "Graphify (grafo de código e docs)", "server": "graphify", "exclusive": "code-intel", "install": [["true"]], "uninstall": [["true"]]}], "skills": [{"dir": "ponytail", "repo": "DietrichGebert/ponytail", "path": "skills/ponytail", "credit": "MIT License", "frontmatter": {"disable-model-invocation": "true"}}]}

const PANE = {
  plugin: 'coding-kit',
  component: 'Pane',
  requestId: 'coding-kit',
  props: { title: 'Coding Kit', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const files: Record<string, string> = {}

// The pane's groups start hidden; a test that reads cards opens them all.
async function openGroups(ui: any) {
  for (const g of ['plan', 'build', 'fix', 'review', 'tools']) if (await ui.find({ key: `toggle-group:${g}` })) await ui.press({ key: `toggle-group:${g}` })
}

// Stands for the engine: a project folder, the plugin's own files, and the commands the pane runs.
function engine(on: any, opts: { code: boolean; ran: string[][]; filled: string[]; toasts: string[]; curl?: (url: string) => string; writes?: Record<string, string>; dir?: { v: string }; opened?: string[]; sh?: string[][]; shOut?: string; mockClock?: boolean; fillArgs?: any[]; catalog?: unknown; run?: (argv: string[], init: any) => { exitCode?: number; stdout?: string; stderr?: string } | undefined; writeThrough?: boolean; lock?: string }) {
  const own = (path: string) => (path.endsWith('/catalog.json') ? JSON.stringify(opts.catalog ?? catalogJson) : opts.lock !== undefined && path.endsWith('/skills/upstream.lock.json') ? opts.lock : path.endsWith('/skills/ponytail/SKILL.md') ? '---\nname: ponytail\n---\n# Ponytail\nActive for the whole session.\nrules here' : undefined)
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: opts.dir?.v ?? '/work/app' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('command.register', () => ({ value: { command: 'coding-kit' } }))
  if (!opts.mockClock) {
    on('clock.every', () => ({ value: undefined }))
    on('clock.now', () => ({ value: 100 * 24 * 3600 * 1000 }))
  }
  on('ui.open', (_: any, e: any) => {
    opts.opened?.push(e.id)
    return { value: { isPlaced: true } }
  })
  // The plugin decorates AbovePrompt; the test host requires a real base tree.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['host drawing'] }))
  on('ui.toast', (_: any, e: any) => {
    opts.toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('prompt.fill', (_: any, e: any) => {
    opts.filled.push(e.text)
    opts.fillArgs?.push(e)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('fs.exists', (_: any, e: any) => ({ value: own(e.path) !== undefined || e.path in files || (opts.code && e.path === '/work/app/.git') }))
  on('fs.read', (_: any, e: any) => ({ value: own(e.path) ?? files[e.path] ?? '' }))
  const store = new Map<string, unknown>()
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_: any, e: any) => {
    if (opts.writes) opts.writes[e.path] = String(e.text ?? '')
    if (opts.writeThrough) files[e.path] = String(e.text ?? '')
    return { value: undefined }
  })
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv
    const mine = argv[0] === '/bin/sh' && String(argv[2] ?? '').startsWith('mkdir -p') ? undefined : opts.run?.(argv, e.init ?? {})
    if (mine) {
      opts.ran.push(argv)
      return { value: { exitCode: mine.exitCode ?? 0, stdout: mine.stdout ?? '', stderr: mine.stderr ?? '' } }
    }
    if (argv[0] === 'curl') return { value: { exitCode: opts.curl ? 0 : 6, stdout: opts.curl ? opts.curl(argv.at(-1)!) : '', stderr: '' } }
    if (argv[0] !== '/bin/sh') opts.ran.push(argv)
    else opts.sh?.push(argv)
    return { value: { exitCode: 0, stdout: argv[0] === '/bin/sh' ? (opts.shOut ?? '') : '', stderr: '' } }
  })
}

for (const code of [true, false]) {
  test(`ponytail ${code ? 'joins' : 'stays out of'} the system prompt ${code ? 'in a code project' : 'outside one'}`, async ($, on) => {
    engine(on, { code, ran: [], filled: [], toasts: [] })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
    await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
    const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
    const ids = r.sections.map((s: any) => s.id)
    expect(ids.includes('coding-kit:ponytail')).toBe(code)
    if (code) {
      const t = r.sections.at(-1)!.text
      expect(t).toContain('Level in use: full')
      expect(t).toContain('rules here')
      expect(t).not.toContain('Active for the whole session')
      expect(t).not.toContain('name: ponytail')
    }
  })
}

test('a chat started in a spare folder and moved into a project gets ponytail and opens the pane at its first code prompt', async ($, on) => {
  const dir = { v: '/home/u/.claude/spares/spare-x' }
  const opened: string[] = []
  engine(on, { code: true, ran: [], filled: [], toasts: [], dir, opened })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: dir.v, surface: 'desktop', isInteractive: true })
  expect(opened.length).toBe(0)
  dir.v = '/work/app'
  const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.map((s: any) => s.id)).toContain('coding-kit:ponytail')
  await $.prompt.submit({ text: 'delegue para um agente pesquisar o que é aids', origin: { kind: 'composer' } } as any)
  expect(opened.length).toBe(0)
  await $.prompt.submit({ text: 'corrija o bug do login', origin: { kind: 'composer' } } as any)
  await $.prompt.submit({ text: 'refatore a classe de novo', origin: { kind: 'composer' } } as any)
  expect(opened).toEqual(['coding-kit'])
})

test('in a folder with no project marker, ponytail joins the first code prompt once, as hidden context', async ($, on) => {
  const contexts: (readonly string[] | undefined)[] = []
  const opened: string[] = []
  engine(on, { code: false, ran: [], filled: [], toasts: [], opened })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => {
    contexts.push(e.context)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.map((s: any) => s.id)).not.toContain('coding-kit:ponytail')
  const reminder = '<system-reminder>\nThe user started this session without choosing a project folder, so your working directory is a scratch workspace. Write code, fix a bug, run git here if asked.\n</system-reminder>\n'
  for (const text of [reminder + 'bom dia, tudo bem?', 'crie um app de tarefas em React', 'agora adicione login']) await $.prompt.submit({ text, origin: { kind: 'composer' } } as any)
  expect(contexts[0] ?? []).toEqual([])
  expect(contexts[1]?.at(-1)).toContain('rules here')
  expect(contexts[2] ?? []).toEqual([])
  expect(opened).toEqual(['coding-kit'])
})

for (const text of ['implemente um cache de sessão', 'refatore esse módulo', 'compilar não passa']) {
  test(`a verb with any ending counts as code work: ${text}`, async ($, on) => {
    const contexts: (readonly string[] | undefined)[] = []
    engine(on, { code: false, ran: [], filled: [], toasts: [] })
    on('prompt.submit', (_: any, e: any) => {
      contexts.push(e.context)
      return { text: e.text }
    })
    await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text, origin: { kind: 'composer' } } as any)
    expect(contexts[0]?.at(-1)).toContain('rules here')
  })
}

test('the pane lists the catalog, Usar fills the prompt, installs need a confirm', async ($, on) => {
  const ran: string[][] = []
  const filled: string[] = []
  engine(on, { code: true, ran, filled, toasts: [] })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await openGroups(ui)
  expect(await ui.find({ type: 'Text', text: /Interrogar o plano/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Context7/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Reler instalados e skills do disco/ })).toBeDefined()

  await ui.press({ key: 'use:grill-me' })
  expect(filled.at(-1)).toBe('/coding-kit:grill-me ')

  await ui.press({ key: 'install:context7' })
  expect(ran.some(a => a.includes('context7'))).toBe(false)
  await ui.press({ key: 'confirm' })
  await new Promise(r => setTimeout(r, 50))
  expect(ran.find(a => a[0] === 'claude' && a.includes('context7'))?.slice(0, 4)).toEqual(['claude', 'mcp', 'add', '--scope'])
  await ui.unmount()
})

test('the two code graphs are never installed together, Serena goes with either', async ($, on) => {
  const ran: string[][] = []
  files['/home/u/.claude.json'] = JSON.stringify({ mcpServers: { serena: {}, graphify: {} } })
  engine(on, { code: true, ran, filled: [], toasts: [] })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await openGroups(ui)
  expect(await ui.find({ type: 'Text', text: /Remova Graphify antes/ })).toBeDefined()
  expect(await ui.find({ key: 'repo:serena' })).toBeDefined()
  expect(await ui.find({ key: 'repo:context7' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Remova Serena/ })).toBeUndefined()
  await ui.press({ key: 'install:codebase-memory' })
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  delete files['/home/u/.claude.json']
  await ui.unmount()
})

test('a prompt with a stack trace suggests the debugging skill, once', async ($, on) => {
  const toasts: string[] = []
  engine(on, { code: true, ran: [], filled: [], toasts })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'deu NullPointerException no login', origin: { kind: 'composer' } } as any)
  await $.prompt.submit({ text: 'outro erro aqui', origin: { kind: 'composer' } } as any)
  expect(toasts.filter(t => t.includes('Depurar a fundo')).length).toBe(1)
})

test('bundled skills: one GitHub check a week, an update only after a confirm, fitted to the mod', async ($, on) => {
  const urls: string[] = []
  const writes: Record<string, string> = {}
  files['/plugin-lock'] = ''
  const curl = (url: string) => {
    urls.push(url)
    if (url.includes('/commits?')) return JSON.stringify([{ sha: 'b'.repeat(40), commit: { committer: { date: '2026-11-20T00:00:00Z' } } }])
    if (url.includes('/contents/')) return JSON.stringify([{ name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' }])
    return '---\nname: ponytail\ndescription: >\n  folded\n  text\nlicense: MIT\n---\n# Ponytail\nnew rules\n'
  }
  engine(on, { code: true, ran: [], filled: [], toasts: [], curl, writes })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 80))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 80))
  expect(urls.filter(u => u.includes('/commits?')).length).toBe(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await openGroups(ui)
  expect(await ui.find({ type: 'Text', text: /Atualização para 1 skill/ })).toBeDefined()
  await ui.press({ key: 'apply-updates' })
  expect(Object.keys(writes).length).toBe(0)
  await ui.press({ key: 'confirm-updates' })
  await new Promise(r => setTimeout(r, 80))
  const skill = Object.entries(writes).find(([k]) => k.endsWith('/skills/ponytail/SKILL.md'))?.[1] ?? ''
  expect(skill).toContain('disable-model-invocation: true')
  expect(skill).toContain('license: MIT')
  expect(skill).toContain('description: >\n  folded\n  text\n')
  expect(skill).toContain('<!-- From DietrichGebert/ponytail (skills/ponytail) at bbbbbbbbbbbb, MIT License.')
  expect(skill).toContain('new rules')
  const lock = Object.entries(writes).find(([k]) => k.endsWith('/upstream.lock.json'))?.[1] ?? ''
  expect(lock).toContain('b'.repeat(40))
  await ui.unmount()
})

test('Serena activating a project shows a band once, and Abrir painel looks up this chat\'s dashboard', async ($, on) => {
  const ran: string[][] = []
  const sh: string[][] = []
  engine(on, { code: true, ran, filled: [], toasts: [], sh, shOut: 'http://127.0.0.1:24283/dashboard/index.html\n' })
  on('tool.call', () => ({ result: 'activated' }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } }
  const band = await $.ui.mount({ plugin: 'coding-kit', component: 'AbovePrompt', props, surface: 'desktop' } as any)
  expect(await band.find({ key: 'serena-open' })).toBeUndefined()
  await $.tool.call({ tool: 'mcp__serena__activate_project', project: '/work/app', session: 'ab12cd34', tool_use_id: 'u1' } as any)
  expect(await band.find({ key: 'serena-open' })).toBeDefined()
  await band.press({ key: 'serena-open' })
  await new Promise(r => setTimeout(r, 50))
  expect(sh.some(a => a.at(-1) === 'ab12cd34')).toBe(true)
  // Opening goes through mods-core's $.mods.open.
  expect(calls.some(c => c.method === 'open' && (c.args as { target?: string }).target === 'http://127.0.0.1:24283/dashboard/index.html')).toBe(true)
  expect(await band.find({ key: 'serena-open' })).toBeUndefined()
  await $.tool.call({ tool: 'mcp__serena__activate_project', project: '/work/app', session: 'other', tool_use_id: 'u2' } as any)
  expect(await band.find({ key: 'serena-open' })).toBeUndefined()
  await band.unmount()
})

test('a typed skill command is painted orange and gets a band; ✕ takes only the command out', async ($, on) => {
  const filled: string[] = []
  engine(on, { code: true, ran: [], filled, toasts: [] })
  const box = { text: '', cursor: 0 }
  on('prompt.edit', (_: any, e: any) => {
    box.text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    box.cursor = e.start + e.inputText.length
    return { ...box }
  })
  on('prompt.read', () => ({ value: { ...box } }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } }
  const band = await $.ui.mount({ plugin: 'coding-kit', component: 'AbovePrompt', props, surface: 'desktop' } as any)
  const type = (inputText: string) => $.prompt.edit({ origin: { kind: 'composer' }, text: box.text, cursor: box.cursor, start: box.cursor, end: box.cursor, inputText } as any)

  // A slash that is not a skill: no paint, no band.
  let r: any = await type('/nada ')
  expect(r.decorations ?? []).toEqual([])
  expect(await band.find({ key: 'skill-close' })).toBeUndefined()
  box.text = ''
  box.cursor = 0

  r = await type('/coding-kit:grill-me quero um cache')
  expect(r.decorations).toEqual([{ start: 0, end: 20, color: '#d97757' }])
  expect(await band.find({ type: 'Text', text: /Interrogar o plano/ })).toBeDefined()
  // Minimized: no card buttons; opened: the card, without Usar.
  expect(await band.find({ key: 'repo:grill-me' })).toBeUndefined()
  await band.press({ key: 'skill-open' })
  expect(await band.find({ type: 'Text', text: /Entrevista em rodadas/ })).toBeDefined()
  expect(await band.find({ key: 'use:grill-me' })).toBeUndefined()

  await band.press({ key: 'skill-close' })
  expect(filled.at(-1)).toBe('quero um cache')
  expect(await band.find({ key: 'skill-close' })).toBeUndefined()

  // The short name counts too.
  box.text = ''
  box.cursor = 0
  r = await type('/grill-me')
  expect(r.decorations).toEqual([{ start: 0, end: 9, color: '#d97757' }])
  await band.unmount()
})

test('a Tab completion without a prompt event updates the skill band by polling', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * 24 * 3600 * 1000 })
  const box = { text: '', cursor: 0 }
  on('prompt.read', () => ({ value: { ...box } }))
  on('prompt.edit', (_: any, e: any) => {
    box.text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    box.cursor = box.text.length
    return { ...box }
  })
  engine(on, { code: true, ran: [], filled: [], toasts: [], mockClock: true })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } }
  const band = await $.ui.mount({ plugin: 'coding-kit', component: 'AbovePrompt', props, surface: 'desktop' } as any)
  // Initial slash typing emits prompt.edit, but the Tab completion does not.
  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: '/gri' } as any)
  expect(await band.find({ key: 'skill-close' })).toBeUndefined()
  box.text = '/coding-kit:grill-me '
  box.cursor = box.text.length
  await clock.advance(1000)
  expect(await band.find({ key: 'skill-close' })).toBeDefined()
  // A non-skill completion removes the card without needing prompt.change.
  box.text = '/unknown '
  box.cursor = box.text.length
  await clock.advance(1000)
  expect(await band.find({ key: 'skill-close' })).toBeUndefined()
  await band.unmount()
})

test('history and clipboard fills can reveal a skill command even when the prior draft had no slash', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * 24 * 3600 * 1000 })
  const box = { text: '', cursor: 0 }
  on('prompt.read', () => ({ value: { ...box } }))
  engine(on, { code: true, ran: [], filled: [], toasts: [], mockClock: true })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } }
  const band = await $.ui.mount({ plugin: 'coding-kit', component: 'AbovePrompt', props, surface: 'desktop' } as any)

  // Neither a paste nor a history selection emits prompt.edit in this simulation.
  box.text = '/coding-kit:grill-me '
  await clock.advance(2000)
  expect(await band.find({ key: 'skill-close' })).toBeDefined()
  box.text = 'bom dia'
  await clock.advance(2000)
  expect(await band.find({ key: 'skill-close' })).toBeUndefined()
  box.text = '/grill-me '
  await clock.advance(2000)
  expect(await band.find({ key: 'skill-close' })).toBeDefined()
  await band.unmount()
})

test('Usar in the pane paints its own fill and shows the band; a Tab completion with no event is read from the box', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * 24 * 3600 * 1000 })
  const fills: any[] = []
  const box = { text: '', cursor: 0 }
  on('prompt.read', () => ({ value: { ...box } }))
  // prompt.paint is a method, not a hookable event in Claude Code 2.1.330.
  on('prompt.edit', (_: any, e: any) => {
    box.text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    box.cursor = box.text.length
    return { ...box }
  })
  engine(on, { code: true, ran: [], filled: [], toasts: [], mockClock: true, fillArgs: fills })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } }
  const band = await $.ui.mount({ plugin: 'coding-kit', component: 'AbovePrompt', props, surface: 'desktop' } as any)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await openGroups(pane)
  await pane.press({ key: 'use:grill-me' })
  await pane.unmount()
  expect(fills.at(-1).decorations).toEqual([{ start: 0, end: 20, color: '#d97757' }])
  expect(await band.find({ key: 'skill-close' })).toBeDefined()

  // Clear, type "/gri", then the box turns into the completed command without any event.
  await band.press({ key: 'skill-close' })
  box.text = ''
  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: '/gri' } as any)
  expect(await band.find({ key: 'skill-close' })).toBeUndefined()
  box.text = '/grill-me '
  await clock.advance(1000)
  expect(await band.find({ key: 'skill-close' })).toBeDefined()
  await band.unmount()
})

test('every pane section hides and shows, and Usar is off for the skill already in the prompt', async ($, on) => {
  engine(on, { code: true, ran: [], filled: [], toasts: [] })
  const box = { text: '', cursor: 0 }
  on('prompt.edit', (_: any, e: any) => {
    box.text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    box.cursor = box.text.length
    return { ...box }
  })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  // Hidden at first, like Suas skills.
  expect(await ui.find({ key: 'use:grill-me' })).toBeUndefined()
  await ui.press({ key: 'toggle-group:plan' })
  expect(await ui.find({ key: 'use:grill-me' })).toBeDefined()
  expect(await ui.find({ key: 'use:systematic-debugging' })).toBeUndefined()
  await ui.press({ key: 'toggle-group:plan' })
  expect(await ui.find({ key: 'use:grill-me' })).toBeUndefined()
  await openGroups(ui)

  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: '/grill-me ' } as any)
  expect(await ui.find({ key: 'use:grill-me' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Usar · já no prompt' })).toBeDefined()
  expect(await ui.find({ key: 'use:systematic-debugging' })).toBeDefined()
  await ui.unmount()
})


// ---- the pane's install engine: plugins, what changes, steps, actions, conflicts, mods, projects ----

const lab = {
  groups: [{ id: 'tools', title: 'Ferramentas' }, { id: 'matt', title: 'Matt', setup: { label: 'Configurar este repositório', command: '/coding-kit:setup-x', done: 'docs/agents/issue-tracker.md' } }],
  exclusives: { shrink: 'Os dois reescrevem o mesmo comando do Bash.' },
  items: [
    { id: 'webguide', kind: 'plugin', group: 'tools', label: 'Web Guide', description: 'Guias.', plugin: 'web-guide@acme', marketplace: 'acme/web-guide', changes: ['Adiciona o plugin web-guide (global).'] },
    { id: 'shrink', kind: 'tool', group: 'tools', label: 'Shrink', description: 'Encolhe.', exclusive: 'shrink', check: { argv: ['shrink', '--version'], match: 'shrink 1' }, env: { SHRINK_TELEMETRY_DISABLED: '1' },
      install: [['/bin/sh', '-c', 'curl -fsSL https://x/install.sh | sh'], { argv: ['shrink', 'gain'], match: 'Savings' }, ['shrink', 'init', '-g']],
      uninstall: [['shrink', 'init', '-g', '--uninstall']],
      changes: ['Um hook em ~/.claude/settings.json.'],
      actions: [{ id: 'gain', label: 'Economia', run: ['shrink', 'gain'] }],
      overlapsMod: { mod: 'input-router', why: 'Faz o mesmo papel do input-router.' } },
    { id: 'squeeze', kind: 'tool', group: 'tools', label: 'Squeeze', description: 'Também encolhe.', exclusive: 'shrink', check: { argv: ['squeeze', '--version'] }, install: [['squeeze', 'init']], uninstall: [['squeeze', 'off']] },
    { id: 'docs', kind: 'mcp', group: 'tools', label: 'Docs', description: 'Docs.', server: 'docs', prepared: '.docs-index',
      install: [['claude', 'mcp', 'add', 'docs']], uninstall: [['claude', 'mcp', 'remove', 'docs']],
      actions: [{ id: 'always', label: 'Usar sempre', offLabel: 'Parar de usar sempre', rule: 'Always use Docs for library docs.' }, { id: 'index', label: 'Indexar este projeto', fill: 'Indexe este projeto com o Docs' }] },
    { id: 'ask', kind: 'skill', group: 'matt', sub: 'Engenharia', label: 'Ask', description: 'Roteia.', command: '/coding-kit:ask' },
    { id: 'spec', kind: 'skill', group: 'matt', sub: 'Engenharia', label: 'Spec', description: 'Spec.', command: '/coding-kit:spec', needsSetup: true },
  ],
}

function labEngine(on: any, extra: { ran: string[][]; filled?: string[]; run?: (argv: string[], init: any) => any }) {
  engine(on, { code: true, ran: extra.ran, filled: extra.filled ?? [], toasts: [], catalog: lab, run: extra.run, writeThrough: true })
}
async function labPane($: any) {
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 30))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  for (const g of ['tools', 'matt']) await ui.press({ key: `toggle-group:${g}` })
  return ui
}
const settle = () => new Promise(r => setTimeout(r, 60))

test('a plugin item installs through the marketplace, shows what changes first, and reads its state from installed_plugins.json', async ($, on) => {
  const ran: string[][] = []
  labEngine(on, { ran, run: argv => (argv[0] === 'claude' ? {} : undefined) })
  const ui = await labPane($)
  await ui.press({ key: 'install:webguide' })
  expect(await ui.find({ type: 'Text', text: /Adiciona o plugin web-guide/ })).toBeDefined()
  expect(ran.some(a => a[0] === 'claude')).toBe(false)
  await ui.press({ key: 'confirm' })
  await settle()
  const claude = ran.filter(a => a[0] === 'claude').map(a => a.join(' '))
  expect(claude).toContain('claude plugin marketplace add acme/web-guide')
  expect(claude).toContain('claude plugin install web-guide@acme')
  files['/home/u/.claude/plugins/installed_plugins.json'] = JSON.stringify({ plugins: { 'web-guide@acme': [{ scope: 'user' }] } })
  await ui.press({ key: 'refresh' })
  await settle()
  expect(await ui.find({ key: 'remove:webguide' })).toBeDefined()
  await ui.press({ key: 'remove:webguide' })
  await ui.press({ key: 'confirm' })
  await settle()
  expect(ran.map(a => a.join(' '))).toContain('claude plugin uninstall web-guide@acme')
  delete files['/home/u/.claude/plugins/installed_plugins.json']
  await ui.unmount()
})

test('install steps get the item env and ~/.local/bin on PATH; a failed check stops the install and undoes it', async ($, on) => {
  const ran: string[][] = []
  const envs: any[] = []
  labEngine(on, { ran, run: (argv, init) => {
    if (argv[0] === '/bin/sh' || argv[0] === 'shrink') envs.push(init.env ?? {})
    if (argv[0] === 'shrink' && argv[1] === 'gain') return { stdout: 'rtk: Rust Type Kit' }
    if (argv[0] === 'shrink' || argv[0] === '/bin/sh') return {}
    if (argv[0] === 'squeeze') return { exitCode: 1 }
    return undefined
  } })
  const ui = await labPane($)
  await ui.press({ key: 'install:shrink' })
  await ui.press({ key: 'confirm' })
  await settle()
  expect(envs[0].SHRINK_TELEMETRY_DISABLED).toBe('1')
  expect(String(envs[0].PATH)).toContain('/home/u/.local/bin')
  expect(ran.some(a => a.join(' ') === 'shrink init -g')).toBe(false)
  expect(ran.some(a => a.join(' ') === 'shrink init -g --uninstall')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /desfeito/ })).toBeDefined()
  await ui.unmount()
})

test('a conflicting tool says why; an overlapping mod can be turned off and back on from the card', async ($, on) => {
  const ran: string[][] = []
  labEngine(on, { ran, run: argv => (argv[0] === 'shrink' && argv[1] === '--version' ? { stdout: 'shrink 1.2' } : argv[0] === 'squeeze' ? { exitCode: 1 } : undefined) })
  const ui = await labPane($)
  expect(await ui.find({ type: 'Text', text: /Remova Shrink antes: Os dois reescrevem o mesmo comando do Bash\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Faz o mesmo papel do input-router\./ })).toBeDefined()
  await ui.press({ key: 'mod-off:shrink' })
  expect(JSON.parse(files['/home/u/.claude/mods/switches.json'] ?? '{}')['input-router']).toBe(false)
  expect(await ui.find({ key: 'mod-on:shrink' })).toBeDefined()
  await ui.press({ key: 'mod-on:shrink' })
  expect(JSON.parse(files['/home/u/.claude/mods/switches.json'] ?? '{}')['input-router']).toBeUndefined()
  delete files['/home/u/.claude/mods/switches.json']
  await ui.unmount()
})

test('card actions: a command shows its output, a rule goes in and out of CLAUDE.md, a fill writes the prompt; a prepared project shows', async ($, on) => {
  const ran: string[][] = []
  const filled: string[] = []
  files['/home/u/.claude.json'] = JSON.stringify({ mcpServers: { docs: {} } })
  files['/home/u/.claude/CLAUDE.md'] = '# Mine\nkeep this\n'
  files['/work/app/.docs-index'] = '1'
  labEngine(on, { ran, filled, run: argv => (argv[0] === 'shrink' && argv[1] === '--version' ? { stdout: 'shrink 1.2' } : argv[0] === 'shrink' && argv[1] === 'gain' ? { stdout: 'Savings: 42%' } : argv[0] === 'squeeze' ? { exitCode: 1 } : undefined) })
  const ui = await labPane($)
  await ui.press({ key: 'action:shrink/gain' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /Savings: 42%/ })).toBeDefined()

  await ui.press({ key: 'action:docs/always' })
  await settle()
  expect(files['/home/u/.claude/CLAUDE.md']).toContain('keep this')
  expect(files['/home/u/.claude/CLAUDE.md']).toContain('Always use Docs for library docs.')
  expect((await ui.find({ key: 'action:docs/always' }))?.props.label).toBe('Parar de usar sempre')
  await ui.press({ key: 'action:docs/always' })
  await settle()
  expect(files['/home/u/.claude/CLAUDE.md']).toBe('# Mine\nkeep this\n')

  await ui.press({ key: 'action:docs/index' })
  expect(filled.at(-1)).toBe('Indexe este projeto com o Docs')
  expect(await ui.find({ type: 'Text', text: /pronto neste projeto/ })).toBeDefined()
  for (const f of ['/home/u/.claude.json', '/home/u/.claude/CLAUDE.md', '/work/app/.docs-index']) delete files[f]
  await ui.unmount()
})

test('a group with a setup: its skills wait for it, the setup button fills its command, and Usar comes back once it ran', async ($, on) => {
  const ran: string[][] = []
  const filled: string[] = []
  labEngine(on, { ran, filled })
  const ui = await labPane($)
  expect(await ui.find({ type: 'Text', text: 'Engenharia' })).toBeDefined()
  expect(await ui.find({ key: 'use:ask' })).toBeDefined()
  expect(await ui.find({ key: 'use:spec' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /precisa configurar antes/ })).toBeDefined()
  await ui.press({ key: 'setup:matt' })
  expect(filled.at(-1)).toBe('/coding-kit:setup-x ')
  files['/work/app/docs/agents/issue-tracker.md'] = 'github'
  await ui.press({ key: 'refresh' })
  await settle()
  expect(await ui.find({ key: 'use:spec' })).toBeDefined()
  delete files['/work/app/docs/agents/issue-tracker.md']
  await ui.unmount()
})


// ---- bundled-skill updates for a repo of many skills ----

const many = {
  groups: [{ id: 'matt', title: 'Matt' }],
  items: [],
  skills: [
    { dir: 'diag', repo: 'm/s', path: 'skills/eng/diag', exclude: ['agents'], credit: 'MIT', frontmatter: { 'disable-model-invocation': 'true' },
      rewrite: [{ find: 'Call the Skill tool with "(?!coding-kit:)([a-z-]+)"', replace: 'Call the Skill tool with "coding-kit:$1"', regex: true }] },
    { dir: 'tdd', repo: 'm/s', path: 'skills/eng/tdd', credit: 'MIT' },
  ],
}

test('a bundled skill comes with its subfolders but not an excluded one, and a regex rewrite keeps what it captured', async ($, on) => {
  const urls: string[] = []
  const writes: Record<string, string> = {}
  const curl = (url: string) => {
    urls.push(url)
    if (url.includes('/commits?')) return JSON.stringify([{ sha: url.includes('diag') ? 'c'.repeat(40) : 'd'.repeat(40), commit: { committer: { date: '2026-11-20T00:00:00Z' } } }])
    if (url.includes('/contents/skills/eng/diag/scripts')) return JSON.stringify([{ name: 'loop.sh', type: 'file', download_url: 'https://raw.example/loop.sh' }])
    if (url.includes('/contents/skills/eng/diag')) return JSON.stringify([
      { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/diag.md' },
      { name: 'scripts', type: 'dir', download_url: null },
      { name: 'agents', type: 'dir', download_url: null },
    ])
    if (url.includes('/contents/skills/eng/tdd')) return JSON.stringify([{ name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/tdd.md' }])
    if (url.endsWith('/loop.sh')) return 'echo loop\n'
    if (url.endsWith('/diag.md')) return '---\nname: diag\ndescription: d\n---\nThen Call the Skill tool with "tdd" here.\n'
    return '---\nname: tdd\ndescription: t\n---\nRed green.\n'
  }
  engine(on, { code: true, ran: [], filled: [], toasts: [], curl, writes, catalog: many, lock: '{}' })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 100))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'apply-updates' })
  await ui.press({ key: 'confirm-updates' })
  await new Promise(r => setTimeout(r, 100))
  const skill = Object.entries(writes).find(([k]) => k.endsWith('/skills/diag/SKILL.md'))?.[1] ?? ''
  expect(skill).toContain('Call the Skill tool with "coding-kit:tdd"')
  expect(Object.entries(writes).find(([k]) => k.endsWith('/skills/diag/scripts/loop.sh'))?.[1]).toBe('echo loop\n')
  expect(urls.some(u => u.includes('/contents/skills/eng/diag/agents'))).toBe(false)
  expect(Object.keys(writes).some(k => k.includes('/skills/diag/agents'))).toBe(false)
  await ui.unmount()
})

test('a repo of many skills costs one GitHub request a week when none of them changed', async ($, on) => {
  const urls: string[] = []
  const gate = 'e'.repeat(40)
  const curl = (url: string) => {
    urls.push(url)
    return JSON.stringify([{ sha: gate, commit: { committer: { date: '2026-11-20T00:00:00Z' } } }])
  }
  const lock = JSON.stringify({ '@m/s': { sha: gate, date: '2026-11-20T00:00:00Z' }, diag: { sha: 'c'.repeat(40), date: 'x' }, tdd: { sha: 'd'.repeat(40), date: 'x' } })
  engine(on, { code: true, ran: [], filled: [], toasts: [], curl, catalog: many, lock })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 100))
  const commits = urls.filter(u => u.includes('/commits?'))
  expect(commits.length).toBe(1)
  expect(commits[0]).toContain('path=skills%2Feng&')
})

test('recommended tools carry a mark, and one button installs the ones still missing after a single confirm listing what changes', async ($, on) => {
  const ran: string[][] = []
  const rec = {
    groups: [{ id: 'tools', title: 'Ferramentas' }],
    items: [
      { id: 'a', kind: 'tool', group: 'tools', label: 'Alpha', description: 'a', recommended: true, check: { argv: ['alpha', '--v'] }, install: [['alpha', 'setup']], changes: ['Alpha muda isto.'] },
      { id: 'b', kind: 'tool', group: 'tools', label: 'Beta', description: 'b', recommended: true, check: { argv: ['beta', '--v'] }, install: [['beta', 'setup']], changes: ['Beta muda aquilo.'] },
      { id: 'c', kind: 'tool', group: 'tools', label: 'Gamma', description: 'c', check: { argv: ['gamma', '--v'] }, install: [['gamma', 'setup']], changes: ['Gamma.'] },
    ],
  }
  engine(on, { code: true, ran, filled: [], toasts: [], catalog: rec, run: argv => (argv[1] === '--v' ? { exitCode: argv[0] === 'beta' ? 0 : 1 } : argv[1] === 'setup' ? {} : undefined) })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 40))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect((await ui.find({ key: 'install-recommended' }))?.props.label).toBe('Instalar os recomendados (1)')
  await ui.press({ key: 'toggle-group:tools' })
  expect(await ui.find({ type: 'Text', text: /★ recomendado/ })).toBeDefined()
  await ui.press({ key: 'install-recommended' })
  expect(await ui.find({ type: 'Text', text: /Alpha muda isto\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Beta muda aquilo\./ })).toBeUndefined()
  expect(ran.some(a => a[1] === 'setup')).toBe(false)
  await ui.press({ key: 'confirm-recommended' })
  await new Promise(r => setTimeout(r, 60))
  expect(ran.filter(a => a[1] === 'setup').map(a => a[0])).toEqual(['alpha'])
  await ui.unmount()
})

test('a card keeps its title row for the name, with the recommended mark and the install state side by side below it', async ($, on) => {
  const cat = { groups: [{ id: 'tools', title: 'Ferramentas' }], items: [{ id: 'a', kind: 'tool', group: 'tools', label: 'Alpha', description: 'a', recommended: true, repo: 'https://x', check: { argv: ['alpha'] }, install: [['alpha']], changes: ['x'] }] }
  engine(on, { code: true, ran: [], filled: [], toasts: [], catalog: cat })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 40))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'toggle-group:tools' })
  const title = await ui.find({ key: 'title-a' })
  const badges = await ui.find({ key: 'badges-a' })
  expect(JSON.stringify(title)).not.toContain('recomendado')
  expect(JSON.stringify(title)).not.toContain('instalado')
  expect(JSON.stringify(badges)).toContain('★ recomendado')
  expect(JSON.stringify(badges)).toContain('✓ instalado')
  await ui.unmount()
})

test('recommended items come first in their section, and a conflict note sits above the buttons, not beside them', async ($, on) => {
  const cat = {
    groups: [{ id: 'tools', title: 'Ferramentas' }],
    exclusives: { x: 'Fazem o mesmo papel.' },
    items: [
      { id: 'plain', kind: 'tool', group: 'tools', label: 'Plain', description: 'p', exclusive: 'x', check: { argv: ['plain'] }, install: [['plain']], changes: ['p'] },
      { id: 'held', kind: 'tool', group: 'tools', label: 'Held', description: 'h', exclusive: 'x', check: { argv: ['held'] }, install: [['held']], changes: ['h'] },
      { id: 'star', kind: 'tool', group: 'tools', label: 'Star', description: 's', recommended: true, check: { argv: ['star'] }, install: [['star']], changes: ['s'] },
    ],
  }
  engine(on, { code: true, ran: [], filled: [], toasts: [], catalog: cat, run: argv => (['plain', 'star'].includes(argv[0]!) ? { exitCode: 1 } : argv[0] === 'held' ? {} : undefined) })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 40))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'toggle-group:tools' })
  const group = JSON.stringify(await ui.find({ key: 'group-tools' }))
  expect(group.indexOf('card-star')).toBeGreaterThan(-1)
  expect(group.indexOf('card-star')).toBeLessThan(group.indexOf('card-plain'))
  expect(group.indexOf('card-plain')).toBeLessThan(group.indexOf('card-held'))
  expect(JSON.stringify(await ui.find({ key: 'clash-plain' }))).toContain('Remova Held antes')
  expect(JSON.stringify(await ui.find({ key: 'buttons-plain' }))).not.toContain('Remova')
  expect(JSON.stringify(await ui.find({ key: 'buttons-plain' }))).toContain('install:plain')
  await ui.unmount()
})

test('a section setup done during a chat shows as done at the end of that reply, with no reload', async ($, on) => {
  const filled: string[] = []
  engine(on, { code: true, ran: [], filled, toasts: [], catalog: lab })
  on('turn.complete', (_: any, e: any) => ({ turnId: e.turnId, text: '' }))
  const ui = await labPane($)
  expect(await ui.find({ key: 'setup:matt' })).toBeDefined()
  files['/work/app/docs/agents/issue-tracker.md'] = 'github'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
  await settle()
  expect(await ui.find({ key: 'setup:matt' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /configurado neste repositório/ })).toBeDefined()
  expect(await ui.find({ key: 'use:spec' })).toBeDefined()
  delete files['/work/app/docs/agents/issue-tracker.md']
  await ui.unmount()
})
