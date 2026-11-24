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
// One install step: a command, or a command whose output must hold `match` (a check that stops the install).
type Step = string[] | { argv: string[]; match?: string }
// A button of an installed tool's card: run a command and show its output, put a rule in ~/.claude/CLAUDE.md
// (and take it out), or write a prompt.
type Action = { id: string; label: string; offLabel?: string; run?: string[]; rule?: string; fill?: string }
type Item = {
  id: string
  kind: 'skill' | 'builtin' | 'mcp' | 'tool' | 'plugin'
  group: string
  label: string
  description: string
  command?: string
  fill?: string
  source?: string
  hint?: string
  server?: string
  exclusive?: string
  repo?: string
  needs?: string[]
  check?: Check
  install?: Step[]
  uninstall?: Step[]
  // kind plugin: "<name>@<marketplace>" and the marketplace's source (owner/repo)
  plugin?: string
  marketplace?: string
  // what an install touches, shown before Confirmar
  changes?: string[]
  // set for every step and for the check (telemetry off and the like)
  env?: Record<string, string>
  actions?: Action[]
  // a mod of this pack that does the same job
  overlapsMod?: { mod: string; why: string }
  // a path in the project that shows it was prepared for this tool
  prepared?: string
  // a heading inside its group, and whether it waits for the group's setup
  sub?: string
  needsSetup?: boolean
  // cheap or token-saving enough to suggest to everyone: a mark and one button for all of them
  recommended?: boolean
}
// A group's setup: a command run once per repo before the skills marked needsSetup, done once `done` exists.
type Group = { id: string; title: string; setup?: { label: string; command: string; done: string } }
type Rewrite = { find: string; replace: string; regex?: boolean }
// Where a bundled skill comes from, and how its upstream text is fitted to this mod.
// `exclude` names subfolders left out (another agent's metadata).
type Source = { dir: string; repo: string; path: string; ref?: string; credit?: string; frontmatter?: Record<string, string>; rewrite?: Rewrite[]; exclude?: string[] }
type Catalog = { groups: Group[]; items: Item[]; skills?: Source[]; exclusives?: Record<string, string> }
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
// Catalog groups opened with their ▸ Mostrar; like Suas skills, every group starts hidden.
const openGroups = new Set<string>()
let pending: { id: string; action: 'install' | 'remove' } | null = null
// What the cards show beyond installed: a command's output, the rules in CLAUDE.md, the project and the mods.
const outputs: Record<string, string> = {}
let rules: Record<string, boolean> = {}
let preparedHere: Record<string, boolean> = {}
let setupDone: Record<string, boolean> = {}
let modsOff: Record<string, boolean> = {}
let confirmRecommended = false
let busy = ''
let note = ''
const hinted = new Set<string>()
let rulesText = ''
// The folder isCode was worked out for. The desktop app starts a chat early in an empty spare
// folder (~/.claude/spares/...) and moves it into the project afterwards: a check made only at
// session.start sees the spare folder, so the check is redone whenever the folder changed.
let detectedFor = ''
let autoOpened = false
// A folder with no project marker yet (a project started from zero): Ponytail joins the first prompt
// that reads like code work, as hidden context sent once. Never the system prompt mid-chat: that
// would rewrite the whole prompt cache; a prompt's context is just a slightly longer message.
let byPrompt = false
const CODE_PROMPT = /```|\b(c[oó]digo|code|program(a|ar|ação|ming)|fun[cç][aã]o|function|classe|class|m[eé]todo|method|endpoint|api|script|bug|deploy|frontend|backend|banco de dados|database|sql|schema|react|angular|vue|next\.?js|node|npm|java|python|typescript|javascript|kotlin|rust|golang|spring|django|flask|docker|html|css|git)\b|\b(implement|refator|refactor|compil)\w*|\bcri(e|ar|a) (um|uma|o|a) (app|aplicativo|site|sistema|api|cli|bot|jogo|extens[aã]o|plugin|biblioteca|projeto)\b/i
// Bundled-skill updates: checked against GitHub at most once a week, applied only on a click.
const WEEK = 7 * 24 * 60 * 60 * 1000
let updates: Update[] = []
let checkedAt = 0
let checking = false
let confirmUpdates = false

// The dashboard of this chat's Serena: each chat runs its own, on the first free port from 24282, and only
// its log holds this chat's Serena session id.
const SERENA_SH = 'for p in $(seq 24282 24301); do curl -s -m 2 -X POST -H "Content-Type: application/json" -d \'{"start_idx":0}\' "http://127.0.0.1:$p/get_log_messages" | grep -qF "$1" && { echo "http://127.0.0.1:$p/dashboard/index.html"; exit 0; }; done; exit 1'
// Serena's dashboard never opens by itself; the first time Serena activates a project in this chat, a band offers it.
let serenaSession = ''
let serenaBand = false
// A skill command typed at the start of the prompt (/coding-kit:grill-me ...): painted orange, with a band
// above the prompt that shows its card. `skillOpen` is the band opened, for the rest of this chat.
type Typed = { start: number; end: number; item?: Item; mine?: Found }
let typed: Typed | null = null
let skillOpen = false
// The draft as this mod last saw it. A change that raises no event (a Tab completion in the desktop app)
// is caught by reading the box while the draft starts with a slash.
let draft = ''
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

// One catalog card, drawn in the pane and, opened, in the band of a typed skill. Its buttons go to the
// same ui.press hook wherever they are drawn. The band hides Usar: the command is already typed.
type Els = ReturnType<EngineInterface['ui']['resolve']>
function itemCard(els: Els, item: Item, width: number, inBand = false) {
  const { Box, Text, Button } = els
  const cw = width - 4
  const noop = () => undefined
  const inst = isTool(item)
  const isIn = installed[item.id]
  const group = catalog.groups.find(g => g.id === item.group)
  const waits = !!(item.needsSetup && group?.setup && !setupDone[group.id])
  const why = item.exclusive ? catalog.exclusives?.[item.exclusive] : undefined
  const mod = item.overlapsMod
  const shown = inst ? !!isIn : true
  const confirm = pending?.id === item.id
  const hot = hinted.has(item.id)
  const other = inst && !isIn ? clash(item) : undefined
  return (
    <Box key={`card-${item.id}`} flexDirection="column" width={width} marginBottom={1} borderStyle="round" borderColor={hot ? ACCENT : undefined} borderDimColor={!hot} paddingX={1}>
      <Box key={`title-${item.id}`} flexDirection="row" justifyContent="space-between" width={cw}>
        <Text bold wrap="truncate-end">{item.label}</Text>
        {item.repo ? <Button key={`repo:${item.id}`} plain dimColor onPress={noop}>⎇</Button> : null}
      </Box>
      {/* Marks under the name, side by side, so a narrow pane never cuts the name for them. */}
      {(item.recommended && !hot) || hot || inst ? (
        <Box key={`badges-${item.id}`} flexDirection="row" gap={1} width={cw}>
          {item.recommended && !hot ? <Text color={ACCENT}>★ recomendado</Text> : null}
          {hot ? <Text color={ACCENT}>★ sugerido</Text> : inst ? <Text color={isIn ? GOOD : undefined} dimColor={!isIn}>{busy === item.id ? '…' : isIn ? '✓ instalado' : 'não instalado'}</Text> : null}
        </Box>
      ) : null}
      <Text dimColor wrap="wrap">{item.description}</Text>
      {item.command ? <Text dimColor wrap="truncate-end">{`${item.command}${item.source ? ` · ${item.source}` : ''}`}</Text> : null}
      {mod ? <Text color={WARN} wrap="wrap">{`⚠ ${mod.why}${modsOff[mod.mod] ? ` O ${mod.mod} está desligado.` : ''}`}</Text> : null}
      {inst && isIn && item.prepared ? <Text color={preparedHere[item.id] ? GOOD : undefined} dimColor={!preparedHere[item.id]}>{preparedHere[item.id] ? '✓ pronto neste projeto' : 'ainda não preparado neste projeto'}</Text> : null}
      {outputs[item.id] ? <Text dimColor wrap="wrap">{outputs[item.id]}</Text> : null}
      {other && !confirm ? (
        <Box key={`clash-${item.id}`} width={cw}>
          <Text dimColor wrap="wrap">{`Remova ${other.label.split(' (')[0]} antes${why ? `: ${why}` : ''}`}</Text>
        </Box>
      ) : null}
      {confirm ? (
        <Box flexDirection="column" width={cw}>
          <Text color={WARN} wrap="wrap">{pending!.action === 'install' ? 'Instalar? Muda a config do Claude Code (vale para chats novos).' : 'Remover?'}</Text>
          {pending!.action === 'install' ? (item.changes ?? []).map((c, i) => <Text key={`chg-${i}`} dimColor wrap="wrap">{`• ${c}`}</Text>) : null}
          <Box flexDirection="row" gap={1}>
            <Button key="confirm" label="Confirmar" variant="primary" onPress={noop} />
            <Button key="cancel" label="Cancelar" onPress={noop} />
          </Box>
        </Box>
      ) : (
        <Box key={`buttons-${item.id}`} flexDirection="row" gap={1}>
          {!inBand && waits ? <Text dimColor>{`Usar · precisa configurar antes (${group!.setup!.label})`}</Text> : null}
          {!inBand && !waits && (!inst || isIn) && (item.command || item.fill) ? (typed?.item?.id === item.id ? <Text dimColor>Usar · já no prompt</Text> : <Button key={`use:${item.id}`} label="Usar" variant="primary" onPress={noop} />) : null}
          {shown ? (item.actions ?? []).map(a => <Button key={`action:${item.id}/${a.id}`} label={a.rule && rules[ruleKey(item, a)] ? (a.offLabel ?? a.label) : a.label} onPress={noop} />) : null}
          {mod && inst && isIn ? <Button key={`${modsOff[mod.mod] ? 'mod-on' : 'mod-off'}:${item.id}`} label={modsOff[mod.mod] ? `Religar o ${mod.mod}` : `Desligar o ${mod.mod}`} onPress={noop} /> : null}
          {inst && busy !== item.id ? <Button key={`${isIn ? 'remove' : 'install'}:${item.id}`} label={isIn ? 'Remover' : 'Instalar'} onPress={noop} /> : null}
        </Box>
      )}
    </Box>
  )
}

// The skill whose command starts the draft: a catalog skill (by its full or short name) or one of yours.
function typedSkill(text: string): Typed | null {
  const m = /^(\s*)(\/\S+)/.exec(text)
  const cmd = m?.[2]
  if (!m || !cmd) return null
  const start = (m[1] ?? '').length
  const end = start + cmd.length
  const short = (c: string) => `/${c.slice(c.indexOf(':') + 1)}`
  const item = catalog.items.find(i => i.kind === 'skill' && i.command && (i.command === cmd || short(i.command) === cmd))
  if (item) return { start, end, item }
  const mine = found.find(f => f.command === cmd)
  return mine ? { start, end, mine } : null
}
const paintOf = (t: Typed | null) => (t ? [{ start: t.start, end: t.end, color: ACCENT }] : [])
// Paints the command over a draft no prompt.edit carried (an accepted Tab completion, a fill). The box
// may still be settling, and the app styles an accepted completion itself: so a stale draft is read
// again, a miss is tried again, and a hit is painted once more a moment later to stand over that style.
async function watchDraft($: EngineInterface) {
  if (off || !draft.trimStart().startsWith('/')) return
  const box = await $.prompt.read()
  if (box.text === draft) return
  draft = box.text
  const t = typedSkill(draft)
  setTyped($, t)
  if (t) await paintTyped($, draft)
}
async function paintTyped($: EngineInterface, first: string) {
  let text = first
  let hits = 0
  for (let i = 0; i < 5 && hits < 2; i++) {
    const t = typedSkill(text)
    const res = await $.prompt.paint({ text, decorations: paintOf(t) })
    if (res.text !== text) {
      text = res.text
      setTyped($, typedSkill(text))
      continue
    }
    if (!t) return
    if (res.isPainted) hits++
    else if (i === 4) await log($, `paint missed: ${JSON.stringify(text.slice(0, 40))}`)
    await $.clock.sleep(res.isPainted ? 150 : 40)
  }
}
function setTyped($: EngineInterface, t: Typed | null) {
  const key = (x: Typed | null) => (x ? `${x.item?.id ?? x.mine?.command}@${x.start}-${x.end}` : '')
  if (key(t) === key(typed)) return
  typed = t
  redraw($)
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

async function codeNow($: EngineInterface): Promise<boolean> {
  const dir = await $.session.cwd().catch(() => cwd)
  if (dir && dir !== detectedFor) {
    cwd = dir
    detectedFor = dir
    isCode = await detect($).catch(() => false)
    void log($, `code project: ${isCode ? 'yes' : 'no'} cwd=${dir}`)
    redraw($)
  }
  return !!isCode
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
    catalog = { groups: json.groups ?? [], items: (json.items ?? []).filter(i => i && i.id && i.label), skills: (json.skills ?? []).filter(x => x && x.dir && x.repo && x.path), exclusives: json.exclusives ?? {} }
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

const isTool = (item: Item) => item.kind === 'mcp' || item.kind === 'tool' || item.kind === 'plugin'

// A plugin item installs through its marketplace unless it lists its own steps.
function stepsOf(item: Item, action: 'install' | 'remove'): Step[] {
  const own = action === 'install' ? item.install : item.uninstall
  if (own || item.kind !== 'plugin' || !item.plugin) return own ?? []
  const market = item.plugin.split('@')[1] ?? ''
  return action === 'install'
    ? [...(item.marketplace ? [['claude', 'plugin', 'marketplace', 'add', item.marketplace]] : []), ['claude', 'plugin', 'install', item.plugin]]
    : [['claude', 'plugin', 'uninstall', item.plugin], ...(market ? [['claude', 'plugin', 'marketplace', 'remove', market]] : [])]
}

// Every step and check sees the item's env and ~/.local/bin, where the install scripts put their binaries.
async function envOf($: EngineInterface, item: Item): Promise<Record<string, string>> {
  const path = trim(await $.env.get('PATH').catch(() => undefined))
  return { ...(item.env ?? {}), PATH: `${home}/.local/bin${path ? `:${path}` : ''}` }
}

const ruleKey = (item: Item, a: Action) => `${item.id}/${a.id}`
const ruleOpen = (key: string) => `<!-- coding-kit:${key} -->`
const ruleClose = (key: string) => `<!-- /coding-kit:${key} -->`
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readText($, path)
    const j = raw ? (JSON.parse(raw) as unknown) : {}
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function refreshStatus($: EngineInterface) {
  const servers = await mcpServers($)
  const plugins = ((await readJson($, `${claudeDir}/plugins/installed_plugins.json`)).plugins ?? {}) as Record<string, unknown>
  const next: Record<string, boolean | undefined> = {}
  for (const item of catalog.items) {
    if (item.kind === 'mcp' && item.server) next[item.id] = item.server in servers
    else if (item.kind === 'plugin' && item.plugin) next[item.id] = item.plugin in plugins
    else if (item.kind === 'tool' && item.check) {
      const r = await $.process.run(item.check.argv, { timeoutMs: 20_000, env: await envOf($, item) }).catch(() => null)
      next[item.id] = !!r && r.exitCode === 0 && (!item.check.match || r.stdout.includes(item.check.match))
    }
  }
  installed = next
  const md = await readText($, `${claudeDir}/CLAUDE.md`)
  const nextRules: Record<string, boolean> = {}
  const nextPrepared: Record<string, boolean> = {}
  for (const item of catalog.items) {
    for (const a of item.actions ?? []) if (a.rule) nextRules[ruleKey(item, a)] = md.includes(ruleOpen(ruleKey(item, a)))
    if (item.prepared && cwd) nextPrepared[item.id] = await $.fs.exists(`${cwd}/${item.prepared}`).catch(() => false)
  }
  rules = nextRules
  preparedHere = nextPrepared
  const nextSetup: Record<string, boolean> = {}
  for (const g of catalog.groups) if (g.setup && cwd) nextSetup[g.id] = await $.fs.exists(`${cwd}/${g.setup.done}`).catch(() => false)
  setupDone = nextSetup
  const sw = await readJson($, `${claudeDir}/mods/switches.json`)
  modsOff = Object.fromEntries(Object.entries(sw).filter(([, v]) => v === false).map(([k]) => [k, true]))
  redraw($)
}

// Puts a rule block in ~/.claude/CLAUDE.md, or takes it out; the rest of the file stays as it was.
async function toggleRule($: EngineInterface, item: Item, a: Action) {
  const path = `${claudeDir}/CLAUDE.md`
  const key = ruleKey(item, a)
  const text = await readText($, path)
  const block = new RegExp(`\\n?${escapeRe(ruleOpen(key))}[\\s\\S]*?${escapeRe(ruleClose(key))}\\n?`)
  const next = block.test(text) ? text.replace(block, '') : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${ruleOpen(key)}\n${a.rule}\n${ruleClose(key)}\n`
  await $.fs.write(path, next)
  rules[key] = next.includes(ruleOpen(key))
  await log($, `${key}: rule ${rules[key] ? 'added' : 'removed'}`)
}

// Turns a mod of this pack off or back on in switches.json, as the /mods pane does.
async function setMod($: EngineInterface, mod: string, on: boolean) {
  const path = `${claudeDir}/mods/switches.json`
  const json = await readJson($, path)
  if (on) delete json[mod]
  else json[mod] = false
  await $.fs.write(path, `${JSON.stringify(json, null, 2)}\n`)
  if (on) delete modsOff[mod]
  else modsOff[mod] = true
  await log($, `${mod}: turned ${on ? 'on' : 'off'} from the Coding Kit pane`)
}

async function runAction($: EngineInterface, item: Item, a: Action) {
  if (a.fill) return use($, a.fill)
  if (a.rule) return toggleRule($, item, a)
  if (!a.run) return
  outputs[item.id] = '…'
  redraw($)
  // Up to ten minutes: indexing a big repo takes a while.
  const r = await $.process.run(a.run, { timeoutMs: 600_000, env: await envOf($, item) }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  outputs[item.id] = (r.stdout.trim() || r.stderr.trim() || `saiu com ${r.exitCode}`).slice(-800)
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

type Head = { sha: string; date: string }
async function lastCommit($: EngineInterface, repo: string, path: string, ref?: string): Promise<Head | undefined> {
  const r = ref ? `&sha=${encodeURIComponent(ref)}` : ''
  const list = JSON.parse(await http($, `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}${r}&per_page=1`)) as { sha: string; commit: { committer: { date: string } } }[]
  return list[0] ? { sha: list[0].sha, date: list[0].commit.committer.date } : undefined
}
// The folder every source of a repo sits in: one request on it says whether any of them changed.
function commonPath(paths: string[]) {
  const parts = paths.map(p => p.split('/'))
  const out: string[] = []
  for (let i = 0; parts.every(x => x.length > i + 1) && parts.every(x => x[i] === parts[0]![i]); i++) out.push(parts[0]![i]!)
  return out.join('/')
}

// At most once a week: one GitHub request per repo (on the folder its skills share), and one per skill only
// in a repo where something changed: the last commit that touched each folder.
async function checkUpdates($: EngineInterface, force = false) {
  if (checking || off) return
  const now = await $.clock.now()
  if (!force && now - checkedAt < WEEK) return
  checking = true
  redraw($)
  try {
    const lock = await readLock($)
    const found: Update[] = []
    let gated = false
    const repos = [...new Set((catalog.skills ?? []).map(x => x.repo))]
    for (const repo of repos) {
      const srcs = (catalog.skills ?? []).filter(x => x.repo === repo)
      const root = srcs.length > 1 ? commonPath(srcs.map(x => x.path)) : ''
      const gate = root ? await lastCommit($, repo, root, srcs[0]!.ref) : undefined
      if (gate && lock[`@${repo}`]?.sha === gate.sha) continue
      const before = found.length
      for (const src of srcs) {
        const head = await lastCommit($, src.repo, src.path, src.ref)
        if (head && head.sha !== lock[src.dir]?.sha) found.push({ dir: src.dir, repo: src.repo, from: lock[src.dir]?.sha ?? '', to: head.sha, date: head.date })
      }
      // Nothing to update in this repo: its gate moves on, so next week costs one request again.
      if (gate && found.length === before) {
        lock[`@${repo}`] = gate
        gated = true
      }
    }
    if (gated) await $.fs.write(lockPath($), `${JSON.stringify(lock, null, 2)}\n`)
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
      const files: [string, string][] = []
      // The whole folder, subfolders too (scripts, references), but for the ones the source leaves out.
      const walk = async (sub: string) => {
        const items = JSON.parse(await http($, `https://api.github.com/repos/${src.repo}/contents/${src.path}${sub ? `/${sub}` : ''}?ref=${u.to}`)) as { name: string; type: string; download_url: string | null }[]
        for (const it of items) {
          const rel = sub ? `${sub}/${it.name}` : it.name
          if (it.type === 'dir') {
            if (!(src.exclude ?? []).includes(it.name)) await walk(rel)
            continue
          }
          if (it.type !== 'file' || !it.download_url) continue
          const raw = await http($, it.download_url)
          files.push([rel, rel === 'SKILL.md' ? fitSkill(raw, src, u.to) : rewrite(raw, src)])
        }
      }
      await walk('')
      if (!files.some(f => f[0] === 'SKILL.md')) throw new Error(`${src.dir}: no SKILL.md upstream`)
      const dir = `${$.plugin.root}/skills/${src.dir}`
      for (const [name, text] of files) {
        if (name.includes('/')) await $.process.run(['mkdir', '-p', `${dir}/${name.slice(0, name.lastIndexOf('/'))}`]).catch(() => undefined)
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
  // The fill carries its own paint and sets the band here: the desktop app raises no prompt.change for it.
  const t = typedSkill(text)
  const r = await $.prompt.fill({ text, mode: 'replace', decorations: paintOf(t) }).catch(err => {
    void log($, `fill: ${String(err)}`)
    return null
  })
  // A replace leaves exactly `text`; the box handed back may not have caught up yet.
  if (r && !r.isFilled) return
  draft = text
  setTyped($, t)
}

async function runSteps($: EngineInterface, item: Item, steps: Step[]) {
  const env = await envOf($, item)
  for (const step of steps) {
    const argv = Array.isArray(step) ? step : step.argv
    const match = Array.isArray(step) ? undefined : step.match
    await log($, `run: ${argv.join(' ')}`)
    const r = await $.process.run(argv, { timeoutMs: 600_000, env })
    if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-300)}`)
    if (match && !r.stdout.includes(match)) throw new Error(`a conferência \`${argv.join(' ')}\` não mostrou "${match}" (${r.stdout.trim().slice(0, 120) || 'nada'})`)
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
      try {
        await runSteps($, item, stepsOf(item, 'install'))
      } catch (err) {
        // A half-done install is undone: its remove steps run, each allowed to fail.
        for (const step of stepsOf(item, 'remove')) await runSteps($, item, [step]).catch(() => undefined)
        throw new Error(`${String(err instanceof Error ? err.message : err)}. O que já tinha sido feito foi desfeito`)
      }
      note = `${item.label} instalado. Vale para chats novos.`
    } else {
      await runSteps($, item, stepsOf(item, 'remove'))
      note = `${item.label} removido. Vale para chats novos.`
    }
  } catch (err) {
    note = `Não deu: ${String(err instanceof Error ? err.message : err)}`
    await log($, `${item.id} ${action}: ${note}`)
  }
  busy = ''
  await refreshStatus($)
}

// The recommended tools not installed yet, but for one a conflicting tool already holds the place of.
const missingRecommended = () => catalog.items.filter(i => i.recommended && isTool(i) && !installed[i.id] && !clash(i))

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
    await codeNow($)
    await $.command.register({ name: 'coding-kit', description: 'Open the Coding Kit pane: one-click coding skills and tools; /coding-kit ponytail off|lite|full|ultra' })
    $.clock.every(3000, () => {
      void readSwitch($).catch(() => undefined)
    })
    $.clock.every(400, () => {
      void watchDraft($).catch(() => undefined)
    })
    void refreshStatus($).catch(err => log($, `status: ${String(err)}`))
    void findSkills($).catch(err => log($, `skills: ${String(err)}`))
    // Once a week at most, in the background: it never holds the chat up.
    void checkUpdates($).catch(err => log($, `updates: ${String(err)}`))
    return next(e)
  })

  // Ponytail's rules join the system prompt in code projects. Read once per chat, then cached.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (off || level === 'off' || !rulesText) return r
    if (!(await codeNow($))) return r
    return { ...r, sections: [...r.sections, { id: `${NAME}:ponytail`, text: ponytailSection(level), scope: 'session' as const }] }
  })

  // A suggestion in the pane when the prompt looks like a known case: a regex, no model call.
  on('prompt.submit', async ($, e, next) => {
    let x = e
    // Only what the person typed: the desktop app puts <system-reminder> blocks in the prompt's
    // text (in a chat with no folder, one about the scratch workspace), which must not count.
    const typed = e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    // The pane opens at the first prompt about code, never at chat start: a chat in a code folder
    // can be about anything.
    if (!off && autoOpen && !autoOpened && CODE_PROMPT.test(typed) && (await codeNow($))) {
      autoOpened = true
      void openPane($)
    }
    if (!off && level !== 'off' && rulesText && !byPrompt && !(await codeNow($)) && CODE_PROMPT.test(typed)) {
      byPrompt = true
      void log($, 'ponytail: joined a prompt (no project marker in the folder yet)')
      x = { ...e, context: [...(e.context ?? []), ponytailSection(level)] }
      if (autoOpen && !autoOpened) {
        autoOpened = true
        void openPane($)
      }
      redraw($)
    }
    if (!off) {
      for (const item of catalog.items) {
        if (!item.hint || hinted.has(item.id)) continue
        let hit = false
        try {
          hit = new RegExp(item.hint, 'i').test(typed)
        } catch {
          continue
        }
        if (!hit) continue
        hinted.add(item.id)
        redraw($)
        $.ui.toast(`Coding Kit: para isso, experimente “${item.label}” (${item.command ?? item.fill ?? ''})`)
      }
    }
    return next(x)
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
    if (what === 'use' && item) {
      if (typed?.item?.id !== item.id) await use($, item.fill ?? `${item.command ?? ''} `)
    } else if (what === 'mine' && id) {
      if (typed?.mine?.command !== id) await use($, `${id} `)
    }
    else if (what === 'serena-open') {
      serenaBand = false
      const r = await $.process.run(['/bin/sh', '-c', SERENA_SH, 'sh', serenaSession], { timeoutMs: 60_000 }).catch(() => null)
      const url = r?.exitCode === 0 ? r.stdout.trim() : ''
      if (url) await $.process.run(['/bin/sh', '-c', OPEN_SH, 'sh', url], { timeoutMs: 15_000 }).catch(() => undefined)
      else $.ui.toast('Coding Kit: não achei o painel do Serena deste chat.')
    } else if (what === 'serena-dismiss') serenaBand = false
    else if (what === 'skill-open') skillOpen = !skillOpen
    else if (what === 'skill-close') {
      // Takes only the command (and one space after it) out of the draft; the rest stays as typed.
      const box = await $.prompt.read()
      const t = typedSkill(box.text)
      if (t) {
        const cut = t.end + (box.text[t.end] === ' ' ? 1 : 0)
        const cursor = box.cursor >= cut ? box.cursor - cut : 0
        await $.prompt.fill({ text: box.text.slice(cut), mode: 'replace', cursor }).catch(err => log($, `fill: ${String(err)}`))
      }
      typed = null
    }
    else if (what === 'repo' && item?.repo) await $.process.run(['/bin/sh', '-c', OPEN_SH, 'sh', item.repo], { timeoutMs: 15_000 }).catch(() => undefined)
    else if (what === 'level' && LEVELS.includes(id as Level)) {
      level = id as Level
      await $.store.set('ponytail', level)
      note = `Ponytail: ${level}. Vale a partir do próximo chat (para não regravar o cache deste).`
    } else if (what === 'auto') {
      autoOpen = !autoOpen
      await $.store.set('autoOpen', autoOpen)
    } else if (what === 'action' && id) {
      const [itemId = '', actionId = ''] = id.split('/')
      const it = catalog.items.find(i => i.id === itemId)
      const a = it?.actions?.find(x => x.id === actionId)
      if (it && a) await runAction($, it, a)
    } else if ((what === 'mod-off' || what === 'mod-on') && item?.overlapsMod) await setMod($, item.overlapsMod.mod, what === 'mod-on')
    else if (what === 'setup' && id) {
      const g = catalog.groups.find(x => x.id === id)
      if (g?.setup) await use($, `${g.setup.command} `)
    } else if (what === 'install-recommended') confirmRecommended = true
    else if (what === 'cancel-recommended') confirmRecommended = false
    else if (what === 'confirm-recommended') {
      confirmRecommended = false
      const todo = missingRecommended()
      void (async () => {
        for (const it of todo) await act($, it, 'install')
      })()
    } else if (what === 'toggle-mine') showMine = !showMine
    else if (what === 'toggle-group' && id) {
      if (!openGroups.delete(id)) openGroups.add(id)
    }
    else if ((what === 'install' || what === 'remove') && item) {
      // a clash is already shown beside the button
      if (what === 'remove' || !clash(item)) pending = { id: item.id, action: what }
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

  // Typing: paint the skill command orange in the box the editor shows, and keep the band in step.
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    if (off) return r
    draft = r.text
    const t = typedSkill(r.text)
    setTyped($, t)
    return t ? { ...r, decorations: [...(r.decorations ?? []), ...paintOf(t)] } : r
  }).catch(($, e, next) => next(e))

  // Any other change (history, a fill, a clear, a submit): the same, painted over the box as it stands.
  on('prompt.change', async ($, e, next) => {
    const r = await next(e)
    if (off) return r
    draft = e.text
    if (e.text.trimStart().startsWith('/')) void log($, `prompt.change ${e.origin.kind}: ${JSON.stringify(e.text.slice(0, 40))}`)
    const t = typedSkill(e.text)
    setTyped($, t)
    if (t) void paintTyped($, e.text).catch(err => log($, `paint: ${String(err)}`))
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || !typed || e.props.hasSurvey) return next(e)
    const rest = await next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const noop = () => undefined
    const width = Math.max(32, e.props.bodyColumns)
    const t = typed
    const label = t.item?.label ?? t.mine!.command
    const description = t.item?.description ?? t.mine!.description
    const toggle = <Button key="skill-open" plain dimColor onPress={noop}>{skillOpen ? '▴' : '▾'}</Button>
    const close = <Button key="skill-close" plain dimColor role="dismiss" onPress={noop}>✕</Button>
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} width={width}>
          <Text wrap="truncate-end">
            <Text color={ACCENT}>{`◆ ${label}`}</Text>
            {skillOpen ? null : <Text dimColor>{` — ${description}`}</Text>}
          </Text>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {toggle}
            {close}
          </Box>
        </Box>
        {skillOpen && t.item ? itemCard(els, t.item, width, true) : null}
        {skillOpen && t.mine ? (
          <Box flexDirection="column" width={width} borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor>{`${t.mine.command} · ${t.mine.from}`}</Text>
            {t.mine.description ? <Text dimColor wrap="wrap">{t.mine.description}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )
  })

  // One unfiltered hook: a typed tool matcher makes tsc recurse through the connector types.
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) !== 'mcp__serena__activate_project') return next(e)
    const ran = await next(e)
    const session = String((e as unknown as { session?: unknown }).session ?? '')
    if (!off && !serenaSession && session && !ran.isError && ran.deny === undefined) {
      serenaSession = session
      serenaBand = true
      redraw($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || !serenaBand || e.props.hasSurvey) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Text>
            <Text color={ACCENT}>Serena ativo neste projeto.</Text>
            <Text dimColor> Abrir o painel dele (logs e uso das ferramentas)?</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="serena-open" label="Abrir painel" variant="primary" onPress={noop} />
            <Button key="serena-dismiss" label="Agora não" role="dismiss" onPress={noop} />
          </Box>
        </Box>
      </Box>
    )
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
    const tools = catalog.items.filter(isTool)
    const tiles = [
      { label: 'Ponytail', value: isCode || byPrompt ? level : 'inativo' },
      { label: 'Skills', value: String(catalog.items.length - tools.length + found.length) },
      { label: 'Ferramentas', value: `${tools.filter(t => installed[t.id]).length}/${tools.length}` },
    ]
    const tileW = Math.floor((width - (tiles.length - 1)) / tiles.length)

    const card = (item: Item) => itemCard(els, item, width)
    // One header for every section: its title and count, and ▾ Esconder / ▸ Mostrar.
    const header = (title: string, count: number, open: boolean, key: string) => (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold wrap="truncate-end">{title.includes('(') ? `${title} · ${count}` : `${title} (${count})`}</Text>
        <Button key={key} plain dimColor onPress={noop}>{open ? '▾ Esconder' : '▸ Mostrar'}</Button>
      </Box>
    )

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
          <Text dimColor wrap="wrap">{isCode || byPrompt ? 'Ponytail (vale a partir do próximo chat):' : 'Esta pasta ainda não parece um projeto de código: o Ponytail entra no primeiro prompt que pedir código.'}</Text>
          <Box flexDirection="row" gap={1}>
            {LEVELS.map(l => (
              <Button key={`level:${l}`} label={l === level ? `● ${l}` : l} variant={l === level ? 'primary' : undefined} onPress={noop} />
            ))}
          </Box>
          <Button key="auto" plain dimColor onPress={noop}>{autoOpen ? '☑ Abrir sozinho no primeiro pedido de código' : '☐ Abrir sozinho no primeiro pedido de código'}</Button>
          {/* The desktop app shows no tooltip in a pane: the label says what it does, short. */}
          <Button key="refresh" plain dimColor onPress={noop}>↻ Reler instalados e skills do disco</Button>
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
        {missingRecommended().length ? (
          <Box key="recommended" flexDirection="column" width={width} marginBottom={1} borderStyle="round" borderColor={ACCENT} paddingX={1}>
            {confirmRecommended ? (
              <Box flexDirection="column" width={cw}>
                <Text color={WARN} wrap="wrap">{`Instalar ${missingRecommended().map(i => i.label.split(' (')[0]).join(' e ')}? Muda a config do Claude Code (vale para chats novos).`}</Text>
                {missingRecommended().flatMap(i => (i.changes ?? []).map((c, k) => <Text key={`rc-${i.id}-${k}`} dimColor wrap="wrap">{`• ${c}`}</Text>))}
                <Box flexDirection="row" gap={1}>
                  <Button key="confirm-recommended" label="Confirmar" variant="primary" onPress={noop} />
                  <Button key="cancel-recommended" label="Cancelar" onPress={noop} />
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column" width={cw}>
                <Text dimColor wrap="wrap">{`Recomendados: ${missingRecommended().map(i => i.label.split(' (')[0]).join(', ')}. Quase não custam contexto ou reduzem tokens.`}</Text>
                <Button key="install-recommended" label={`Instalar os recomendados (${missingRecommended().length})`} variant="primary" onPress={noop} />
              </Box>
            )}
          </Box>
        ) : null}
        <Box key="mine" flexDirection="column" width={width} marginBottom={1}>
          {header('Suas skills', found.length, showMine, 'toggle-mine')}
          {showMine
            ? found.map(f => (
                <Box key={`mine-${f.command}`} flexDirection="column" width={width} marginBottom={1} borderStyle="round" borderDimColor paddingX={1}>
                  <Box flexDirection="row" justifyContent="space-between" width={cw}>
                    <Text bold wrap="truncate-end">{f.command}</Text>
                    <Text dimColor>{f.from}</Text>
                  </Box>
                  {f.description ? <Text dimColor wrap="wrap">{f.description}</Text> : null}
                  {typed?.mine?.command === f.command ? <Text dimColor>Usar · já no prompt</Text> : <Button key={`mine:${f.command}`} label="Usar" onPress={noop} />}
                </Box>
              ))
            : null}
        </Box>
        {catalog.groups.map(g => {
          // Recommended first; the rest keep the catalog's order.
          const all = catalog.items.filter(i => i.group === g.id)
          const items = [...all.filter(i => i.recommended), ...all.filter(i => !i.recommended)]
          if (!items.length) return null
          return (
            <Box key={`group-${g.id}`} flexDirection="column" width={width} marginBottom={openGroups.has(g.id) ? 0 : 1}>
              {header(g.title, items.length, openGroups.has(g.id), `toggle-group:${g.id}`)}
              {openGroups.has(g.id) && g.setup ? (
                <Box key={`setup-${g.id}`} flexDirection="row" gap={1} width={width} marginBottom={1}>
                  {setupDone[g.id] ? <Text color={GOOD}>✓ configurado neste repositório</Text> : <Button key={`setup:${g.id}`} label={g.setup.label} variant="primary" onPress={noop} />}
                </Box>
              ) : null}
              {openGroups.has(g.id)
                ? items.flatMap((it, i) => (it.sub && it.sub !== items[i - 1]?.sub ? [<Text key={`sub-${g.id}-${it.sub}`} bold dimColor>{it.sub}</Text>, card(it)] : [card(it)]))
                : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}
