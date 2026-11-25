import { expect } from 'claude-code/testing'
import { fakes, switches, test } from './mods-stub'

// An in-memory home: files, folders, and the few commands the mod runs (mkdir, append, find, rg).
const HOME = '/home/u'
const VAULT = `${HOME}/Vault`

function engine(on: any, o: { qmd?: string | (() => string); version?: string; pidfile?: string; health?: string } = {}, resolved?: { model: string; provider: string; source: 'clauderipple' }) {
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
  const modelRequests: Record<string, unknown>[] = []
  let now = Date.UTC(2026, 10, 24, 15, 0)
  const t = { qmdRuns: [] as string[][], fetches: [] as string[], stops: [] as string[] }
  const write = (p: string, t: string) => ((files[p] = t), (mtimes[p] = now))
  const under = (d: string) => Object.keys(files).filter(p => p.startsWith(`${d}/`))

  on('clock.now', () => ({ value: now }))
  // Fires a 0 ms timer (a prompt sent after the hook); a timeout never fires, so a call never times out.
  on('clock.after', (_: any, e: any) => (e.ms === 0 ? { value: undefined } : new Promise(() => undefined)))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.cwd', () => ({ value: `${HOME}/work/app` }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('state.get', (_: any, e: any) => ({ value: { value: store.get(`state:${e.key}`) ?? null, version: 1 } }))
  on('state.set', (_: any, e: any) => (store.set(`state:${e.key}`, e.value), { value: undefined }))
  on('ui.open', (_: any, e: any) => (store.set('opened', e.id), { value: undefined }))
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
      // createNew: noclobber, so a file already there is left alone and the call fails.
      if (script.includes('set -C')) return argv[4]! in files ? { value: { exitCode: 1, stdout: '', stderr: 'exists' } } : (write(argv[4]!, e.init.stdin), ok())
      // stopDaemon: qmd mcp stop only when the pidfile still names the mod's PID.
      if (script.includes('mcp stop')) return o.pidfile === argv[5] ? (t.stops.push(argv[5]!), ok('Stopped')) : { value: { exitCode: 3, stdout: '', stderr: '' } }
      if (script.includes('find . -type f')) {
        const d = `${own(argv[4]!)}/`
        return ok(Object.keys(tpl).filter(k => k.startsWith(d)).map(k => `./${k.slice(d.length)}`).join('\n'))
      }
      return ok()
    }
    if (argv[0] === '/x/qmd') {
      t.qmdRuns.push(argv)
      if (argv[1] === '--version') return ok(`qmd ${o.version ?? '2.9.0'} (aa247d0)\n`)
            return ok()
    }
    if (argv[0] === 'find') {
      const dir: string = e.init.cwd
      return ok(under(dir).filter(p => !p.includes('/.obsidian/')).map(p => `${(mtimes[p] ?? 0) / 1000}\t${p.slice(dir.length + 1)}`).join('\n'))
    }
    if (argv[0] === 'rg' && argv.some(a => a.startsWith('\\[\\['))) {
      const dir: string = e.init.cwd
      const md = under(dir).filter(p => p.endsWith('.md') && !/\/(Daily|Templates)\//.test(p))
      return ok(md.flatMap(p => [...files[p]!.matchAll(/\[\[[^\]|#^]+/g)].map(m => `.${p.slice(dir.length)}:${m[0]}`)).join('\n'))
    }
    if (argv[0] === 'rg') {
      const dir: string = e.init.cwd
      const md = under(dir)
        .map(p => `.${p.slice(dir.length)}`)
        .filter(p => p.endsWith('.md') && !/^\.\/(Daily|Templates)\/|^\.\/CLAUDE\.md$|\/\.obsidian\//.test(p))
      if (argv[1] === '--files') return ok(md.join('\n'))
      const terms = argv.flatMap((a, i) => (argv[i - 1] === '-e' ? [a.replace(/^\\b/, '')] : []))
      const out = md.flatMap(p => terms.flatMap(t => (files[`${dir}${p.slice(1)}`]!.toLowerCase().includes(t) ? [`${p}:${t}`] : [])))
      return out.length ? ok(out.join('\n')) : { value: { exitCode: 1, stdout: '', stderr: '' } }
    }
    return ok()
  })
  // qmd's HTTP daemon: up when the test gives qmd an answer; /query answers it.
  // mods-core's append writes into this test's files.
  fakes.append = (path, text) => write(path, (files[path] ?? '') + text)
  // qmd and its daemon are mods-core's ($.mods.qmd*): answered here from o, the way mods-core reads
  // the daemon (only qmd's own /health counts; the reranker read back from the blended score).
  const rerankOf = (v: number) => Math.max(0, v >= 0.75 ? (v - 0.75) / 0.25 : v >= 0.375 ? (v - 0.375) / 0.25 : (v - 0.25) / 0.25)
  const up = () => o.qmd !== undefined && /"status":"ok"/.test(o.health ?? '{"status":"ok","uptime":5}')
  on('mods.qmdFind', () => ({ value: o.qmd === undefined ? '' : '/x/qmd' }))
  on('mods.qmdUp', () => (t.fetches.push('/health'), { value: up() }))
  on('mods.qmdQuery', (_: any, e: any) => {
    t.fetches.push('/query')
    if (!up()) throw new Error('connection refused')
    const json = JSON.parse(typeof o.qmd === 'function' ? o.qmd() : o.qmd!) as { results?: Record<string, unknown>[] } | unknown[]
    const rows = (Array.isArray(json) ? [] : (json.results ?? [])).slice(0, e.limit)
    return {
      value: rows.map(r => ({
        file: decodeURIComponent(String(r.file ?? '').replace(/^qmd:\/\/[^/]+\//, '')),
        title: String(r.title ?? ''),
        snippet: String(r.snippet ?? ''),
        rerank: e.limit <= 3 ? rerankOf(typeof r.score === 'number' ? r.score : 0) : 0,
      })),
    }
  })
  on('mods.qmdStart', () => ({ value: up() ? { pid: '', out: '' } : { pid: '4242', out: 'Started (PID 4242)' } }))
  on('mods.qmdStop', (_: any, e: any) => (o.pidfile === e.pid ? (t.stops.push(e.pid), { value: 'stopped' }) : { value: 'other' }))
  on('tool.call', () => ({ result: 'ok' }))
  if (resolved) {
    fakes.modelResolve = () => resolved
    on('model.complete', (_: any, e: any) => (modelRequests.push(e), { value: { isAnswered: true, text: '{"save":false}' } }))
  }
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => {
    if (e.origin?.kind === 'plugin') submitted.push(e.text)
    else contexts.push(e.context)
    return { text: e.text }
  })
  on('turn.complete', (_: any, e: any) => ({ turnId: e.turnId, text: '' }))
  return { store, files, dirs, contexts, submitted, modelRequests, write, later: (ms: number) => (now += ms), qmdRuns: t.qmdRuns, fetches: t.fetches, stops: t.stops, mtimes }
}

const start = ($: any) => $.session.start({ cwd: `${HOME}/work/app`, surface: 'desktop', isInteractive: true } as any)
const cmd = ($: any, args: string) => $.command.run({ command: 'vault', args } as any) as Promise<any>
const done = ($: any, answer = '') => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
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

test('with qmd, a note the reranker finds relevant is hinted with a line of it; a weak one and an unbacked word match are not', async ($, on) => {
  // The daemon blends rank and reranker: the first result scores 0.75 + 0.25 × rerank.
  const row = (file: string, score: number, snippet = '') => ({ docid: '#1', score, file: `qmd://vault/${file}`, title: 't', snippet })
  let answer = [row('Resources/Cache%20do%20prompt.md', 0.75 + 0.25 * 0.9, '3: @@ -1,4 @@\n4: # Prompt cache\n5: expira em cinco minutos sem uso'), row('Daily/2026-11-24.md', 0.5)]
  const t = engine(on, { qmd: () => JSON.stringify({ results: answer }) })
  await start($)
  await settle()
  expect((await cmd($, 'use ~/Vault')).text).toContain('coleção "vault" criada')
  expect(t.qmdRuns.find(a => a[1] === 'collection' && a[2] === 'add')).toContain('**/*.md,!Daily/**,!Templates/**,!CLAUDE.md')
  expect(t.qmdRuns.some(a => a[1] === 'context')).toBe(false)
  t.write(`${VAULT}/Resources/Cache do prompt.md`, '# Prompt cache\nexpira em cinco minutos')
  await say($, 'por quanto tempo a memória temporária das instruções fica guardada?')
  const hint = t.contexts.at(-1)?.join('\n') ?? ''
  expect(hint).toContain('- Resources/Cache do prompt.md (qmd 0.90): expira em cinco minutos sem uso')
  expect(hint).not.toContain('Daily/')
  // The reranker says no (0.04), and the two words that match are not backed: no hint.
  answer = [row('Resources/Git.md', 0.75 + 0.25 * 0.04)]
  t.write(`${VAULT}/Resources/Git.md`, 'rebase interativo junta commits')
  await say($, 'faça um rebase interativo agora')
  expect(t.contexts.at(-1)).toBeUndefined()
  // A result the reranker moved up still reads as relevant: 0.375 + 0.25 × 0.8 is rank 2's blend.
  answer = [row('Resources/Git.md', 0.75 + 0.25 * 0.02), row('Resources/Squash.md', 0.375 + 0.25 * 0.8)]
  await say($, 'como junto meus últimos commits num só?')
  expect(t.contexts.at(-1)?.join('\n')).toContain('- Resources/Squash.md (qmd 0.80)')
  // Pasted text: three or more words match, but the reranker's nod (0.15) is missing, so no hint.
  t.write(`${VAULT}/Resources/Deploy.md`, 'servidor pipeline staging rollback')
  answer = [row('Resources/Deploy.md', 0.75 + 0.25 * 0.1)]
  await say($, 'log colado: servidor pipeline staging rollback falhou')
  expect(t.contexts.at(-1)).toBeUndefined()
  // A weak nod above 0.15 lets the same word match through, though it is under the 0.4 cut.
  answer = [row('Resources/Deploy.md', 0.75 + 0.25 * 0.2)]
  await say($, 'outro log: servidor pipeline staging rollback caiu')
  expect(t.contexts.at(-1)?.join('\n')).toContain('- Resources/Deploy.md (termos:')
})

test('/vault review and inbox come with what the hook worked out: orphans, broken links, stale projects, the Inbox', async ($, on) => {
  const t = engine(on)
  await start($)
  await cmd($, 'use ~/Vault')
  await cmd($, 'setup para')
  t.write(`${VAULT}/Projects/Velho.md`, '# Velho')
  t.later(40 * 86_400_000)
  t.write(`${VAULT}/Resources/A.md`, 'liga [[B]] e [[Sumida]] e ![[Claude.base#Do projeto]]')
  t.write(`${VAULT}/Resources/B.md`, 'nada')
  t.write(`${VAULT}/Resources/Solta.md`, 'sem links')
  t.write(`${VAULT}/Inbox/ideia.md`, 'crua')
  await cmd($, 'review')
  await settle()
  const review = t.submitted.at(-1)!
  expect(review).toContain('Resources/Solta.md')
  expect(review).toContain('Resources/A.md → [[Sumida]]')
  expect(review).not.toContain('[[Claude.base')
  expect(review).toContain('Projects/Velho.md')
  expect(review).toContain('Inbox: 1 notas')
  expect(review).toContain('Reviews/')
  await cmd($, 'inbox')
  await settle()
  expect(t.submitted.at(-1)).toContain('  - Inbox/ideia.md')
  expect(t.submitted.at(-1)).toContain('  - Resources')
})

test('/vault ask hands Claude the hits it found, and /vault counts hinted notes Claude opened', async ($, on) => {
  const t = engine(on)
  await start($)
  await cmd($, 'use ~/Vault')
  t.write(`${VAULT}/Resources/Cache do prompt.md`, '# Prompt cache\nO cache do prompt expira depois de cinco minutos sem uso.\n')
  await cmd($, 'ask quanto tempo o cache do prompt dura?')
  await settle()
  expect(t.submitted.at(-1)).toContain('- Resources/Cache do prompt.md')
  await say($, 'quanto tempo o cache do prompt dura sem uso?')
  await $.tool.call({ tool: 'Read', file_path: `${VAULT}/Resources/Cache do prompt.md`, tool_use_id: 'u1' } as any)
  await $.tool.call({ tool: 'Read', file_path: `${VAULT}/Resources/Cache do prompt.md`, tool_use_id: 'u2' } as any)
  expect((await cmd($, 'status')).text).toContain('Dicas: 1 notas sugeridas, 1 abertas pelo Claude desde')
})

test('a vault adopted as it was gets no Projects folder from a handoff; the copy keeps the link', async ($, on) => {
  const t = engine(on)
  t.write(`${HOME}/Documents/Vault/minha.md`, 'x')
  await start($)
  await settle()
  t.write(`${HOME}/.claude/handoffs/2026-11-24-1000-x.md`, '# Handoff: x\n\nContinue work in `~/work/shop`.\n')
  await done($)
  await settle()
  expect(t.files[`${HOME}/Documents/Vault/Claude/Handoffs/2026-11-24-1000-x.md`]).toContain('project: "[[shop]]"')
  expect(`${HOME}/Documents/Vault/Projects/shop.md` in t.files).toBe(false)
})

const row = (file: string, score: number, snippet = '') => ({ docid: '#1', score, file: `qmd://vault/${file}`, title: 't', snippet })
// A started chat with qmd 2.x up, the vault set, and the daemon answering `answer()`.
async function withQmd($: any, on: any, answer: () => unknown[], o: { version?: string; health?: string } = {}) {
  const t = engine(on, { qmd: () => JSON.stringify({ results: answer() }), ...o })
  await start($)
  await settle()
  await cmd($, 'use ~/Vault')
  return t
}

test('a qmd that fails a query (a 500) gives no nod: a common-word match is not hinted, a rare name word still is', async ($, on) => {
  let down = false
  const t = await withQmd($, on, () => {
    if (down) throw new Error('qmd HTTP 500')
    return [{ docid: '#1', score: 0.75 + 0.25 * 0.9, file: 'qmd://vault/Resources/Deploy.md', title: 't', snippet: '' }]
  })
  t.write(`${VAULT}/Resources/Deploy.md`, 'servidor pipeline staging rollback')
  t.write(`${VAULT}/Resources/Kubernetes probes.md`, 'liveness e readiness')
  down = true
  await say($, 'log colado: servidor pipeline staging rollback falhou')
  expect(t.contexts.at(-1)).toBeUndefined()
  // Still failing on the next prompt: still no word hint, but a rare word in a note's name gets through.
  await say($, 'outro log: servidor pipeline staging rollback caiu')
  expect(t.contexts.at(-1)).toBeUndefined()
  await say($, 'como configuro kubernetes direito?')
  expect(t.contexts.at(-1)?.join('\n')).toContain('- Resources/Kubernetes probes.md (termos: kubernetes)')
  // Back up: the very next prompt asks qmd again, with no minute's wait.
  down = false
  await say($, 'como faço o deploy em staging com rollback?')
  expect(t.contexts.at(-1)?.join('\n')).toContain('- Resources/Deploy.md')
})

test('a rare word of the prompt in a note name hints it even when the reranker says no', async ($, on) => {
  const t = await withQmd($, on, () => [row('Resources/Docker%20multi-stage%20build.md', 0.75 + 0.25 * 0.04)])
  t.write(`${VAULT}/Resources/Docker multi-stage build.md`, '# Multi-stage build\nCompile numa imagem com o toolchain e copie só o binário.')
  t.write(`${VAULT}/Resources/Postgres.md`, 'índice parcial')
  t.write(`${VAULT}/Resources/React.md`, 'useEffect duas vezes')
  await say($, 'como deixo o docker mais leve?')
  expect(t.contexts.at(-1)?.join('\n')).toContain('- Resources/Docker multi-stage build.md (termos: docker)')
})

test('/vault corte sets the reranker cut, and /vault shows the last meaning hints\' scores', async ($, on) => {
  let answer = [row('Resources/Cache.md', 0.75 + 0.25 * 0.9)]
  const t = await withQmd($, on, () => answer)
  expect((await cmd($, 'corte 2')).text).toContain('/vault corte <número de 0 a 1>')
  await say($, 'por quanto tempo a memória temporária das instruções fica guardada?')
  expect(t.contexts.at(-1)?.join('\n')).toContain('(qmd 0.90)')
  answer = [row('Resources/Outra.md', 0.75 + 0.25 * 0.5)]
  await say($, 'e quanto custa reescrever o prefixo inteiro de novo?')
  const st = (await cmd($, 'status')).text
  expect(st).toContain('Últimas 2 dicas por significado: scores 0.50 a 0.90')
  expect(st).toContain('Corte do reranker: 0.40 (padrão)')
  expect(st).toContain('Abrir pouco não quer dizer ruído')
  expect((await cmd($, 'corte 0,95')).text).toContain('0.95')
  answer = [row('Resources/Terceira.md', 0.75 + 0.25 * 0.9)]
  await say($, 'quanto tempo dura a memória das instruções sem uso?')
  expect(t.contexts.at(-1)).toBeUndefined()
  expect((t.store.get('config') as any).cut).toBe(0.95)
})

test('a qmd that is not 2.x leaves the hints to ripgrep, and /vault says why', async ($, on) => {
  const answer = () => [row('Resources/Cache.md', 1)]
  const t = await withQmd($, on, answer, { version: '3.0.1' })
  await say($, 'por quanto tempo a memória temporária das instruções fica guardada?')
  expect(t.contexts.at(-1)).toBeUndefined()
  expect((await cmd($, 'status')).text).toContain('qmd 3.0.1 não é 2.x')
})

test('a port 8181 answered by something else is not used', async ($, on) => {
  const t = await withQmd($, on, () => [row('Resources/Cache.md', 1)], { health: '<html>other app</html>' })
  await say($, 'por quanto tempo a memória temporária das instruções fica guardada?')
  expect(t.contexts.at(-1)).toBeUndefined()
  expect(t.fetches.some(u => u.endsWith('/query'))).toBe(false)
  expect((await cmd($, 'status')).text).toContain('daemon parado')
})

test('with the mod off, the daemon it started is stopped, and one it did not start is left alone', async ($, on) => {
  const t = engine(on, { qmd: '[]', pidfile: '4242' })
  switches.vault = false
  t.store.set('daemon', '4242')
  await start($)
  await settle()
  expect(t.stops).toEqual(['4242'])
  expect(t.store.get('daemon')).toBe(null)
  t.store.set('daemon', '999')
  await start($)
  await settle()
  expect(t.stops).toEqual(['4242'])
})

test('the first chat with no vault sets one up by itself and asks PARA or Zettel in the band', async ($, on) => {
  const t = engine(on)
  await start($)
  expect(t.dirs.has(`${HOME}/Documents/Vault/Inbox`)).toBe(false)
  expect(t.store.get('state:choice')).toBe(true)
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

test('/vault in a chat that never set up does the setup in the band', async ($, on) => {
  const t = engine(on)
  // No session.start: a chat already open when the mod was installed and reloaded.
  const r = await cmd($, '')
  expect(t.store.get('state:choice')).toBe(true)
  expect(String(t.store.get('state:band'))).toContain('~/Documents/Vault')
  expect(r.text).toContain('Vault: ~/Documents/Vault')
})

const ABOVE = { plugin: 'vault', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } } }
const PANE = { plugin: 'vault', component: 'Pane', requestId: 'vault', surface: 'desktop', props: { title: 'Vault', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } }

test('a prompt qmd searched shows one low purple line above the chat; one it did not search shows none', async ($, on) => {
  const t = await withQmd($, on, () => [{ docid: '#1', score: 0.75 + 0.25 * 0.9, file: 'qmd://vault/Resources/Cache%20do%20prompt.md', title: 't', snippet: '' }])
  t.write(`${VAULT}/Resources/Cache do prompt.md`, '# Prompt cache\nexpira em cinco minutos')
  await say($, 'por quanto tempo a memória temporária das instruções fica guardada?')
  expect(String(t.store.get('state:search'))).toMatch(/^Vault · qmd buscou em \d+ ms · 1 nota sugerida \(qmd 0\.90\)$/)
  expect(await (await $.ui.mount(ABOVE as any)).find({ type: 'Text', text: /qmd buscou/ })).toBeDefined()
  await say($, 'ok')
  expect(t.store.get('state:search')).toBe(null)
})

test('/vault opens the side pane; its buttons run the commands and it lists the last hints', async ($, on) => {
  const t = engine(on)
  await start($)
  await cmd($, 'use ~/Vault')
  await cmd($, 'setup para')
  expect((await cmd($, '')).text).toContain('painel do vault está aberto')
  expect(t.store.get('opened')).toBe('vault')
  t.write(`${VAULT}/Resources/Cache do prompt.md`, 'prompt cache expira em cinco minutos sem uso')
  await say($, 'quanto tempo o prompt cache expira sem uso?')
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /Resources\/Cache do prompt\.md/ })).toBeDefined()
  await ui.press({ key: 'do:inbox' })
  await settle()
  expect(t.submitted.at(-1)).toContain('Inbox/')
  await ui.press({ key: 'do:reads on' })
  expect((t.store.get('config') as any).reads).toBe(true)
  // The fake state store does not redraw a mounted pane by itself: mount it again.
  await ui.unmount()
  expect(await (await $.ui.mount(PANE as any)).find({ key: 'do:reads off' })).toBeDefined()
})

test('at the end of an answer Haiku keeps one note in the Inbox when there is something worth it, and nothing otherwise', async ($, on) => {
  const t = engine(on)
  let reply = '{"save": true, "title": "O cache do prompt expira em 5 minutos", "body": "Decidimos manter o cache quente com /keepwarm.", "tags": ["cache"]}'
  const asked: string[] = []
  on('model.complete', (_: any, e: any) => (asked.push(e.model), { value: { isAnswered: true, text: reply } }))
  await start($)
  await cmd($, 'use ~/Vault')
  await cmd($, 'setup para')
  await say($, 'quanto tempo dura o cache do prompt?')
  await $.turn.complete({ answer: 'Cinco minutos sem uso; decidimos usar /keepwarm.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  await settle()
  expect(asked).toEqual(['claude-haiku-5-5'])
  const note = t.files[`${VAULT}/Inbox/O cache do prompt expira em 5 minutos.md`]
  expect(note).toContain('type: note')
  expect(note).toContain('tags: [claude, captured, cache]')
  expect(note).toContain('project: "[[app]]"')
  reply = '{"save": false}'
  await say($, 'ok, obrigado pela explicação')
  await $.turn.complete({ answer: 'De nada.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
  await settle()
  expect(Object.keys(t.files).filter(p => p.startsWith(`${VAULT}/Inbox/`)).length).toBe(1)
  await cmd($, 'capture off')
  await say($, 'mais uma decisão importante sobre o cache')
  await $.turn.complete({ answer: 'Anotado.', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
  await settle()
  expect(asked.length).toBe(2)
})

test('the weekly review shows in the band 7 days after the last one, for the person to click', async ($, on) => {
  const t = engine(on)
  await start($)
  await cmd($, 'use ~/Vault')
  await cmd($, 'setup para')
  await start($)
  expect(t.store.get('state:review')).toBe(undefined)
  t.later(7 * 86_400_000)
  await start($)
  expect(t.store.get('state:review')).toBe(true)
  const ui = await $.ui.mount(ABOVE as any)
  await ui.press({ key: 'review-now' })
  await settle()
  expect(t.submitted.at(-1)).toContain('revisão semanal')
  expect(t.store.get('state:review')).toBe(null)
  await start($)
  expect(t.store.get('state:review')).toBe(null)
})

test('capture sends the provider-qualified ClaudeRipple model to model.complete', async ($, on) => {
  const t = engine(on, {}, { model: 'qwen2.5:3b', provider: 'ollama-local', source: 'clauderipple' })
  await start($)
  await cmd($, 'use ~/Vault')
  await say($, 'guarde a decisão de usar o banco local')
  await done($, 'Decidimos manter o banco local para os testes.')
  await settle()
  expect(t.modelRequests[0]).toMatchObject({ model: 'ollama-local:qwen2.5:3b' })
})
