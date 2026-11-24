import { expect, test } from 'claude-code/testing'

// An in-memory home: files, folders, and the few commands the mod runs (mkdir, append, find, rg).
const HOME = '/home/u'
const VAULT = `${HOME}/Vault`

function engine(on: any, o: { qmd?: string } = {}) {
  // The mod's own templates, wherever the test puts the plugin.
  const tpl: Record<string, string> = {
    'para/CLAUDE.md': '# Este vault\nPARA',
    'para/Home.md': '# Home',
    'para/Templates/Project.md': '![[Claude.base#Do projeto]]',
    'common/Claude/Claude.base': 'file.hasLink(this.file)',
  }
  const own = (p: string) => p.match(/\/template\/(.+)$/)?.[1]
  const files: Record<string, string> = {}
  const mtimes: Record<string, number> = {}
  const dirs = new Set<string>()
  const store = new Map<string, unknown>()
  const contexts: (readonly string[] | undefined)[] = []
  const submitted: string[] = []
  let now = Date.UTC(2026, 10, 24, 15, 0)
  const t = { qmdRuns: [] as string[][] }
  const write = (p: string, t: string) => ((files[p] = t), (mtimes[p] = now))
  const under = (d: string) => Object.keys(files).filter(p => p.startsWith(`${d}/`))

  on('clock.now', () => ({ value: now }))
  on('clock.after', () => ({ value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.cwd', () => ({ value: `${HOME}/work/app` }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('state.get', (_: any, e: any) => ({ value: store.get(`state:${e.key}`) }))
  on('state.set', (_: any, e: any) => (store.set(`state:${e.key}`, e.value), { value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files || dirs.has(e.path) || under(e.path).length > 0 }))
  on('fs.read', (_: any, e: any) => {
    const t = own(e.path)
    if (t && t in tpl) return { value: tpl[t] }
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path] }
  })
  on('fs.write', (_: any, e: any) => (write(e.path, String(e.text)), { value: undefined }))
  on('fs.list', (_: any, e: any) => ({
    value: under(e.path)
      .filter(p => !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file', size: files[p]!.length, mtimeMs: mtimes[p] ?? 0, isLink: false })),
  }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv[0] === 'mkdir') return (argv.slice(2).forEach(d => dirs.add(d)), ok())
    if (argv[0] === '/bin/sh') {
      const script = argv[2]!
      if (script.startsWith('command -v qmd')) return o.qmd === undefined ? { value: { exitCode: 1, stdout: '', stderr: '' } } : ok('/x/qmd\n')
      if (script.includes('cat >>')) return (write(argv[4]!, (files[argv[4]!] ?? '') + e.init.stdin), ok())
      if (script.includes('find . -type f')) {
        const d = `${own(argv[4]!)}/`
        return ok(Object.keys(tpl).filter(k => k.startsWith(d)).map(k => `./${k.slice(d.length)}`).join('\n'))
      }
      return ok()
    }
    if (argv[0] === '/x/qmd') {
      t.qmdRuns.push(argv)
      if (argv[1] === 'vsearch') return ok(o.qmd)
      return ok()
    }
    if (argv[0] === 'rg') {
      const dir: string = e.init.cwd
      const md = under(dir)
        .map(p => `.${p.slice(dir.length)}`)
        .filter(p => p.endsWith('.md') && !/^\.\/(Daily|Templates)\/|^\.\/CLAUDE\.md$|\/\.obsidian\//.test(p))
      if (argv[1] === '--files') return ok(md.join('\n'))
      const terms = argv.flatMap((a, i) => (argv[i - 1] === '-e' ? [a] : []))
      const out = md.flatMap(p => terms.flatMap(t => (files[`${dir}${p.slice(1)}`]!.toLowerCase().includes(t) ? [`${p}:${t}`] : [])))
      return out.length ? ok(out.join('\n')) : { value: { exitCode: 1, stdout: '', stderr: '' } }
    }
    return ok()
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => {
    if (e.origin?.kind === 'plugin') submitted.push(e.text)
    else contexts.push(e.context)
    return { text: e.text }
  })
  on('turn.complete', (_: any, e: any) => ({ turnId: e.turnId, text: '' }))
  return { store, files, dirs, contexts, submitted, write, later: (ms: number) => (now += ms), qmdRuns: t.qmdRuns }
}

const start = ($: any) => $.session.start({ cwd: `${HOME}/work/app`, surface: 'desktop', isInteractive: true } as any)
const cmd = ($: any, args: string) => $.command.run({ command: 'vault', args } as any) as Promise<any>
const done = ($: any) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
// Lets the hooks' background work (void ...) finish.
const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}
const say = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as any)

test('setup para makes the folders and conventions, and never overwrites a note already there', async ($, on) => {
  const t = engine(on)
  await start($)
  t.write(`${VAULT}/Home.md`, 'minha')
  expect((await cmd($, 'use ~/Vault')).text).toContain('Vault: ~/Vault.')
  const r = await cmd($, 'setup para')
  expect(r.text).toContain('CLAUDE.md')
  expect(r.text).not.toContain('Home.md')
  for (const f of ['Inbox', 'Projects', 'Areas', 'Resources', 'Archive', 'Daily', 'Claude']) expect(t.dirs.has(`${VAULT}/${f}`)).toBe(true)
  expect(t.files[`${VAULT}/CLAUDE.md`]).toContain('PARA')
  expect(t.files[`${VAULT}/Claude/Claude.base`]).toContain('this.file')
  expect(t.files[`${VAULT}/Home.md`]).toBe('minha')
})

test('a handoff is copied once, with properties, a project note and a daily line; a deleted copy stays deleted', async ($, on) => {
  const t = engine(on)
  await start($)
  await cmd($, 'use ~/Vault')
  t.write(`${HOME}/.claude/handoffs/2026-11-24-1000-cache-fix.md`, '# Handoff: Cache fix\n\nContinue work in `~/work/shop`. Goal: fix it.\n')
  t.write(`${HOME}/.claude/handoffs/2026-11-24-1001-draft.md`, 'draft')
  await done($)
  await settle()
  const copy = `${VAULT}/Claude/Handoffs/2026-11-24-1000-cache-fix.md`
  expect(t.files[copy]).toContain('type: handoff')
  expect(t.files[copy]).toContain('title: "Handoff: Cache fix"')
  expect(t.files[copy]).toContain('project: "[[shop]]"')
  expect(t.files[copy]).toContain('source: "~/.claude/handoffs/2026-11-24-1000-cache-fix.md"')
  expect(t.files[copy]).toContain('Continue work in')
  expect(`${VAULT}/Claude/Handoffs/2026-11-24-1001-draft.md` in t.files).toBe(false)
  expect(t.files[`${VAULT}/Projects/shop.md`]).toContain('folder: "~/work/shop"')
  const day = Object.keys(t.files).find(p => p.startsWith(`${VAULT}/Daily/`))!
  expect(t.files[day]).toContain('type: daily')
  expect(t.files[day]).toContain('[[2026-11-24-1000-cache-fix]] (handoff, [[shop]])')
  delete t.files[copy]
  await done($)
  await settle()
  expect(copy in t.files).toBe(false)
})

test('a research brief written in this chat belongs to its folder; input-router reads wait for /vault reads on', async ($, on) => {
  const t = engine(on)
  await start($)
  await cmd($, 'use ~/Vault')
  t.later(1000)
  t.write(`${HOME}/.claude/mods-logs/research-router/20261124T150100-qmd.md`, '# Research notes: qmd\n')
  t.write(`${HOME}/.claude/mods-logs/input-router/2026-11-24-big.md`, '# notes')
  await done($)
  await settle()
  expect(t.files[`${VAULT}/Claude/Research/20261124T150100-qmd.md`]).toContain('project: "[[app]]"')
  expect(`${VAULT}/Claude/Reads/2026-11-24-big.md` in t.files).toBe(false)
  expect((await cmd($, 'reads on')).text).toContain('1 notas copiadas')
  expect(t.files[`${VAULT}/Claude/Reads/2026-11-24-big.md`]).toContain('type: read')
})

test('a prompt that matches a note gets a hint with its path, once per chat; a weak match gets none', async ($, on) => {
  const t = engine(on)
  await start($)
  await cmd($, 'use ~/Vault')
  t.write(`${VAULT}/Resources/Cache do prompt.md`, '# Prompt cache\nO cache do prompt expira depois de cinco minutos sem uso.\n')
  t.write(`${VAULT}/Daily/2026-11-24.md`, 'cache prompt minutos')
  t.write(`${VAULT}/CLAUDE.md`, 'cache prompt minutos')
  t.write(`${VAULT}/Claude/Handoffs/h.md`, 'só fala de cache')
  // Words no note has ("responda", "frase", "diga") must not hide the note that has the rest.
  await say($, 'quanto tempo o cache do prompt dura sem uso? responda em uma frase e diga de onde tirou')
  const hint = t.contexts.at(-1)?.join('\n') ?? ''
  expect(hint).toContain('- Resources/Cache do prompt.md')
  expect(hint).not.toContain('Handoffs/')
  expect(hint).not.toContain('Daily/')
  expect(hint).not.toContain('cinco minutos')
  await say($, 'e o cache do prompt, ele expira?')
  expect(t.contexts.at(-1)).toBeUndefined()
  await say($, 'escreva um poema sobre gatos dormindo')
  expect(t.contexts.at(-1)).toBeUndefined()
  // The chat's first prompt went into today's daily note.
  expect(t.files[`${VAULT}/Daily/2026-11-24.md`]).toContain('chat em [[app]]: quanto tempo o cache')
})

test('the system prompt names the vault set at chat start, and /vault save hands Claude a prompt', async ($, on) => {
  const t = engine(on)
  const compose = () => $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  await start($)
  await cmd($, 'use ~/Vault')
  await start($)
  const s = (await compose()).sections.at(-1)!
  expect(s.id).toBe('vault:vault')
  expect(s.text).toContain(VAULT)
  expect(s.text).toContain('Grep em')
  await cmd($, 'save a decisão de usar qmd')
  await settle()
  expect(t.submitted.at(-1)).toContain('a decisão de usar qmd')
  expect(t.submitted.at(-1)).toContain('Inbox/')
})

test('with qmd, a note that says it in other words is hinted too, and the collection skips daily notes', async ($, on) => {
  const json = JSON.stringify([
    { docid: '#1', score: 0.66, file: 'qmd://vault/Resources/Cache do prompt.md', title: 'Cache' },
    { docid: '#2', score: 0.7, file: 'qmd://vault/Daily/2026-11-24.md', title: 'dia' },
  ])
  const t = engine(on, { qmd: json })
  await start($)
  expect((await cmd($, 'use ~/Vault')).text).toContain('coleção "vault" criada')
  expect(t.qmdRuns.find(a => a[1] === 'collection' && a[2] === 'add')).toContain('**/*.md,!Daily/**,!Templates/**,!CLAUDE.md')
  t.write(`${VAULT}/Resources/Cache do prompt.md`, '# Prompt cache\nexpira em cinco minutos')
  await say($, 'por quanto tempo a memória temporária das instruções fica guardada?')
  const hint = t.contexts.at(-1)?.join('\n') ?? ''
  expect(hint).toContain('- Resources/Cache do prompt.md (qmd 0.66)')
  expect(hint).not.toContain('Daily/')
  expect(t.qmdRuns.find(a => a[1] === 'vsearch')).toContain('0.6')
})

test('the first chat with no vault sets one up by itself and says so in the band', async ($, on) => {
  const t = engine(on)
  await start($)
  expect(t.dirs.has(`${HOME}/Documents/Vault/Inbox`)).toBe(true)
  expect(t.files[`${HOME}/Documents/Vault/CLAUDE.md`]).toContain('PARA')
  expect(String(t.store.get('state:band'))).toContain('~/Documents/Vault')
  expect(String(t.store.get('state:band'))).not.toContain('Próximo passo')
})

test('a folder that already has notes keeps its structure and gets no prompt sent', async ($, on) => {
  const t = engine(on)
  t.write(`${HOME}/Documents/Vault/minha.md`, 'x')
  await start($)
  await settle()
  expect((t.store.get('config') as any).model).toBe('existing')
  expect(t.dirs.has(`${HOME}/Documents/Vault/Inbox`)).toBe(false)
  expect(t.submitted.length).toBe(0)
})
