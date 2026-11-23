import { expect, mock, test } from 'claude-code/testing'
// A slice of catalog.json (a test can not import JSON).
const catalogJson = {"groups": [{"id": "plan", "title": "Planejar"}, {"id": "build", "title": "Construir"}, {"id": "fix", "title": "Corrigir"}, {"id": "review", "title": "Revisar"}, {"id": "tools", "title": "Ferramentas (instalar com um clique)"}], "items": [{"id": "grill-me", "kind": "skill", "group": "plan", "label": "Interrogar o plano", "command": "/coding-kit:grill-me", "description": "Entrevista em rodadas até o plano ficar claro, com uma resposta recomendada para cada pergunta. Use antes de uma funcionalidade grande ou ainda nebulosa.", "source": "mattpocock/skills (MIT)"}, {"id": "systematic-debugging", "kind": "skill", "group": "fix", "label": "Depurar a fundo", "command": "/coding-kit:systematic-debugging", "description": "Acha a causa raiz antes de mexer no código: reproduz, compara, testa uma hipótese por vez. Para bug difícil ou que já resistiu a uma tentativa.", "source": "obra/superpowers (MIT)", "hint": "stack ?trace|traceback|exception|\\berro\\b|\\berror\\b|n[aã]o funciona|quebrou|falhando|\\bbug\\b|nullpointer|undefined is not|segfault"}, {"id": "context7", "kind": "mcp", "group": "tools", "label": "Context7", "server": "context7", "fill": "use context7 para ", "description": "Documentação atualizada de bibliotecas (React, Spring, Prisma...). Servidor remoto, sem instalar nada local; suas ferramentas ficam atrás da busca e só custam contexto quando usadas.", "install": [["claude", "mcp", "add", "--scope", "user", "--transport", "http", "context7", "https://mcp.context7.com/mcp"]], "uninstall": [["claude", "mcp", "remove", "--scope", "user", "context7"]]}, {"id": "serena", "repo": "https://github.com/oraios/serena", "kind": "mcp", "group": "tools", "label": "Serena (busca semântica e refatoração)", "server": "serena", "needs": ["uvx"], "fill": "Use o Serena (ative este projeto primeiro, se ainda não estiver ativo) para ", "description": "Acha onde cada função ou classe é definida e quem a usa, via LSP, e edita símbolo a símbolo. Rende em refatorar projetos grandes; em projetos pequenos pouco ajuda.", "install": [["claude", "mcp", "add", "--scope", "user", "serena", "--", "uvx", "--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "--context", "claude-code", "--open-web-dashboard", "false"]], "uninstall": [["claude", "mcp", "remove", "--scope", "user", "serena"]]}, {"id": "codebase-memory", "kind": "mcp", "group": "tools", "label": "codebase-memory (grafo do código)", "server": "codebase-memory", "exclusive": "code-intel", "needs": ["npx"], "fill": "Use o grafo do codebase-memory (indexe o repositório se preciso) para ", "description": "Indexa o código num grafo local que dura entre chats: quem chama cada função, imports e rotas HTTP. Responde perguntas de estrutura sem ler arquivo por arquivo.", "install": [["claude", "mcp", "add", "--scope", "user", "codebase-memory", "--", "npx", "-y", "codebase-memory-mcp"]], "uninstall": [["claude", "mcp", "remove", "--scope", "user", "codebase-memory"]]}, {"id": "graphify", "kind": "mcp", "group": "tools", "label": "Graphify (grafo de código e docs)", "server": "graphify", "exclusive": "code-intel", "install": [["true"]], "uninstall": [["true"]]}], "skills": [{"dir": "ponytail", "repo": "DietrichGebert/ponytail", "path": "skills/ponytail", "credit": "MIT License", "frontmatter": {"disable-model-invocation": "true"}}]}

const PANE = {
  plugin: 'coding-kit',
  component: 'Pane',
  requestId: 'coding-kit',
  props: { title: 'Coding Kit', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const files: Record<string, string> = {}

// Stands for the engine: a project folder, the plugin's own files, and the commands the pane runs.
function engine(on: any, opts: { code: boolean; ran: string[][]; filled: string[]; toasts: string[]; curl?: (url: string) => string; writes?: Record<string, string>; dir?: { v: string }; opened?: string[]; sh?: string[][]; shOut?: string; mockClock?: boolean; fillArgs?: any[] }) {
  const own = (path: string) => (path.endsWith('/catalog.json') ? JSON.stringify(catalogJson) : path.endsWith('/skills/ponytail/SKILL.md') ? '---\nname: ponytail\n---\n# Ponytail\nActive for the whole session.\nrules here' : undefined)
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
    return { value: undefined }
  })
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv
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
  expect(sh.some(a => a.at(-1) === 'http://127.0.0.1:24283/dashboard/index.html')).toBe(true)
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

test('a Tab completion (no prompt.edit) is painted too, and once more after the app styles it', async ($, on) => {
  engine(on, { code: true, ran: [], filled: [], toasts: [] })
  const painted: any[] = []
  on('prompt.paint', (_: any, e: any) => {
    painted.push(e.decorations)
    return { value: { isPainted: true, text: e.text, cursor: e.text.length } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('prompt.change', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.change({ text: '/coding-kit:grill-me ', cursor: 21, origin: { kind: 'engine' } } as any)
  await new Promise(r => setTimeout(r, 50))
  expect(painted.length).toBe(2)
  expect(painted[0]).toEqual([{ start: 0, end: 20, color: '#d97757' }])
})

test('Usar in the pane paints its own fill and shows the band; a Tab completion with no event is read from the box', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * 24 * 3600 * 1000 })
  const fills: any[] = []
  const box = { text: '', cursor: 0 }
  on('prompt.read', () => ({ value: { ...box } }))
  on('prompt.paint', (_: any, e: any) => ({ value: { isPainted: true, text: e.text, cursor: e.text.length } }))
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
  expect(await ui.find({ key: 'use:grill-me' })).toBeDefined()
  await ui.press({ key: 'toggle-group:plan' })
  expect(await ui.find({ key: 'use:grill-me' })).toBeUndefined()
  expect(await ui.find({ key: 'use:systematic-debugging' })).toBeDefined()
  await ui.press({ key: 'toggle-group:plan' })
  expect(await ui.find({ key: 'use:grill-me' })).toBeDefined()

  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: '/grill-me ' } as any)
  expect(await ui.find({ key: 'use:grill-me' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Usar · já no prompt' })).toBeDefined()
  expect(await ui.find({ key: 'use:systematic-debugging' })).toBeDefined()
  await ui.unmount()
})
