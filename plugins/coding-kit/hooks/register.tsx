import type { EngineInterface, Register } from 'claude-code'

import { coderSvg } from './mascot.ts'

// Coding Kit: better code for fewer tokens.
// 1. Ponytail, always on in code projects. Its rules go into the system prompt once per chat
//    (written to the cache once, ~800 tokens), not as a Skill call per message: a Skill call is
//    one more request that re-reads the whole chat. The model applies them only to coding tasks.
// 2. A side pane of skills and tools, drawn from catalog.json, each one click away. Bundled skills
//    carry disable-model-invocation, so they cost no context until clicked. Your own skills
//    (user, project, other plugins) are found on disk and listed too.

const NAME = 'coding-kit'
const PANE = 'coding-kit'
const TITLE = 'Coding Kit'
const LEVELS = ['off', 'lite', 'full', 'ultra'] as const
const ACCENT = '#d97757'
const GOOD = '#16a34a'
const WARN = '#ca8a04'
const NOTE = '#2563eb'
type Level = (typeof LEVELS)[number]

type Check = { argv: string[]; match?: string }
type Item = {
  id: string
  kind: 'skill' | 'builtin' | 'mcp' | 'tool'
  group: string
  label: string
  description: string
  command?: string
  fill?: string
  source?: string
  hint?: string
  server?: string
  exclusive?: string
  needs?: string[]
  check?: Check
  install?: string[][]
  uninstall?: string[][]
}
type Group = { id: string; title: string }
type Rewrite = { find: string; replace: string; regex?: boolean }
// Where a bundled skill comes from, and how its upstream text is fitted to this mod.
type Source = { dir: string; repo: string; path: string; ref?: string; credit?: string; frontmatter?: Record<string, string>; rewrite?: Rewrite[] }
type Catalog = { groups: Group[]; items: Item[]; skills?: Source[] }
type Lock = Record<string, { sha: string; date: string }>
type Update = { dir: string; repo: string; from: string; to: string; date: string }
type Found = { command: string; name: string; description: string; from: string }

// Files in a folder that mark it as a code project. A .git folder up to 3 levels above counts too.
const MARKERS = ['.git', 'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'setup.py', 'composer.json', 'Gemfile', 'mix.exs', 'deno.json', 'tsconfig.json', 'CMakeLists.txt', 'Makefile', 'pubspec.yaml', 'Package.swift']

// Module variables reset on a reload; settings live in $.store.
let home = ''
let claudeDir = ''
let sid = ''
let cwd = ''
let off = false
let isCode: boolean | null = null
let level: Level = 'full'
let autoOpen = true
let catalog: Catalog = { groups: [], items: [] }
let installed: Record<string, boolean | undefined> = {}
let found: Found[] = []
let showMine = false
let pending: { id: string; action: 'install' | 'remove' } | null = null
let busy = ''
let note = ''
const hinted = new Set<string>()
let rulesText = ''
// Bundled-skill updates: checked against GitHub at most once a week, applied only on a click.
const WEEK = 7 * 24 * 60 * 60 * 1000
let updates: Update[] = []
let checkedAt = 0
let checking = false
let confirmUpdates = false

// Opens a link with the desktop's opener: xdg-open (Linux), gio, or open (macOS).
const OPEN_SH = 'for c in xdg-open gio open; do command -v "$c" >/dev/null 2>&1 || continue; if [ "$c" = gio ]; then gio open "$1"; else "$c" "$1"; fi </dev/null >/dev/null 2>&1; exit $?; done; exit 3'

// ---- small helpers ----

const trim = (v: string | undefined) => (v ?? '').trim()

async function setup($: EngineInterface) {
  home = trim(await $.env.get('HOME').catch(() => undefined)) || trim(await $.env.get('USERPROFILE').catch(() => undefined)) || $.plugin.root.split('/.claude/')[0] || ''
  const set = trim(await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))
  claudeDir = set ? set.replace(/^~(?=\/|$)/, home) : `${home}/.claude`
}

async function readText($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

async function log($: EngineInterface, text: string) {
  try {
    const line = `${new Date(await $.clock.now()).toISOString()} ${text.replace(/\s+/g, ' ').slice(0, 600)}\n`
    await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${claudeDir}/mods-logs/${NAME}.log`], { stdin: line, timeoutMs: 10_000 })
  } catch {
    // The log never breaks the mod.
  }
}

const redraw = ($: EngineInterface) => {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The next draw catches up.
  }
}

// ---- the /mods switchboard: off in switches.json turns the mod off in every chat ----

async function readSwitch($: EngineInterface) {
  try {
    const raw = await readText($, `${claudeDir}/mods/switches.json`)
    const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const now = json[NAME] === false
    if (now !== off) {
      off = now
      redraw($)
    }
  } catch {
    // A broken file changes nothing.
  }
  // The /mods pane's Open button leaves this file.
  const ask = `${claudeDir}/mods/.open-${NAME}-${sid}`
  if (sid && (await $.fs.exists(ask).catch(() => false))) {
    await $.process.run(['rm', '-f', ask]).catch(() => undefined)
    if (!off) await openPane($)
  }
}

// ---- is this a code project? ----

async function detect($: EngineInterface): Promise<boolean> {
  const dir = cwd || (await $.session.cwd().catch(() => ''))
  if (!dir) return false
  for (const m of MARKERS) if (await $.fs.exists(`${dir}/${m}`).catch(() => false)) return true
  let up = dir
  for (let i = 0; i < 3; i += 1) {
    up = up.replace(/\/[^/]+\/?$/, '')
    if (!up) break
    if (await $.fs.exists(`${up}/.git`).catch(() => false)) return true
  }
  return false
}

// ---- ponytail rules for the system prompt ----

// One copy: the bundled /coding-kit:ponytail skill, without its frontmatter, comments and on-switch line.
async function ponytailRules($: EngineInterface) {
  return (await readText($, `${$.plugin.root}/skills/ponytail/SKILL.md`))
    .replace(/^---[\s\S]*?\n---\s*/, '')
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .split('\n')
    .filter(l => !l.startsWith('Active for the whole session'))
    .join('\n')
    .trim()
}

function ponytailSection(lv: Level) {
  const head = [
    'The Coding Kit mod turned on Ponytail for this code project.',
    'Apply the rules below to every coding task in this chat (writing, fixing, refactoring, reviewing, choosing dependencies).',
    'For questions that are not about code, answer normally.',
    `Level in use: ${lv}. The user changes it in the Coding Kit pane (/coding-kit); it applies from the next chat.`,
  ].join(' ')
  return `${head}\n\n${rulesText}`
}

// ---- catalog and status ----

async function loadCatalog($: EngineInterface) {
  try {
    const json = JSON.parse(await readText($, `${$.plugin.root}/catalog.json`)) as Catalog
    catalog = { groups: json.groups ?? [], items: (json.items ?? []).filter(i => i && i.id && i.label), skills: (json.skills ?? []).filter(x => x && x.dir && x.repo && x.path) }
  } catch (err) {
    note = 'catalog.json could not be read. See ~/.claude/mods-logs/coding-kit.log'
    await log($, `catalog: ${String(err)}`)
  }
}

async function mcpServers($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    const j = JSON.parse(await readText($, `${home}/.claude.json`)) as { mcpServers?: Record<string, unknown> }
    return j.mcpServers ?? {}
  } catch {
    return {}
  }
}

async function has($: EngineInterface, bin: string) {
  const r = await $.process.run(['/bin/sh', '-c', 'command -v "$1"', 'sh', bin], { timeoutMs: 10_000 }).catch(() => null)
  return !!r && r.exitCode === 0
}

async function refreshStatus($: EngineInterface) {
  const servers = await mcpServers($)
  const next: Record<string, boolean | undefined> = {}
  for (const item of catalog.items) {
    if (item.kind === 'mcp' && item.server) next[item.id] = item.server in servers
    else if (item.kind === 'tool' && item.check) {
      const r = await $.process.run(item.check.argv, { timeoutMs: 20_000 }).catch(() => null)
      next[item.id] = !!r && r.exitCode === 0 && (!item.check.match || r.stdout.includes(item.check.match))
    }
  }
  installed = next
  redraw($)
}

// ---- bundled-skill updates ----

const lockPath = ($: EngineInterface) => `${$.plugin.root}/skills/upstream.lock.json`

async function readLock($: EngineInterface): Promise<Lock> {
  try {
    return JSON.parse(await readText($, lockPath($))) as Lock
  } catch {
    return {}
  }
}

async function http($: EngineInterface, url: string): Promise<string> {
  const r = await $.process.run(['curl', '-fsSL', '--max-time', '20', '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: coding-kit', url], { timeoutMs: 30_000 })
  if (r.exitCode !== 0) throw new Error(`curl exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`)
  return r.stdout
}

function rewrite(text: string, src: Source) {
  let t = text
  for (const r of src.rewrite ?? []) t = r.regex ? t.replace(new RegExp(r.find, 'g'), r.replace) : t.split(r.find).join(r.replace)
  return t
}

// The upstream SKILL.md fitted to this mod: its frontmatter keys replaced, a credit line, the rewrites.
function fitSkill(text: string, src: Source, sha: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  const blocks: { key: string; lines: string[] }[] = []
  for (const line of m ? m[1]!.split(/\r?\n/) : []) {
    const k = /^([A-Za-z][\w-]*):/.exec(line)
    if (k || !blocks.length) blocks.push({ key: k?.[1] ?? '', lines: [line] })
    else blocks[blocks.length - 1]!.lines.push(line)
  }
  for (const [key, value] of Object.entries(src.frontmatter ?? {})) {
    const line = `${key}: ${/^(true|false|\d+)$/.test(value) ? value : JSON.stringify(value)}`
    const b = blocks.find(x => x.key === key)
    if (b) b.lines = [line]
    else blocks.push({ key, lines: [line] })
  }
  const body = rewrite(m ? text.slice(m[0].length) : text, src).replace(/^\s+/, '')
  const credit = `<!-- From ${src.repo} (${src.path}) at ${sha.slice(0, 12)}${src.credit ? `, ${src.credit}` : ''}. Updated by Coding Kit. -->`
  return `---\n${blocks.flatMap(b => b.lines).join('\n')}\n---\n\n${credit}\n\n${body}`
}

// One GitHub request per bundled skill, at most once a week: the last commit that touched its folder.
async function checkUpdates($: EngineInterface, force = false) {
  if (checking || off) return
  const now = await $.clock.now()
  if (!force && now - checkedAt < WEEK) return
  checking = true
  redraw($)
  try {
    const lock = await readLock($)
    const found: Update[] = []
    for (const src of catalog.skills ?? []) {
      const ref = src.ref ? `&sha=${encodeURIComponent(src.ref)}` : ''
      const list = JSON.parse(await http($, `https://api.github.com/repos/${src.repo}/commits?path=${encodeURIComponent(src.path)}${ref}&per_page=1`)) as { sha: string; commit: { committer: { date: string } } }[]
      const head = list[0]
      if (head && head.sha !== lock[src.dir]?.sha) found.push({ dir: src.dir, repo: src.repo, from: lock[src.dir]?.sha ?? '', to: head.sha, date: head.commit.committer.date })
    }
    updates = found
    await log($, `update check: ${found.length ? found.map(u => u.dir).join(', ') : 'all current'}`)
    const key = found.map(u => u.to).join(',')
    if (found.length && key !== (await $.store.get('updatesToasted').catch(() => ''))) {
      await $.store.set('updatesToasted', key)
      $.ui.toast(`Coding Kit: atualização disponível para ${found.map(u => u.dir).join(', ')}. Veja em /coding-kit.`)
    }
  } catch (err) {
    note = 'Não deu para verificar atualizações agora (sem rede ou limite do GitHub). Tento de novo na semana que vem.'
    await log($, `update check: ${String(err)}`)
  }
  // A failed check waits a week too: no retries on every chat.
  checkedAt = now
  await $.store.set('updates', updates).catch(() => undefined)
  await $.store.set('updatesCheckedAt', now).catch(() => undefined)
  checking = false
  redraw($)
}

async function applyUpdates($: EngineInterface) {
  if (busy) return
  busy = 'updates'
  note = 'Atualizando as skills…'
  redraw($)
  const lock = await readLock($)
  const done: string[] = []
  try {
    for (const u of updates) {
      const src = (catalog.skills ?? []).find(x => x.dir === u.dir)
      if (!src) continue
      const items = JSON.parse(await http($, `https://api.github.com/repos/${src.repo}/contents/${src.path}?ref=${u.to}`)) as { name: string; type: string; download_url: string | null }[]
      const files: [string, string][] = []
      for (const it of items) {
        if (it.type !== 'file' || !it.download_url) continue
        const raw = await http($, it.download_url)
        files.push([it.name, it.name === 'SKILL.md' ? fitSkill(raw, src, u.to) : rewrite(raw, src)])
      }
      if (!files.some(f => f[0] === 'SKILL.md')) throw new Error(`${src.dir}: no SKILL.md upstream`)
      const dir = `${$.plugin.root}/skills/${src.dir}`
      for (const [name, text] of files) {
        await $.fs.write(`${dir}/${name}`, text)
        if (name.endsWith('.sh')) await $.process.run(['chmod', '+x', `${dir}/${name}`]).catch(() => undefined)
      }
      lock[src.dir] = { sha: u.to, date: u.date }
      await $.fs.write(lockPath($), `${JSON.stringify(lock, null, 2)}\n`)
      done.push(src.dir)
      await log($, `updated ${src.dir} to ${u.to.slice(0, 12)}`)
    }
    note = `Atualizadas: ${done.join(', ')}. Valem para chats novos.`
  } catch (err) {
    note = `A atualização parou${done.length ? ` depois de ${done.join(', ')}` : ''}: ${String(err instanceof Error ? err.message : err)}`
    await log($, `update: ${note}`)
  }
  updates = updates.filter(u => !done.includes(u.dir))
  await $.store.set('updates', updates).catch(() => undefined)
  if (done.includes('ponytail')) rulesText = await ponytailRules($)
  busy = ''
  redraw($)
}

// ---- your own skills, found on disk ----

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2]!.trim()
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v) as string
      } catch {
        v = v.slice(1, -1)
      }
    } else if (v.startsWith("'")) v = v.slice(1, -1)
    out[kv[1]!] = v
  }
  return out
}

async function skillsIn($: EngineInterface, dir: string, prefix: string, from: string, into: Found[]) {
  let entries: { name: string; kind: string }[] = []
  if (!(await $.fs.exists(dir).catch(() => false))) return
  try {
    entries = (await $.fs.list(dir)) as { name: string; kind: string }[]
  } catch {
    return
  }
  for (const ent of entries) {
    const text = await readText($, `${dir}/${ent.name}/SKILL.md`)
    if (!text) continue
    const fm = frontmatter(text)
    if (fm['user-invocable'] === 'false') continue
    const name = fm.name || ent.name
    into.push({ command: `/${prefix}${name}`, name, description: (fm.description ?? '').replace(/\s+/g, ' ').slice(0, 160), from })
  }
}

async function pluginDirs($: EngineInterface): Promise<string[]> {
  const dirs = new Set<string>()
  try {
    const j = JSON.parse(await readText($, `${claudeDir}/plugins/installed_plugins.json`)) as { plugins?: Record<string, { installPath?: string }[]> }
    for (const list of Object.values(j.plugins ?? {})) for (const p of list ?? []) if (p.installPath) dirs.add(p.installPath)
  } catch {
    // No plugins file.
  }
  // Plugins the desktop app loads from your uploads.
  try {
    const attr = JSON.parse(trim(await $.env.get('CLAUDE_CODE_PLUGIN_ATTRIBUTION').catch(() => undefined)) || '{}') as Record<string, unknown>
    for (const p of Object.keys(attr)) dirs.add(p)
  } catch {
    // Not in the desktop app.
  }
  return [...dirs]
}

async function findSkills($: EngineInterface) {
  const list: Found[] = []
  await skillsIn($, `${claudeDir}/skills`, '', 'você', list)
  if (cwd) await skillsIn($, `${cwd}/.claude/skills`, '', 'projeto', list)
  for (const dir of await pluginDirs($)) {
    let plugin = ''
    try {
      plugin = (JSON.parse(await readText($, `${dir}/.claude-plugin/plugin.json`)) as { name?: string }).name ?? ''
    } catch {
      continue
    }
    if (!plugin || plugin === NAME) continue
    await skillsIn($, `${dir}/skills`, `${plugin}:`, plugin, list)
  }
  const ours = new Set(catalog.items.map(i => i.command).filter(Boolean))
  const seen = new Set<string>()
  found = list.filter(f => !ours.has(f.command) && !seen.has(f.command) && seen.add(f.command)).sort((a, b) => a.command.localeCompare(b.command))
  redraw($)
}

// ---- actions ----

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE }).catch(err => log($, `open: ${String(err)}`))
}

async function use($: EngineInterface, text: string) {
  await $.prompt.fill({ text, mode: 'replace' }).catch(err => log($, `fill: ${String(err)}`))
}

async function runSteps($: EngineInterface, item: Item, steps: string[][]) {
  for (const argv of steps) {
    await log($, `run: ${argv.join(' ')}`)
    const r = await $.process.run(argv, { timeoutMs: 600_000 })
    if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-300)}`)
  }
  await log($, `${item.id}: done`)
}

async function act($: EngineInterface, item: Item, action: 'install' | 'remove') {
  if (busy) return
  busy = item.id
  note = action === 'install' ? `Instalando ${item.label}…` : `Removendo ${item.label}…`
  redraw($)
  try {
    if (action === 'install') {
      for (const bin of item.needs ?? []) if (!(await has($, bin))) throw new Error(`precisa de \`${bin}\` instalado primeiro`)
      await runSteps($, item, item.install ?? [])
      note = `${item.label} instalado. Vale para chats novos.`
    } else {
      await runSteps($, item, item.uninstall ?? [])
      note = `${item.label} removido. Vale para chats novos.`
    }
  } catch (err) {
    note = `Não deu: ${String(err instanceof Error ? err.message : err)}`
    await log($, `${item.id} ${action}: ${note}`)
  }
  busy = ''
  await refreshStatus($)
}

function clash(item: Item): Item | undefined {
  if (!item.exclusive) return undefined
  return catalog.items.find(o => o.id !== item.id && o.exclusive === item.exclusive && installed[o.id])
}

// ---- register ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setup($)
    sid = await $.session.id().catch(() => '')
    cwd = await $.session.cwd().catch(() => '')
    const stored = await $.store.get('ponytail').catch(() => undefined)
    level = LEVELS.includes(stored as Level) ? (stored as Level) : 'full'
    autoOpen = (await $.store.get('autoOpen').catch(() => undefined)) !== false
    rulesText = await ponytailRules($)
    updates = ((await $.store.get('updates').catch(() => undefined)) as Update[] | undefined) ?? []
    checkedAt = Number(await $.store.get('updatesCheckedAt').catch(() => 0)) || 0
    await readSwitch($)
    await loadCatalog($)
    isCode = await detect($)
    await $.command.register({ name: 'coding-kit', description: 'Open the Coding Kit pane: one-click coding skills and tools; /coding-kit ponytail off|lite|full|ultra' })
    $.clock.every(3000, () => {
      void readSwitch($).catch(() => undefined)
    })
    void refreshStatus($).catch(err => log($, `status: ${String(err)}`))
    void findSkills($).catch(err => log($, `skills: ${String(err)}`))
    if (!off && isCode && autoOpen) void openPane($)
    // Once a week at most, in the background: it never holds the chat up.
    void checkUpdates($).catch(err => log($, `updates: ${String(err)}`))
    return next(e)
  })

  // Ponytail's rules join the system prompt in code projects. Read once per chat, then cached.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (off || level === 'off' || !rulesText) return r
    if (isCode === null) isCode = await detect($).catch(() => false)
    if (!isCode) return r
    return { ...r, sections: [...r.sections, { id: `${NAME}:ponytail`, text: ponytailSection(level), scope: 'session' as const }] }
  })

  // A suggestion in the pane when the prompt looks like a known case: a regex, no model call.
  on('prompt.submit', async ($, e, next) => {
    if (!off) {
      for (const item of catalog.items) {
        if (!item.hint || hinted.has(item.id)) continue
        let hit = false
        try {
          hit = new RegExp(item.hint, 'i').test(e.text)
        } catch {
          continue
        }
        if (!hit) continue
        hinted.add(item.id)
        redraw($)
        $.ui.toast(`Coding Kit: para isso, experimente “${item.label}” (${item.command ?? item.fill ?? ''})`)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'coding-kit' }, async ($, e) => {
    if (off) return { text: 'Coding Kit is off. Turn it on with /mods.' }
    const [word, arg] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'ponytail' && LEVELS.includes(arg as Level)) {
      level = arg as Level
      await $.store.set('ponytail', level)
      return { text: `Ponytail: ${level}. Applies from the next chat, so this chat's cache stays.` }
    }
    await openPane($)
    void refreshStatus($).catch(() => undefined)
    void findSkills($).catch(() => undefined)
    return { text: `Coding Kit pane opened. Code project: ${isCode ? 'yes' : 'no'}. Ponytail: ${level}.` }
  })

  on('ui.press', { plugin: NAME }, async ($, e, next) => {
    const el = e.element
    const [what, id = ''] = el.split(/:(.*)/s)
    const item = catalog.items.find(i => i.id === id)
    if (what === 'use' && item) await use($, item.fill ?? `${item.command ?? ''} `)
    else if (what === 'mine' && id) await use($, `${id} `)
    else if (what === 'level' && LEVELS.includes(id as Level)) {
      level = id as Level
      await $.store.set('ponytail', level)
      note = `Ponytail: ${level}. Vale a partir do próximo chat (para não regravar o cache deste).`
    } else if (what === 'auto') {
      autoOpen = !autoOpen
      await $.store.set('autoOpen', autoOpen)
    } else if (what === 'toggle-mine') showMine = !showMine
    else if ((what === 'install' || what === 'remove') && item) {
      const other = what === 'install' ? clash(item) : undefined
      if (other) note = `Remova ${other.label} antes: eles fazem o mesmo papel, e dois juntos só gastam contexto.`
      else pending = { id: item.id, action: what }
    } else if (what === 'confirm' && pending) {
      const p = pending
      pending = null
      const it = catalog.items.find(i => i.id === p.id)
      if (it) void act($, it, p.action)
    } else if (what === 'cancel') pending = null
    else if (what === 'check-updates') void checkUpdates($, true)
    else if (what === 'apply-updates') confirmUpdates = true
    else if (what === 'cancel-updates') confirmUpdates = false
    else if (what === 'confirm-updates') {
      confirmUpdates = false
      void applyUpdates($)
    } else if (what === 'diff' && id) {
      const u = updates.find(x => x.dir === id)
      const url = u ? (u.from ? `https://github.com/${u.repo}/compare/${u.from}...${u.to}` : `https://github.com/${u.repo}/commit/${u.to}`) : ''
      if (url) await $.process.run(['/bin/sh', '-c', OPEN_SH, 'sh', url], { timeoutMs: 15_000 }).catch(() => undefined)
    }
    else if (what === 'refresh') {
      await loadCatalog($)
      void refreshStatus($)
      void findSkills($)
    } else return next(e)
    redraw($)
    return { element: el }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    if (off) return <Text dimColor>Coding Kit está desligado. Ligue em /mods.</Text>
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
    const width = Math.max(32, e.props.bodyColumns)
    const cw = width - 4
    const noop = () => undefined
    const nowMs = await $.clock.now()
    const tools = catalog.items.filter(i => i.kind === 'mcp' || i.kind === 'tool')
    const tiles = [
      { label: 'Ponytail', value: isCode ? level : 'inativo' },
      { label: 'Skills', value: String(catalog.items.length - tools.length + found.length) },
      { label: 'Ferramentas', value: `${tools.filter(t => installed[t.id]).length}/${tools.length}` },
    ]
    const tileW = Math.floor((width - (tiles.length - 1)) / tiles.length)

    const card = (item: Item) => {
      const inst = item.kind === 'mcp' || item.kind === 'tool'
      const isIn = installed[item.id]
      const confirm = pending?.id === item.id
      const hot = hinted.has(item.id)
      return (
        <Box key={`card-${item.id}`} flexDirection="column" width={width} marginBottom={1} borderStyle="round" borderColor={hot ? ACCENT : undefined} borderDimColor={!hot} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" width={cw}>
            <Text bold wrap="truncate-end">{item.label}</Text>
            {hot ? <Text color={ACCENT}>★ sugerido</Text> : inst ? <Text color={isIn ? GOOD : undefined} dimColor={!isIn}>{busy === item.id ? '…' : isIn ? '✓ instalado' : 'não instalado'}</Text> : null}
          </Box>
          <Text dimColor wrap="wrap">{item.description}</Text>
          {item.command ? <Text dimColor wrap="truncate-end">{`${item.command}${item.source ? ` · ${item.source}` : ''}`}</Text> : null}
          {confirm ? (
            <Box flexDirection="column" width={cw}>
              <Text color={WARN} wrap="wrap">{pending!.action === 'install' ? 'Instalar? Muda a config do Claude Code (vale para chats novos).' : 'Remover?'}</Text>
              <Box flexDirection="row" gap={1}>
                <Button key="confirm" label="Confirmar" variant="primary" onPress={noop} />
                <Button key="cancel" label="Cancelar" onPress={noop} />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="row" gap={1}>
              {!inst || isIn ? <Button key={`use:${item.id}`} label="Usar" variant="primary" onPress={noop} /> : null}
              {inst && busy !== item.id ? <Button key={`${isIn ? 'remove' : 'install'}:${item.id}`} label={isIn ? 'Remover' : 'Instalar'} onPress={noop} /> : null}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Box key="header" flexDirection="row" gap={1} width={width} marginBottom={1}>
          {Svg ? (
            <Box key="mascot" width={12} flexShrink={0}>
              <Svg source={coderSvg()} alt="Pixel Claude with a ponytail at a laptop" width={72} height={48} />
            </Box>
          ) : (
            <Box key="mascot" width={6} flexShrink={0}>
              <Text color={ACCENT}>{'▟█▙▭'}</Text>
            </Box>
          )}
          <Box flexDirection="column" width={width - 13}>
            <Text bold>{TITLE}</Text>
            <Text dimColor wrap="wrap">Código melhor gastando menos: Ponytail sempre ativo em projetos de código, e cada skill a um clique.</Text>
          </Box>
        </Box>
        <Box key="tiles" flexDirection="row" gap={1} width={width} marginBottom={1}>
          {tiles.map(t => (
            <Box key={`t-${t.label}`} flexDirection="column" borderStyle="round" paddingX={1} width={tileW}>
              <Text dimColor wrap="truncate-end">{t.label}</Text>
              <Text bold color={ACCENT} wrap="truncate-end">{t.value}</Text>
            </Box>
          ))}
        </Box>
        <Box key="ponytail" flexDirection="column" width={width} marginBottom={1}>
          <Text dimColor wrap="wrap">{isCode ? 'Ponytail (vale a partir do próximo chat):' : 'Esta pasta não parece um projeto de código: Ponytail fica inativo aqui.'}</Text>
          <Box flexDirection="row" gap={1}>
            {LEVELS.map(l => (
              <Button key={`level:${l}`} label={l === level ? `● ${l}` : l} variant={l === level ? 'primary' : undefined} onPress={noop} />
            ))}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="auto" plain dimColor onPress={noop}>{autoOpen ? '☑ Abrir sozinho em projetos de código' : '☐ Abrir sozinho em projetos de código'}</Button>
            <Button key="refresh" plain dimColor onPress={noop}>↻ Atualizar</Button>
          </Box>
        </Box>
        <Box key="updates" flexDirection="column" width={width} marginBottom={1}>
          {updates.length ? (
            <Box flexDirection="column" width={width} borderStyle="round" borderColor={ACCENT} paddingX={1}>
              <Text bold color={ACCENT}>{`Atualização para ${updates.length} skill${updates.length > 1 ? 's' : ''}`}</Text>
              {updates.map(u => (
                <Box key={`up-${u.dir}`} flexDirection="row" justifyContent="space-between" width={cw}>
                  <Text wrap="truncate-end">{`${u.dir} · ${u.date.slice(0, 10)}`}</Text>
                  <Button key={`diff:${u.dir}`} plain dimColor onPress={noop}>Ver mudanças</Button>
                </Box>
              ))}
              <Text dimColor wrap="wrap">O texto de uma skill vira instrução para o Claude: veja as mudanças antes de aplicar.</Text>
              {confirmUpdates ? (
                <Box flexDirection="row" gap={1}>
                  <Button key="confirm-updates" label="Confirmar" variant="primary" onPress={noop} />
                  <Button key="cancel-updates" label="Cancelar" onPress={noop} />
                </Box>
              ) : busy === 'updates' ? (
                <Text color={ACCENT}>Atualizando…</Text>
              ) : (
                <Button key="apply-updates" label="Atualizar" variant="primary" onPress={noop} />
              )}
            </Box>
          ) : null}
          <Button key="check-updates" plain dimColor onPress={noop}>
            {checking ? 'Verificando atualizações…' : `↻ Verificar atualizações das skills · ${checkedAt ? `última há ${Math.max(0, Math.floor((nowMs - checkedAt) / 86_400_000))} dia(s)` : 'nunca'}`}
          </Button>
        </Box>
        {note ? <Text key="note" color={NOTE} wrap="wrap">{note}</Text> : null}
        {catalog.groups.map(g => {
          const items = catalog.items.filter(i => i.group === g.id)
          if (!items.length) return null
          return (
            <Box key={`group-${g.id}`} flexDirection="column" width={width}>
              <Text bold>{g.title}</Text>
              {items.map(card)}
            </Box>
          )
        })}
        <Box key="mine" flexDirection="column" width={width}>
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Text bold>{`Suas skills (${found.length})`}</Text>
            <Button key="toggle-mine" plain dimColor onPress={noop}>{showMine ? '▾ Esconder' : '▸ Mostrar'}</Button>
          </Box>
          {showMine
            ? found.map(f => (
                <Box key={`mine-${f.command}`} flexDirection="column" width={width} marginBottom={1} borderStyle="round" borderDimColor paddingX={1}>
                  <Box flexDirection="row" justifyContent="space-between" width={cw}>
                    <Text bold wrap="truncate-end">{f.command}</Text>
                    <Text dimColor>{f.from}</Text>
                  </Box>
                  {f.description ? <Text dimColor wrap="wrap">{f.description}</Text> : null}
                  <Button key={`mine:${f.command}`} label="Usar" onPress={noop} />
                </Box>
              ))
            : null}
        </Box>
      </Box>
    )
  })
}
