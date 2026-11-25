import type { EngineInterface, Register } from 'claude-code'

// Vault: a second brain in an Obsidian vault, run as plain Markdown files. Obsidian never has
// to be open: Claude reads and writes the notes with its own file tools, and Obsidian shows
// them (graph, backlinks, Bases) whenever the person opens it.
//
// 1. /vault use <folder> and /vault setup para|zettel|existing make the vault: folders, a
//    CLAUDE.md with the vault's conventions, note templates and a Base.
// 2. Handoffs, research briefs and (opt-in) Input Router reads are copied into <vault>/Claude/
//    with properties and a link to their project's note. Each source file is copied once: a
//    note the person moves or deletes is never written again.
// 3. A Daily note gets one line per chat and per copied note.
// 4. Each prompt is searched against the vault (ripgrep for words, plus qmd's vectors and reranker
//    when its daemon runs; no Claude call). A strong match adds a short hidden hint with the paths
//    and a line of each, never the notes themselves.
// 5. /vault save, ask, inbox and review hand Claude a prompt that works in the vault; ask, inbox and
//    review come with what the hook already found (search hits, links, orphans), so Claude reads less.
// Search: qmd (github.com/tobi/qmd, local BM25 + vectors + rerank) when it is installed, through its
// HTTP daemon (models stay loaded: ~30 ms to ~600 ms a prompt, where a fresh CLI run takes 3-5 s),
// with a multilingual embedding model; ripgrep otherwise.

const NAME = 'vault'
const COLLECTION = 'vault'
const BAND = { plugin: 'vault', key: 'band' } as const
const PURPLE = '#7c3aed'
const CHOICE = { plugin: 'vault', key: 'choice' } as const
// The low line above the chat: what qmd's models did for this prompt.
const SEARCH = { plugin: 'vault', key: 'search' } as const
// The last hints, for the pane; and a counter the pane reads, so a button press redraws it.
const RECENT = { plugin: 'vault', key: 'recent' } as const
const TICK = { plugin: 'vault', key: 'tick' } as const
const PANE = 'vault'
// The weekly review offer in the band; true while it shows.
const REVIEW = { plugin: 'vault', key: 'review' } as const
const WEEK = 7 * 86_400_000
// The model that reads each exchange for something worth keeping: cheap, outside the chat's context.
const CAPTURE_MODEL = 'claude-haiku-5-5'
// qmd's default embedding model is tuned for English; this one covers 119 languages.
const EMBED = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf'
const HINTS = 3
// qmd's own default port: one daemon per index, so a daemon already serving it is reused.
const QMD_URL = 'http://localhost:8181'
// A warm daemon answers in under a second; one that unloaded its models after 5 idle minutes needs ~2 s.
const QMD_MS = 2500
// The reranker's 0..1 relevance: in tests real matches scored 0.44-1.0, unrelated prompts 0-0.36.
// The default cut; /vault corte <n> sets the person's own (see /vault for the last hints' scores).
const MIN_RERANK = 0.4
// A word match with qmd up needs the reranker's nod, even a weak one: long pasted text holds 3+ common
// words of many notes. shortcut: 0.15 is a guess under the 0.36 unrelated prompts reached; tune from the log.
const WEAK_RERANK = 0.15
const cut = () => cfg.cut ?? MIN_RERANK
// How many of the last meaning hints' scores /vault shows.
const SCORES = 20
const FOLDERS: Record<string, string[]> = {
  para: ['Inbox', 'Projects', 'Areas', 'Resources', 'Archive', 'Daily', 'Reviews', 'Templates', 'Claude'],
  zettel: ['Inbox', 'Notes', 'MOCs', 'Sources', 'Projects', 'Daily', 'Reviews', 'Templates', 'Claude'],
  existing: ['Claude'],
}
// Words that say nothing about what a prompt is about, Portuguese and English.
const STOP = new Set(
  (
    'para pelo pela pelos pelas como mais menos muito muita muitos muitas isso isto esse essa esses essas este esta estes estas aquele aquela ' +
    'quero queria preciso pode podes poderia fazer faça faz fiz feito tenho temos tem estou está estão estava ser sido sendo foram será ' +
    'você vocês voce meu minha meus minhas seu sua seus suas nosso nossa dele dela qual quais quando onde porque porquê então entao ' +
    'quanto quanta quantos quantas agora ainda também tambem sobre entre depois antes aqui alguma algum algo tudo todo toda todos todas nada cada mesmo mesma outra outro ' +
    'sim não nao bem quer quem coisa coisas jeito forma vamos veja ver olha olhe deixa favor obrigado certo acho acha sabe saber ' +
    'that this with what from have your about would could should there their them they then than when where which while will just ' +
    'like make made want need does doing done into also some more most only other such very here please thanks know think'
  ).split(' '),
)

type Model = 'para' | 'zettel' | 'existing'
type Config = { path?: string; model?: Model; reads?: boolean; daily?: boolean; cut?: number; capture?: boolean }
type Hit = { path: string; why: string; line?: string; score?: number }
type Stats = { hints: number; read: number; since: number }
type Source = { kind: string; dir: string; to: string; skip?: RegExp }

let claudeDir = ''
let home = ''
let root = ''
let off = false
let cwd = ''
let startedAt = 0
let cfg: Config = {}
let qmd = ''
// `qmd --version`'s number; the reranker filter is read with qmd 2.x's blend, so it waits for a 2.
let qmdVersion = ''
const rerankOk = () => /^2\./.test(qmdVersion)
// Whether the last /health on the port was qmd's, and when it was asked: prompts go only to a checked qmd.
let qmdLive = false
// What qmd did for the last prompt: null when it was not asked or failed.
let lastSearch: { ms: number } | null = null
// The prompt the person typed last, for the capture at the end of its turn.
let lastTyped = ''
let section = ''
let logged = false
let indexedAt = 0
const hinted = new Set<string>()
const opened = new Set<string>()

const trim = (v: string | undefined) => (v ?? '').trim()
const tilde = (p: string) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
const expand = (p: string) => p.trim().replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? ''
const vault = () => cfg.path ?? ''
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const hm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

async function sh($: EngineInterface, script: string, args: string[] = [], timeoutMs = 10_000) {
  return $.process.run(['/bin/sh', '-c', script, 'sh', ...args], { timeoutMs })
}
// A true append: two chats may write the same Daily note.
// A true append through mods-core (which falls back to read and write where the shell fails).
async function append($: EngineInterface, path: string, text: string) {
  await $.mods.append({ path, text })
}
// Writes a file only if it is not there yet, atomically (noclobber): two chats copying the same
// note can not both write it, so only one of them adds its Daily line.
async function createNew($: EngineInterface, path: string, text: string) {
  const r = await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && set -C && cat > "$1"', 'sh', path], { stdin: text, timeoutMs: 10_000 })
  return r.exitCode === 0
}
// One line through mods-core: stamped with the time, its file kept under 2 MB.
async function log($: EngineInterface, line: string) {
  await $.mods.log({ file: 'vault/vault.log', line }).catch(() => undefined)
}

async function setup($: EngineInterface) {
  ;({ home, claudeDir } = await $.mods.paths())
  root = $.plugin.root
  off = (await $.mods.switches())[NAME] === false
  cwd = await $.session.cwd().catch(() => '')
  startedAt = await $.clock.now()
  const c = await $.store.get('config').catch(() => undefined)
  cfg = c && typeof c === 'object' ? (c as Config) : {}
  qmd = await findQmd($)
}

// qmd and its daemon live in mods-core ($.mods.qmd*); a fresh look finds a qmd installed since.
async function findQmd($: EngineInterface) {
  return $.mods.qmdFind({ fresh: true }).catch(() => '')
}
const qmdEnv = () => ({ QMD_EMBED_MODEL: EMBED })
async function readVersion($: EngineInterface) {
  const r = await $.process.run([qmd, '--version'], { timeoutMs: 10_000, env: qmdEnv() }).catch(() => undefined)
  qmdVersion = r?.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? ''
  if (!rerankOk()) await log($, `qmd ${qmdVersion || 'sem versão'}: o filtro do reranker é o do qmd 2.x, então as dicas usam só o ripgrep`)
}

// How many hinted notes Claude then opened: the hints' precision, seen in /vault.
async function stats($: EngineInterface): Promise<Stats> {
  const s = (await $.store.get('stats').catch(() => undefined)) as Partial<Stats> | undefined
  return { hints: s?.hints ?? 0, read: s?.read ?? 0, since: s?.since ?? (await $.clock.now()) }
}
async function count($: EngineInterface, field: 'hints' | 'read', n: number) {
  const s = await stats($)
  await $.store.set('stats', { ...s, [field]: s[field] + n }).catch(() => undefined)
}
// The reranker scores of the last meaning hints, newest last: what /vault corte is calibrated on.
async function scores($: EngineInterface) {
  const v = await $.store.get('scores').catch(() => undefined)
  return Array.isArray(v) ? (v as number[]).filter(n => typeof n === 'number') : []
}
async function keepScores($: EngineInterface, add: number[]) {
  if (add.length) await $.store.set('scores', [...(await scores($)), ...add].slice(-SCORES)).catch(() => undefined)
}

async function saveConfig($: EngineInterface, next: Config) {
  cfg = next
  await $.store.set('config', cfg)
}

// ---- project and daily notes ----

// A chat's project: its folder, unless that is home or a scratch folder.
function projectOf(folder: string) {
  if (!folder || folder === home || folder.startsWith('/tmp/') || folder.includes('/.claude/')) return ''
  return base(folder)
}
const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim()

// A vault adopted as it was gets no Projects/ folder it never had; its notes keep the [[link]].
async function ensureProject($: EngineInterface, name: string, folder: string) {
  if (cfg.model === 'existing' && !(await $.fs.exists(`${vault()}/Projects`))) return
  const path = `${vault()}/Projects/${safeName(name)}.md`
  if (await $.fs.exists(path)) return
  const now = await $.clock.now()
  const text = [
    '---',
    'type: project',
    `date: ${ymd(now)}`,
    'status: ativo',
    ...(folder ? [`folder: ${JSON.stringify(tilde(folder))}`] : []),
    'tags: [projeto]',
    '---',
    `# ${name}`,
    '',
    '## Objetivo',
    '',
    '',
    '## Notas do Claude sobre este projeto',
    '',
    '![[Claude.base#Do projeto]]',
    '',
  ].join('\n')
  await $.process.run(['mkdir', '-p', `${vault()}/Projects`])
  await $.fs.write(path, text)
}

async function daily($: EngineInterface, ms: number, line: string) {
  if (cfg.daily === false) return
  const day = ymd(ms)
  const path = `${vault()}/Daily/${day}.md`
  const head = (await $.fs.exists(path)) ? '' : `---\ntype: daily\ndate: ${day}\ntags: [daily]\n---\n# ${day}\n\n`
  await append($, path, `${head}- ${hm(ms)} ${line}\n`)
}

// ---- copying the other mods' notes into the vault ----

const sources = (): Source[] => [
  { kind: 'handoff', dir: `${claudeDir}/handoffs`, to: 'Claude/Handoffs', skip: /-draft\.md$/ },
  { kind: 'research', dir: `${claudeDir}/mods-logs/research-router`, to: 'Claude/Research' },
  ...(cfg.reads ? [{ kind: 'read', dir: `${claudeDir}/mods-logs/input-router`, to: 'Claude/Reads' }] : []),
]

// A handoff names its folder: "Continue work in `~/x/y`".
const handoffFolder = (text: string) => {
  const m = text.match(/Continue work in `([^`]+)`/)
  return m?.[1] ? expand(m[1]) : ''
}

function noteFor(o: { kind: string; name: string; text: string; project: string; src: string; ms: number }) {
  const title = trim(o.text.match(/^#\s+(.+)$/m)?.[1]) || o.name.replace(/\.md$/, '')
  return [
    '---',
    `type: ${o.kind}`,
    `title: ${JSON.stringify(title)}`,
    `date: ${ymd(o.ms)}`,
    ...(o.project ? [`project: "[[${safeName(o.project)}]]"`] : []),
    `source: ${JSON.stringify(tilde(o.src))}`,
    `tags: [claude, ${o.kind}]`,
    '---',
    '',
    o.text.trimEnd(),
    '',
  ].join('\n')
}

// Runs one at a time: a call waits for the one before it, then copies what is still new.
let chain: Promise<number> = Promise.resolve(0)
const mirror = ($: EngineInterface) => (chain = chain.catch(() => 0).then(() => mirrorOnce($)))
async function mirrorOnce($: EngineInterface) {
  if (off || !vault()) return 0
  {
    const prev = await $.store.get('mirrored').catch(() => undefined)
    const done = new Set(Array.isArray(prev) ? (prev as string[]) : [])
    let n = 0
    for (const s of sources()) {
      const list = await $.fs.list(s.dir).catch(() => [])
      for (const f of [...list].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (f.kind !== 'file' || !f.name.endsWith('.md') || s.skip?.test(f.name)) continue
        const src = `${s.dir}/${f.name}`
        // Keyed by vault too: a vault set later still gets the older notes.
        const key = `${vault()}|${src}`
        if (done.has(key)) continue
        const text = String(await $.fs.read(src))
        // Files written in this chat belong to its folder; older ones only when they say where.
        const folder = s.kind === 'handoff' ? handoffFolder(text) : f.mtimeMs >= startedAt ? cwd : ''
        const project = projectOf(folder)
        const dest = `${vault()}/${s.to}/${f.name}`
        if (await createNew($, dest, noteFor({ kind: s.kind, name: f.name, text, project, src, ms: f.mtimeMs }))) {
          if (project) await ensureProject($, project, folder)
          await daily($, f.mtimeMs, `[[${f.name.replace(/\.md$/, '')}]] (${s.kind}${project ? `, [[${safeName(project)}]]` : ''})`)
        }
        done.add(key)
        n++
      }
    }
    if (n) {
      await $.store.set('mirrored', [...done].slice(-5000))
      await log($, `copied ${n} note(s) into the vault`)
      void reindex($)
    }
    return n
  }
}

// ---- search ----

function keywords(text: string) {
  const words = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
  return [...new Set(words)].slice(0, 12)
}

// ripgrep: a note matches when it holds most of the prompt's words that exist in the vault at all
// (words no note has, like "responda", say nothing), from a word's start, in its text or its name, and
// one of them is rare (in a fifth of the notes or fewer): a word most notes have says nothing either.
// Rarer words rank higher. Run inside the vault, so the globs are anchored at its root.
const RG_GLOBS = ['-g', '*.md', '-g', '!.obsidian/**', '-g', '!/Daily/**', '-g', '!/Templates/**', '-g', '!/CLAUDE.md']
async function rgHits($: EngineInterface, terms: string[]): Promise<(Hit & { n: number; name: boolean })[]> {
  const at = { timeoutMs: 3000, cwd: vault() }
  const [content, files] = await Promise.all([
    // From a word's start, not -w: "palavra" still finds "palavras", and "code" no longer finds "barcode".
    $.process.run(['rg', '-i', '-o', '--no-heading', '--with-filename', '--max-count', '30', ...RG_GLOBS, ...terms.flatMap(t => ['-e', `\\b${t}`]), '.'], at),
    $.process.run(['rg', '--files', ...RG_GLOBS, '.'], at),
  ])
  const seen = new Map<string, Set<string>>()
  const named = new Map<string, Set<string>>()
  const add = (rel: string, found: string, into = seen) => {
    const path = `${vault()}/${rel.replace(/^\.\//, '')}`
    for (const t of terms) if (found.includes(t)) (into.get(path) ?? into.set(path, new Set()).get(path)!).add(t)
  }
  for (const line of content.stdout.split('\n')) {
    const i = line.lastIndexOf(':')
    if (i > 0) add(line.slice(0, i), line.slice(i + 1).toLowerCase())
  }
  const all = files.stdout.split('\n').filter(Boolean)
  for (const rel of all) {
    add(rel, base(rel).toLowerCase())
    add(rel, base(rel).toLowerCase(), named)
  }
  const df = new Map<string, number>()
  for (const s of seen.values()) for (const t of s) df.set(t, (df.get(t) ?? 0) + 1)
  const need = Math.max(2, Math.ceil(df.size * 0.6))
  const rare = (t: string) => (df.get(t) ?? 0) <= Math.max(1, all.length * 0.2)
  const idf = (t: string) => Math.log((all.length + 1) / (df.get(t) ?? 1))
  const score = (s: Set<string>) => [...s].reduce((sum, t) => sum + idf(t), 0)
  // A rare, long word of the prompt in a note's name ("docker" in "Docker multi-stage build") is enough
  // alone: the reranker can miss it, in Portuguese above all.
  const byName = (path: string) => [...(named.get(path) ?? [])].some(t => t.length >= 5 && rare(t))
  return [...seen.entries()]
    .filter(([path, s]) => (s.size >= need && [...s].some(rare)) || byName(path))
    .sort((a, b) => b[1].size - a[1].size || score(b[1]) - score(a[1]))
    .map(([path, s]) => ({ path, why: `termos: ${[...s].join(', ')}`, n: s.size, name: byName(path) }))
}

// qmd's daemon keeps the embedding and rerank models loaded (they unload after 5 idle minutes and
// reload on the next query). Started detached: it outlives the chat and serves every chat after it.
// The port is fixed, so the answer must be qmd's own ({"status":"ok","uptime":n}) before a prompt goes there.
async function qmdUp($: EngineInterface) {
  qmdLive = await $.mods.qmdUp().catch(() => false)
  return qmdLive
}
async function startDaemon($: EngineInterface) {
  if (!qmd || !vault()) return
  const r = await $.mods.qmdStart()
  if (r.out) await log($, `qmd daemon: ${r.out}`)
  // Its PID, so the mod stops only a daemon it started itself.
  if (r.pid) await $.store.set('daemon', r.pid).catch(() => undefined)
  if (!(await qmdUp($))) return
  // Loads the models now, so the first prompt does not wait for them.
  await qmdQuery($, 'vault', 1, 60_000).catch(() => undefined)
}

// With the mod off, the daemon it started goes too: only when qmd's pidfile still names that PID.
async function stopDaemon($: EngineInterface) {
  const pid = await $.store.get('daemon').catch(() => undefined)
  if (!qmd || typeof pid !== 'string' || !pid) return
  const r = await $.mods.qmdStop({ pid })
  await log($, r === 'other' ? `qmd daemon ${pid}: não é mais o do mod, não parei` : `qmd daemon ${pid} parado (mod desligado)`)
  await $.store.set('daemon', null).catch(() => undefined)
}

// One vector search, reranked. The daemon's score blends rank and reranker: for a result whose vector
// rank is k (1-3) it is 0.75/k + 0.25 × rerank, so the reranker's own 0..1 relevance is read back from
// it. The ranges do not overlap for k=1 (0.75-1); for 2 or 3 the lower reading is taken.
// shortcut: those weights are qmd 2.x's (store.ts, rrfWeight); re-read them if qmd changes its blend.
type QmdRow = { path: string; title: string; line: string; rerank: number }
// One search through mods-core: `rerank` is the reranker's 0..1 relevance (see mods-core's qmd.ts).
async function qmdQuery($: EngineInterface, query: string, limit: number, ms = QMD_MS): Promise<QmdRow[]> {
  const rows = await $.mods.qmdQuery({ collection: COLLECTION, text: query, limit, ms })
  return rows
    .map(r => ({ path: `${vault()}/${r.file}`, title: r.title, line: snippetLine(r.snippet), rerank: r.rerank }))
    .filter(h => h.path !== `${vault()}/` && !/\/(Daily|Templates)\//.test(h.path))
}
// The first line of a qmd snippet that says something: no line numbers, diff header, frontmatter or heading.
function snippetLine(s: string) {
  const lines = s.split('\n').map(l => l.replace(/^\d+:\s?/, '').trim())
  const body = lines.filter(l => l && !l.startsWith('@@') && !l.startsWith('#') && l !== '---' && !/^[\w-]+:\s/.test(l))
  return oneLine(body[0] ?? '', 110)
}

// Words and meaning run side by side. With qmd up, a note the reranker finds relevant is hinted, and a
// word match needs its nod (WEAK_RERANK), or a rare word in its name; without it (or with
// a qmd whose blend the reranker reading does not know), the word matches alone.
async function recall($: EngineInterface, text: string): Promise<Hit[]> {
  lastSearch = null
  const terms = keywords(text)
  if (terms.length < 2) return []
  const fail = (what: string) => async (err: unknown) => (await log($, `${what} failed: ${String(err)}`), null)
  // A daemon found down, or one whose last query failed, is asked again on the next prompt: /health
  // answers in ~0 ms when up and at once when refused, so one failure costs one prompt's hints, not more.
  if (qmd && rerankOk() && !qmdLive) await qmdUp($)
  // A qmd 2.x that is installed but failed or is down gives no nod: only a rare word in a note's name
  // gets through, or words alone would bring back the pasted-text noise.
  const asked = Boolean(qmd && rerankOk() && qmdLive)
  const t0 = await $.clock.now()
  const [words, meaning] = await Promise.all([rgHits($, terms).catch(fail('ripgrep')), asked ? qmdQuery($, text, 3).catch(err => ((qmdLive = false), fail('qmd')(err))) : null])
  lastSearch = meaning ? { ms: (await $.clock.now()) - t0 } : null
  const strong = (meaning ?? []).filter(m => m.rerank >= cut())
  const backed = (p: string) => (meaning ?? []).some(m => m.path === p && m.rerank >= WEAK_RERANK)
  const fromWords = (words ?? []).filter(w => (!meaning && !(qmd && rerankOk())) || w.name || backed(w.path)).map(w => ({ ...w, line: (meaning ?? []).find(m => m.path === w.path)?.line }))
  const fromMeaning = strong.filter(m => !fromWords.some(w => w.path === m.path)).map(m => ({ path: m.path, why: `qmd ${m.rerank.toFixed(2)}`, line: m.line, score: m.rerank }))
  return [...fromWords, ...fromMeaning].filter(h => !hinted.has(h.path)).slice(0, HINTS)
}

function hintText(hits: Hit[]) {
  return [
    `Vault (${tilde(vault())}): estas notas podem ter o que o pedido precisa. Se a linha já responde, não abra a nota; se servirem, leia-as antes de pesquisar na web ou reler arquivos grandes; se não, ignore.`,
    ...hits.map(h => `- ${rel(h.path)} (${h.why})${h.line ? `: ${h.line}` : ''}`),
  ].join('\n')
}
const rel = (p: string) => (p.startsWith(`${vault()}/`) ? p.slice(vault().length + 1) : p)

const searchCmd = () =>
  qmd
    ? `QMD_EMBED_MODEL=${EMBED} ${qmd} query $'intent: <o que procura>\\nlex: <palavras exatas>\\nvec: <a ideia em outras palavras>' -c ${COLLECTION} -n 5 --files --no-rerank 2>/dev/null (escreva você mesmo intent, lex e vec: assim o qmd não roda o modelo de expansão, ~1,5 s; imprime docid,score,caminho e o score é só a posição). Leia só a nota que importa, ou um trecho: ${qmd} get <caminho>:<linha>:<quantas>. Nomes e palavras exatas: ${qmd} search "<termos>" -c ${COLLECTION} -n 5 --files 2>/dev/null (instantâneo) ou Grep.`
    : `Grep em ${vault()} (glob *.md)`

function systemSection() {
  return [
    '# Segundo cérebro (vault)',
    `O vault de notas da pessoa fica em \`${vault()}\`: Markdown puro, o Obsidian não precisa estar aberto. Quando a pessoa pedir para guardar, lembrar ou consultar algo no vault, nas notas ou no segundo cérebro, trabalhe nele e siga \`${vault()}/CLAUDE.md\`. Nunca apague notas.`,
    `Buscar no vault: ${searchCmd()}`,
  ].join('\n')
}

// ---- qmd index ----

const OLD_CONTEXT = 'Segundo cérebro da pessoa'
async function ensureCollection($: EngineInterface) {
  if (!qmd || !vault()) return ''
  const list = await $.process.run([qmd, 'collection', 'list'], { timeoutMs: 15_000, env: qmdEnv() }).catch(() => undefined)
  if (list && new RegExp(`\\b${COLLECTION}\\b`).test(list.stdout)) {
    // Version 0.1 added a collection context, which qmd prints on every result line: ~20 tokens each.
    const ctx = await $.process.run([qmd, 'context', 'list'], { timeoutMs: 15_000, env: qmdEnv() }).catch(() => undefined)
    if (ctx?.stdout.includes(OLD_CONTEXT)) await $.process.run([qmd, 'context', 'rm', `qmd://${COLLECTION}`], { timeoutMs: 15_000, env: qmdEnv() }).catch(() => undefined)
    return 'já existia'
  }
  // Daily notes repeat the prompts and templates are empty: both would crowd out real notes.
  const r = await $.process.run([qmd, 'collection', 'add', vault(), '--name', COLLECTION, '--mask', '**/*.md,!Daily/**,!Templates/**,!CLAUDE.md'], { timeoutMs: 120_000, env: qmdEnv() })
  if (r.exitCode !== 0) throw new Error(trim(r.stderr) || trim(r.stdout))
  return 'criada'
}

// Runs detached: the first embedding of a big vault can take longer than a hook may wait.
async function reindex($: EngineInterface) {
  if (!qmd || !vault()) return
  const now = await $.clock.now()
  if (now - indexedAt < 60_000) return
  indexedAt = now
  const out = `${claudeDir}/mods-logs/vault/qmd.log`
  await sh($, 'mkdir -p "$(dirname "$2")"; (QMD_EMBED_MODEL="$3" nice "$1" update && QMD_EMBED_MODEL="$3" nice "$1" embed) >> "$2" 2>&1 < /dev/null &', [qmd, out, EMBED]).catch(err => log($, `reindex: ${String(err)}`))
}

// ---- making the vault ----

async function obsidianVaults($: EngineInterface) {
  const found: string[] = []
  for (const p of [`${home}/.config/obsidian/obsidian.json`, `${home}/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json`, `${home}/snap/obsidian/current/.config/obsidian/obsidian.json`]) {
    try {
      if (!(await $.fs.exists(p))) continue
      const json = JSON.parse(String(await $.fs.read(p))) as { vaults?: Record<string, { path?: string }> }
      for (const v of Object.values(json.vaults ?? {})) if (v.path && !found.includes(v.path)) found.push(v.path)
    } catch {
      // A broken obsidian.json only means no suggestion.
    }
  }
  return found
}

async function syncNotes($: EngineInterface, path: string) {
  const notes: string[] = []
  if (await $.fs.exists(`${path}/.git`)) notes.push('é um repositório git: um push leva as notas (handoffs e pesquisas incluídos) para o remoto')
  if (/dropbox|nextcloud|onedrive|google ?drive|pcloud|syncthing|icloud/i.test(path)) notes.push('fica numa pasta sincronizada com a nuvem')
  if (await $.fs.exists(`${path}/.obsidian/plugins/obsidian-git`)) notes.push('tem o plugin Obsidian Git')
  return notes
}

// Copies the template files that are not in the vault yet; never overwrites one.
async function copyTemplate($: EngineInterface, model: Model) {
  const made: string[] = []
  for (const dir of [...(model === 'existing' ? [] : [model]), 'common']) {
    const from = `${root}/template/${dir}`
    const r = await sh($, 'cd "$1" && find . -type f', [from])
    for (const rel of r.stdout.split('\n').map(l => l.replace(/^\.\//, '')).filter(Boolean)) {
      const to = `${vault()}/${rel}`
      if (await $.fs.exists(to)) continue
      await $.process.run(['mkdir', '-p', to.slice(0, to.lastIndexOf('/'))])
      await $.fs.write(to, String(await $.fs.read(`${from}/${rel}`)))
      made.push(rel)
    }
  }
  for (const f of FOLDERS[model] ?? []) await $.process.run(['mkdir', '-p', `${vault()}/${f}`])
  return made
}

// ---- setting itself up ----

// The first chat with no vault set picks one (a vault Obsidian knows, else ~/Documents/Vault) and a
// model (para for an empty folder, existing for one with notes), then says so in the band.
async function autoSetup($: EngineInterface) {
  const lines: string[] = []
  if (!cfg.path) {
    const docs = (await $.fs.exists(`${home}/Documentos`)) && !(await $.fs.exists(`${home}/Documents`)) ? 'Documentos' : 'Documents'
    let path = `${home}/${docs}/Vault`
    for (const p of [...(await obsidianVaults($)), `${home}/Documents/Vault`, `${home}/Documentos/Vault`]) {
      if (await $.fs.exists(p)) {
        path = p
        break
      }
    }
    lines.push(await useVault($, path))
  }
  if (!cfg.model) {
    const list = await $.fs.list(vault()).catch(() => [])
    const notes = list.some(f => !f.name.startsWith('.') && f.name !== 'Claude')
    // An empty folder waits for the person's pick in the band; one with notes keeps its structure.
    if (notes) lines.push(await applyModel($, 'existing', false))
    else await $.state.set(CHOICE, true).catch(() => undefined)
  }
  // The "Próximo passo" hint is for /vault use typed by hand; here the model is already set.
  const text = lines.join('\n').split('\n').filter(l => !l.startsWith('Próximo passo')).join('\n')
  await $.state.set(BAND, text).catch(() => undefined)
  await log($, `auto setup: ${oneLine(text, 200)}`)
}

// ---- what the hook works out so Claude reads less ----

// Every file with its mtime, and every [[link]] in the notes, resolved as Obsidian does: by path, or
// by name anywhere in the vault. Dates are the files' mtimes, not the date property.
async function vaultMap($: EngineInterface) {
  const at = { timeoutMs: 15_000, cwd: vault() }
  const [found, links] = await Promise.all([
    $.process.run(['find', '.', '-path', './.obsidian', '-prune', '-o', '-path', './.trash', '-prune', '-o', '-path', '*/.git', '-prune', '-o', '-type', 'f', '-printf', '%T@\t%P\n'], at),
    $.process.run(['rg', '-o', '--no-heading', '--with-filename', '\\[\\[[^\\]|#^]+', ...RG_GLOBS, '.'], at),
  ])
  const files = new Map<string, number>()
  for (const l of found.stdout.split('\n')) {
    const [t, p] = l.split('\t')
    if (p) files.set(p, Number(t) * 1000)
  }
  const byName = new Map<string, string>()
  for (const p of files.keys()) byName.set(base(p).toLowerCase(), p)
  const resolve = (target: string) => {
    const t = target.trim().replace(/^\.?\//, '')
    const name = /\.[a-z0-9]+$/i.test(t) && !t.endsWith('.md') ? t : `${t.replace(/\.md$/, '')}.md`
    return files.has(name) ? name : byName.get(base(name).toLowerCase())
  }
  const out = new Map<string, Set<string>>()
  const into = new Map<string, Set<string>>()
  const broken: string[] = []
  for (const l of links.stdout.split('\n')) {
    const i = l.indexOf(':[[')
    if (i < 0) continue
    const from = l.slice(0, i).replace(/^\.\//, '')
    const target = l.slice(i + 3)
    const to = resolve(target)
    if (!to) broken.push(`${from} → [[${target.trim()}]]`)
    else if (to !== from) {
      ;(out.get(from) ?? out.set(from, new Set()).get(from)!).add(to)
      ;(into.get(to) ?? into.set(to, new Set()).get(to)!).add(from)
    }
  }
  return { files, out, into, broken: [...new Set(broken)] }
}

const DAY = 86_400_000
const isNote = (p: string) => p.endsWith('.md') && !/^(Daily|Templates|Reviews)\//.test(p) && p !== 'CLAUDE.md'
const list = (items: string[], max: number) => (items.length ? [...items.slice(0, max).map(i => `  - ${i}`), ...(items.length > max ? [`  - … e mais ${items.length - max}`] : [])] : ['  - nenhum'])

async function reviewFacts($: EngineInterface) {
  const now = await $.clock.now()
  const { files, out, into, broken } = await vaultMap($)
  const notes = [...files.keys()].filter(isNote)
  const recent = notes.filter(p => now - files.get(p)! < 7 * DAY && !p.startsWith('Claude/'))
  const claude = notes.filter(p => now - files.get(p)! < 7 * DAY && p.startsWith('Claude/'))
  const orphans = notes.filter(p => !out.get(p)?.size && !into.get(p)?.size && p !== 'Home.md')
  // A project is stale when neither its note nor any note linking to it changed in 30 days.
  const stale = notes
    .filter(p => /^Projects\/[^/]+\.md$/.test(p))
    .filter(p => [p, ...(into.get(p) ?? [])].every(q => now - (files.get(q) ?? 0) >= 30 * DAY))
  const inbox = notes.filter(p => p.startsWith('Inbox/'))
  return [
    'O hook já levantou isto (mtime dos arquivos; não precisa listar nem abrir o vault para achar):',
    `- Notas mudadas nos últimos 7 dias (${recent.length}):`,
    ...list(recent, 40),
    `- Notas que os mods gravaram em Claude/ nos últimos 7 dias: ${claude.length}`,
    `- Projetos sem nota nova há 30 dias ou mais (${stale.length}):`,
    ...list(stale, 20),
    `- Notas órfãs, sem link de nem para elas (${orphans.length}):`,
    ...list(orphans, 30),
    `- Links quebrados (${broken.length}):`,
    ...list(broken, 20),
    `- Inbox: ${inbox.length} notas`,
  ].join('\n')
}

async function inboxFacts($: EngineInterface) {
  const { files } = await vaultMap($)
  const inbox = [...files.keys()].filter(p => p.startsWith('Inbox/') && p.endsWith('.md'))
  const dirs = [...new Set([...files.keys()].map(p => p.split('/').slice(0, -1).slice(0, 2).join('/')).filter(d => d && !/^(Daily|Templates|Claude|Inbox)(\/|$)/.test(d)))].sort()
  return [
    'O hook já levantou isto:',
    `- Notas na Inbox (${inbox.length}):`,
    ...list(inbox, 50),
    '- Pastas do vault (2 níveis), para os destinos:',
    ...list(dirs, 60),
    'Abra só as notas da Inbox; para achar links, use a busca em vez de abrir outras notas.',
  ].join('\n')
}

// /vault ask: the hook searches first and hands Claude the hits, which saves Claude a search call.
async function askFacts($: EngineInterface, question: string) {
  const hits: string[] = []
  if (qmd && (qmdLive || (await qmdUp($)))) {
    const rows = await qmdQuery($, question, 5).catch(() => [] as QmdRow[])
    hits.push(...rows.map(r => `- ${rel(r.path)}${r.line ? `: ${r.line}` : ''}`))
  }
  if (!hits.length) {
    const terms = keywords(question)
    const words = terms.length ? await rgHits($, terms).catch(() => []) : []
    hits.push(...words.slice(0, 5).map(w => `- ${rel(w.path)} (${w.why})`))
  }
  return hits.length ? `A busca do hook já achou estas candidatas (a mais relevante primeiro); comece por elas e busque de novo só se não bastarem:\n${hits.join('\n')}` : 'A busca do hook não achou nenhuma nota parecida; busque você mesmo uma vez antes de concluir que o vault não tem.'
}


// ---- capture: Haiku keeps what an exchange decided or taught ----

// One Haiku call per answer, in the background: it reads the last exchange and writes one short note of
// one idea into Inbox/ when there is a decision, a cause found, a preference or a command worth keeping;
// otherwise nothing. /vault capture off stops it.
function capturePrompt(asked: string, answer: string) {
  return [
    'Você guarda o segundo cérebro (vault do Obsidian) de uma pessoa. Leia a troca abaixo entre ela e o Claude.',
    'Se houver algo que valha guardar para depois (uma decisão tomada, a causa de um problema, uma preferência da pessoa, um comando ou caminho útil, um aprendizado), escreva UMA nota de uma ideia só.',
    'Não suponha o gênero da pessoa: escreva "a pessoa" ou na forma impessoal ("decidiu-se", "a preferência é"), nunca "ele" ou "ela".',
    'Se for só conversa, pergunta simples, andamento de tarefa ou nada novo, não escreva nada.',
    'Responda só JSON: {"save": false} ou {"save": true, "title": "<título que diz a ideia, até 70 caracteres>", "body": "<2 a 6 linhas em Markdown, com as palavras da pessoa e o porquê>", "tags": ["<1 a 3 tags curtas>"]}.',
    '',
    `<pedido>\n${asked.slice(0, 4000)}\n</pedido>`,
    `<resposta>\n${answer.slice(0, 8000)}\n</resposta>`,
  ].join('\n')
}

async function capture($: EngineInterface, asked: string, answer: string) {
  if (off || !vault() || cfg.capture === false || !asked.trim() || !answer.trim()) return
  const resolved = await $.mods.modelResolve({ role: 'light', fallback: CAPTURE_MODEL })
  const r = await $.model.complete({ model: resolved.model, prompt: capturePrompt(asked, answer), maxTokens: 400, effort: resolved.effort ?? 'low', timeoutMs: 30_000 })
  if (r.usage) void $.mods.spent({ mod: NAME, model: resolved.model, usage: r.usage }).catch(() => undefined)
  if (!r.isAnswered) return
  const json = r.text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return
  const n = JSON.parse(json) as { save?: boolean; title?: string; body?: string; tags?: unknown }
  const title = trim(n.title)
  if (!n.save || !title || !trim(n.body)) return
  const now = await $.clock.now()
  const project = projectOf(cwd)
  const tags = ['claude', 'captured', ...(Array.isArray(n.tags) ? n.tags.map(t => String(t).replace(/[^\p{L}\p{N}_-]+/gu, '-').toLowerCase()).filter(Boolean).slice(0, 3) : [])]
  const name = safeName(title).slice(0, 90)
  const note = ['---', 'type: note', `date: ${ymd(now)}`, ...(project ? [`project: "[[${safeName(project)}]]"`] : []), `tags: [${[...new Set(tags)].join(', ')}]`, 'source: "capturada pelo Haiku no fim de uma resposta"', '---', '', `# ${title}`, '', trim(n.body), ''].join('\n')
  if (!(await createNew($, `${vault()}/Inbox/${name}.md`, note))) return
  if (project) await ensureProject($, project, cwd)
  await daily($, now, `[[${name}]] (capturada${project ? `, [[${safeName(project)}]]` : ''})`)
  await log($, `captured: Inbox/${name}.md`)
}

// ---- the weekly review offer ----

// Seven days after the last review (or after the vault was first seen), the band offers one; the person
// clicks it. "Depois" hides it in this chat only.
async function reviewDue($: EngineInterface) {
  const now = await $.clock.now()
  const last = await $.store.get('reviewedAt').catch(() => undefined)
  if (typeof last !== 'number') {
    await $.store.set('reviewedAt', now).catch(() => undefined)
    return false
  }
  return now - last >= WEEK
}

// ---- the prompts /vault hands Claude ----

function promptFor(sub: string, arg: string, facts = '') {
  const v = vault()
  // The vault being studied has no CLAUDE.md to follow yet.
  const rules = `O vault fica em \`${v}\`${sub === 'existing' ? '' : `; siga \`${v}/CLAUDE.md\``}. Busca: ${searchCmd()} Nunca apague notas.${facts ? `\n\n${facts}` : ''}`
  switch (sub) {
    case 'save':
      return `${rules}\n\nGuarde no vault uma nota sobre: ${arg || 'o ponto mais importante deste chat até aqui (decisão, aprendizado ou ideia)'}.\n- Antes, busque no vault: se já houver nota com essa ideia, atualize-a em vez de criar outra.\n- Nota nova vai em \`Inbox/\`, uma ideia só, título que diz a ideia, frontmatter (type: note, date de hoje, tags, project se este chat tiver projeto) e [[links]] para as notas relacionadas que a busca achou.\n- Escreva com as minhas palavras e as decisões deste chat; não invente.\n- No fim, diga o caminho da nota.`
    case 'ask':
      return `${rules}\n\nResponda usando o meu vault: ${arg}\n- Leia só as notas que importam, e só o trecho que importa quando a nota for longa.\n- Cite cada nota usada como [[nome]].\n- Se o vault não tiver a resposta, diga isso claramente antes de responder com o que você sabe.`
    case 'inbox':
      return `${rules}\n\nProcesse a \`Inbox/\` do vault. Para cada nota: proponha o destino (pasta, conforme o CLAUDE.md), um título melhor se precisar, tags e [[links]] para notas existentes. Mostre tudo numa lista e espere o meu ok antes de mover ou mudar qualquer coisa. Nada é apagado.`
    case 'review':
      return `${rules}\n\nFaça a revisão semanal do vault com o levantamento acima: o que entrou, projetos parados, órfãs (sugira 1 ou 2 links para cada uma, pelo nome; abra só as que não der para julgar pelo nome), links quebrados e a Inbox. Escreva o resultado em \`Reviews/<ano>-W<semana>.md\` com [[links]] e me mostre um resumo curto. Não mova nem apague nada sem o meu ok.`
    case 'existing':
      return `${rules}\n\nEste vault já existia. Estude-o: a árvore de pastas (2 níveis), 2 ou 3 notas de exemplo de cada pasta principal, o frontmatter e os templates que ele usa. Depois escreva \`${v}/CLAUDE.md\` com as convenções dele: o que vai em cada pasta, como as notas são nomeadas, o frontmatter, como as notas se ligam, e que \`Claude/\` é escrito pelos mods. Se \`${v}/CLAUDE.md\` já existir, mostre o que mudaria e espere o meu ok. Não mexa em nenhuma outra nota.`
  }
  return ''
}

// ---- /vault ----

// A prompt submitted inside command.run would wait on the turn that hook holds: a timer sends it after.
const later = ($: EngineInterface, text: string) => $.clock.after(0, () => void $.prompt.submit({ text }).catch(err => log($, `submit: ${String(err)}`)))

async function status($: EngineInterface) {
  const lines: string[] = []
  if (!vault()) {
    lines.push('Nenhum vault escolhido.')
    const found = await obsidianVaults($)
    if (found.length) lines.push('', 'Vaults que o Obsidian conhece:', ...found.map(p => `- ${tilde(p)}  →  /vault use ${tilde(p)}`))
    lines.push('', 'Para um vault novo: /vault use ~/Documentos/Vault e depois /vault setup para (ou zettel).')
  } else {
    lines.push(`Vault: ${tilde(vault())} (modelo: ${cfg.model ?? 'nenhum ainda, use /vault setup para|zettel|existing'})`)
    const up = qmd ? await qmdUp($) : false
    lines.push(`Busca: ${qmd ? `qmd (${tilde(qmd)}), vetores multilíngues e reranker; daemon ${up ? `rodando em ${QMD_URL} (~1 GB de RAM com os modelos carregados; descarrega após 5 min parado)` : 'parado: as dicas usam só o ripgrep até o próximo chat ou /vault index'}` : 'ripgrep, só palavras. Para busca por significado: instale o mod Local Models (/local-models install)'}`)
    const st = await stats($)
    if (st.hints) lines.push(`Dicas: ${st.hints} notas sugeridas, ${st.read} abertas pelo Claude desde ${ymd(st.since)}. Abrir pouco não quer dizer ruído: a linha da dica pode já ter respondido.`)
    if (qmd && qmdVersion && !rerankOk()) lines.push(`Atenção: qmd ${qmdVersion} não é 2.x; o filtro do reranker foi feito para o 2.x, então as dicas usam só o ripgrep.`)
    const sc = await scores($)
    const sorted = [...sc].sort((a, b) => a - b)
    if (qmd)
      lines.push(
      `Corte do reranker: ${cut().toFixed(2)}${cfg.cut === undefined ? ' (padrão)' : ''}.${sc.length ? ` Últimas ${sc.length} dicas por significado: scores ${sorted[0]!.toFixed(2)} a ${sorted.at(-1)!.toFixed(2)}, mediana ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)}.` : ''} Para calibrar: veja no log (${tilde(`${claudeDir}/mods-logs/vault/vault.log`)}) as linhas "hint:" de notas sem relação com o prompt e suba o corte acima dos scores "qmd 0.xx" delas: /vault corte 0.5.`,
    )
    const prev = await $.store.get('mirrored').catch(() => undefined)
    lines.push(`Copiadas para Claude/: ${Array.isArray(prev) ? prev.length : 0} notas (handoffs, pesquisas${cfg.reads ? ', leituras' : ''})`)
    lines.push(`Leituras do Input Router: ${cfg.reads ? 'copiadas' : 'não copiadas (/vault reads on)'} · Nota diária: ${cfg.daily === false ? 'desligada (/vault daily on)' : 'ligada'}`)
    lines.push(`Captura pelo Haiku: ${cfg.capture === false ? 'desligada (/vault capture on)' : 'ligada: no fim de cada resposta, o que valer guardar vira uma nota na Inbox/ (/vault capture off)'}`)
    const sync = await syncNotes($, vault())
    if (sync.length) lines.push(`Atenção: o vault ${sync.join('; ')}.`)
  }
  lines.push(
    '',
    'Comandos: /vault save [assunto] · /vault ask <pergunta> · /vault inbox · /vault review · /vault index · /vault use <pasta> · /vault setup para|zettel|existing · /vault reads on|off · /vault daily on|off · /vault capture on|off · /vault corte <0 a 1>',
  )
  return lines.join('\n')
}

async function useVault($: EngineInterface, path: string) {
  await $.process.run(['mkdir', '-p', `${path}/Claude`])
  await saveConfig($, { ...cfg, path })
  let idx = ''
  try {
    idx = qmd ? `Índice do qmd: coleção "${COLLECTION}" ${await ensureCollection($)}; indexando em segundo plano.` : ''
    void reindex($)
    void startDaemon($).catch(err => log($, `qmd daemon: ${String(err)}`))
  } catch (err) {
    idx = `O qmd não aceitou a coleção: ${String(err)}`
  }
  const sync = await syncNotes($, path)
  const copied = await mirror($)
  return [
    `Vault: ${tilde(path)}.`,
    copied ? `${copied} notas dos mods copiadas para Claude/.` : '',
    idx,
    sync.length ? `Atenção: este vault ${sync.join('; ')}.` : 'Se você sincronizar este vault (Obsidian Sync, git, nuvem), as notas que os mods gravam saem desta máquina.',
    cfg.model ? '' : 'Próximo passo: /vault setup para (PARA), /vault setup zettel (Zettelkasten) ou /vault setup existing (manter a estrutura que já existe).',
  ]
    .filter(Boolean)
    .join('\n')
}

async function applyModel($: EngineInterface, model: Model, study: boolean) {
  const made = await copyTemplate($, model)
  await saveConfig($, { ...cfg, model })
  if (model === 'existing' && study) later($, promptFor('existing', ''))
  void reindex($)
  return [
    `Modelo ${model} no vault ${tilde(vault())}.`,
    made.length ? `Criados: ${made.join(', ')}.` : 'Nenhum arquivo novo: os que já existiam ficaram como estavam.',
    model !== 'existing' ? 'As convenções estão em CLAUDE.md, na raiz do vault: edite à vontade.' : study ? 'Pedi ao Claude para estudar o vault e escrever o CLAUDE.md dele.' : 'Estrutura mantida. Para o Claude estudar o vault e escrever o CLAUDE.md dele: /vault setup existing.',
  ].join('\n')
}

async function run($: EngineInterface, args: string): Promise<{ text: string; context?: string[] }> {
  const sub = trim(args).split(/\s+/)[0] ?? ''
  const arg = trim(trim(args).slice(sub.length))
  if (!sub || sub === 'status' || sub === 'help') {
    // /vault in a chat that began before the mod was installed or set up (after /reload-plugins): it does
    // what a new chat would, so the band shows the setup buttons without one.
    if (!home) await setup($)
    if (!off) {
      if (!cfg.path || !cfg.model) await autoSetup($).catch(err => log($, `auto setup: ${String(err)}`))
      if (!qmd) qmd = await findQmd($)
    }
    // Plain /vault opens the side pane, which holds the long status; /vault status still prints it.
    if (!sub && !off) {
      await $.ui.open({ id: PANE, title: 'Vault' }).catch(err => log($, `pane: ${String(err)}`))
      return { text: `Vault: ${vault() ? `${tilde(vault())} (modelo: ${cfg.model ?? 'nenhum ainda'})` : 'nenhum escolhido'}. O painel do vault está aberto ao lado; /vault status mostra tudo aqui.` }
    }
    return { text: await status($) }
  }

  if (sub === 'use') {
    if (!arg) return { text: 'Diga a pasta: /vault use ~/Documentos/Vault' }
    const path = expand(arg)
    if (!path.startsWith('/')) return { text: `Use um caminho completo (começando com / ou ~): ${arg}` }
    return { text: await useVault($, path), context: [`O vault de notas da pessoa agora fica em \`${path}\`.`] }
  }

  if (!vault()) return { text: await status($) }

  if (sub === 'setup') {
    const model = arg as Model
    if (!FOLDERS[model]) return { text: 'Escolha o modelo: /vault setup para · /vault setup zettel · /vault setup existing' }
    return { text: await applyModel($, model, true) }
  }

  if (sub === 'capture') {
    if (arg !== 'on' && arg !== 'off') return { text: '/vault capture on ou /vault capture off' }
    await saveConfig($, { ...cfg, capture: arg === 'on' })
    return { text: `Captura pelo Haiku: ${arg === 'on' ? 'ligada' : 'desligada'}.` }
  }

  if (sub === 'reads' || sub === 'daily') {
    const on = arg === 'on'
    if (arg !== 'on' && arg !== 'off') return { text: `/vault ${sub} on ou /vault ${sub} off` }
    await saveConfig($, { ...cfg, [sub]: on })
    const copied = sub === 'reads' && on ? await mirror($) : 0
    return { text: `${sub === 'reads' ? 'Leituras do Input Router' : 'Nota diária'}: ${on ? 'ligada' : 'desligada'}.${copied ? ` ${copied} notas copiadas.` : ''}${sub === 'reads' && on ? ' Elas resumem arquivos que você abriu: se o vault sincroniza, esses resumos vão junto.' : ''}` }
  }

  if (sub === 'corte') {
    const n = Number(arg.replace(',', '.'))
    if (!arg || !Number.isFinite(n) || n < 0 || n > 1) return { text: `/vault corte <número de 0 a 1>, por exemplo /vault corte 0.5. Hoje: ${cut().toFixed(2)}${cfg.cut === undefined ? ' (padrão)' : ''}. /vault mostra os scores das últimas dicas.` }
    await saveConfig($, { ...cfg, cut: n })
    return { text: `Corte do reranker: ${n.toFixed(2)}. Dicas por significado abaixo disso não aparecem mais.` }
  }

  if (sub === 'index') {
    qmd = await findQmd($)
    if (qmd) await readVersion($)
    const copied = await mirror($)
    if (!qmd) return { text: `${copied} notas copiadas. Sem qmd, a busca usa ripgrep. Para busca por significado: /local-models install (o aviso laranja instala o qmd), depois /vault index de novo.` }
    let col = ''
    try {
      col = await ensureCollection($)
    } catch (err) {
      return { text: `O qmd não aceitou a coleção: ${String(err)}` }
    }
    indexedAt = 0
    await reindex($)
    void startDaemon($).catch(err => log($, `qmd daemon: ${String(err)}`))
    return { text: `${copied} notas copiadas. Coleção "${COLLECTION}" ${col}; o qmd está indexando em segundo plano (log: ${tilde(`${claudeDir}/mods-logs/vault/qmd.log`)}) e sobe o daemon de busca em ${QMD_URL}. Na primeira vez ele baixa os modelos (~2 GB).` }
  }

  if (!promptFor(sub, arg)) return { text: `Não conheço /vault ${sub}.\n\n${await status($)}` }
  if (sub === 'ask' && !arg) return { text: 'Diga a pergunta: /vault ask o que decidi sobre o cache?' }
  // A survey that fails leaves Claude to look for itself.
  const facts = await (sub === 'ask' ? askFacts($, arg) : sub === 'review' ? reviewFacts($) : sub === 'inbox' ? inboxFacts($) : Promise.resolve('')).catch(async err => (await log($, `${sub} facts: ${String(err)}`), ''))
  if (sub === 'review') {
    await $.store.set('reviewedAt', await $.clock.now()).catch(() => undefined)
    await $.state.set(REVIEW, null).catch(() => undefined)
  }
  later($, promptFor(sub, arg, facts))
  return { text: `Pedi ao Claude: /vault ${sub}${arg ? ` ${oneLine(arg, 60)}` : ''}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    hinted.clear()
    opened.clear()
    logged = false
    await setup($)
    if (!off) {
      await $.command.register({ name: 'vault', description: 'Segundo cérebro no Obsidian: guardar, perguntar, organizar e revisar notas', argumentHint: 'save|ask|inbox|review|use|setup|index' }).catch(() => undefined)
      if (!cfg.path || !cfg.model) await autoSetup($).catch(err => log($, `auto setup: ${String(err)}`))
      // Frozen for the chat: a change mid-chat would rewrite the prompt cache.
      section = vault() ? systemSection() : ''
      if (vault() && cfg.model && (await reviewDue($))) await $.state.set(REVIEW, true).catch(() => undefined)
      void mirror($).catch(err => log($, `mirror: ${String(err)}`))
      // Notes written in Obsidian since the last chat; qmd update only reads what changed.
      void reindex($)
      void (async () => (qmd && (await readVersion($)), await ensureCollection($), await startDaemon($)))().catch(err => log($, `qmd: ${String(err)}`))
    } else void stopDaemon($).catch(err => log($, `qmd stop: ${String(err)}`))
    return next(e)
  })

  // A hinted note Claude opens counts toward the hints' precision.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (!off && hinted.has(e.file_path) && !opened.has(e.file_path)) {
      opened.add(e.file_path)
      await count($, 'read', 1)
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (off || !section) return r
    return { ...r, sections: [...r.sections, { id: `${NAME}:vault`, text: section, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (off || !vault() || e.command || e.isMeta || e.origin?.kind === 'plugin' || e.origin?.kind === 'task-notification') return next(e)
    const typed = e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim()
    if (!typed) return next(e)
    lastTyped = typed
    if (!logged) {
      logged = true
      const project = projectOf(cwd)
      try {
        if (project) await ensureProject($, project, cwd)
        await daily($, await $.clock.now(), `chat${project ? ` em [[${safeName(project)}]]` : ''}: ${oneLine(typed, 100)}`)
      } catch (err) {
        await log($, `daily: ${String(err)}`)
      }
    }
    // Fail open: a search that breaks leaves the prompt as typed.
    const hits = await recall($, typed).catch(() => [] as Hit[])
    await $.state
      .set(SEARCH, lastSearch ? `Vault · qmd buscou em ${lastSearch.ms} ms · ${hits.length ? `${hits.length} ${hits.length === 1 ? 'nota sugerida' : 'notas sugeridas'} (${hits.map(h => h.why.replace(/^termos: .*/, 'palavras')).join(', ')})` : 'nenhuma nota relevante'}` : null)
      .catch(() => undefined)
    if (!hits.length) return next(e)
    const prev = (await $.state.get(RECENT).catch(() => ({ value: null }))).value
    await $.state
      .set(RECENT, [...(Array.isArray(prev) ? prev : []), { at: await $.clock.now(), hits: hits.map(h => `${rel(h.path)} (${h.why})`) }].slice(-10))
      .catch(() => undefined)
    for (const h of hits) hinted.add(h.path)
    await count($, 'hints', hits.length)
    await keepScores($, hits.flatMap(h => (h.score === undefined ? [] : [h.score])))
    await log($, `hint: ${hits.map(h => `${tilde(h.path)} (${h.why})`).join(', ')}`)
    return next({ ...e, context: [...(e.context ?? []), hintText(hits)] })
  })

  // Handoffs and research briefs land during a turn; copy them when it ends.
  on('turn.complete', async ($, e, next) => {
    if (!off && !e.agentId) await mirror($).catch(err => log($, `mirror: ${String(err)}`))
    if (!off && !e.agentId && !e.isAborted && lastTyped) {
      const asked = lastTyped
      lastTyped = ''
      void capture($, asked, e.answer ?? '').catch(err => log($, `capture: ${String(err)}`))
    }
    return next(e)
  })

  on('command.run', { command: 'vault' }, async ($, e) => run($, e.args ?? ''))

  // The band from autoSetup: what the mod set up by itself, until the person closes it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || e.props.hasSurvey) return next(e)
    const { value } = await $.state.get(BAND)
    const band = typeof value === 'string' && value ? value : ''
    const search = (await $.state.get(SEARCH)).value
    const review = (await $.state.get(REVIEW)).value === true
    if (!band && !search && !review) return next(e)
    const choose = (await $.state.get(CHOICE)).value === true
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // One dim line: only the dot is purple, so it stays quieter than the setup band.
    const line = search ? (
      <Text dimColor wrap="truncate-end">
        <Text color={PURPLE}>●</Text> {search}
      </Text>
    ) : null
    const offer = review ? (
      <Box flexDirection="column">
        <Text>
          <Text color={PURPLE}>●</Text>
          <Text bold> Revisão semanal do vault: </Text>
          <Text>o que entrou, projetos parados, notas soltas e a Inbox, num relatório em Reviews/. Nada é movido sem o seu ok.</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="review-now" label="Revisar agora" variant="primary" onPress={() => undefined} />
          <Button key="review-later" label="Depois" role="dismiss" onPress={() => undefined} />
        </Box>
      </Box>
    ) : null
    if (!band)
      return (
        <Box flexDirection="column">
          {rest}
          {offer}
          {line}
        </Box>
      )
    const [head, ...more] = band.split('\n')
    return (
      <Box flexDirection="column">
        {rest}
        {offer}
        {line}
        <Box flexDirection="column">
          <Text>
            <Text color={PURPLE}>●</Text>
            <Text bold> Vault configurado sozinho · </Text>
            <Text color={PURPLE}>{head}</Text>
          </Text>
          {more.map((l, i) => (
            <Text key={`l${i}`} dimColor>
              {l}
            </Text>
          ))}
          <Text dimColor>Para trocar: /vault use &lt;pasta&gt; · /vault setup para|zettel|existing</Text>
          {choose ? <Text>Escolha o modelo: PARA organiza por projetos e áreas; Zettel liga ideias por links.</Text> : null}
          <Box flexDirection="row" gap={1}>
            {choose ? <Button key="para" label="PARA" variant="primary" onPress={() => undefined} /> : null}
            {choose ? <Button key="zettel" label="Zettelkasten" variant="secondary" onPress={() => undefined} /> : null}
            {choose ? null : <Button key="ok" label="Entendi" role="dismiss" onPress={() => undefined} />}
          </Box>
        </Box>
      </Box>
    )
  })

  for (const model of ['para', 'zettel'] as const)
    on('ui.press', { plugin: 'vault', element: model }, async ($, e) => {
      await $.state.set(CHOICE, null)
      await $.state.set(BAND, await applyModel($, model, false))
      return { element: e.element }
    })

  // The side pane: the status in short sections, a button per command, and the last hints.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (off) return <Text dimColor>O Vault está desligado. Ligue em /mods.</Text>
    await $.state.get(TICK)
    const width = Math.max(32, e.props.bodyColumns)
    const noop = () => undefined
    if (!vault()) return <Text dimColor wrap="wrap">Nenhum vault escolhido. Digite /vault use ~/Documentos/Vault, ou abra um chat novo para ele se configurar sozinho.</Text>
    const st = await stats($)
    const prev = await $.store.get('mirrored').catch(() => undefined)
    const tiles = [
      { label: 'Modelo', value: cfg.model ?? 'nenhum' },
      { label: 'Copiadas', value: String(Array.isArray(prev) ? prev.length : 0) },
      { label: 'Dicas', value: `${st.read}/${st.hints} abertas` },
    ]
    const tileW = Math.floor((width - (tiles.length - 1)) / tiles.length)
    // The status lines, minus the command list the buttons below replace.
    const lines = (await status($)).split('\n').filter(l => l && !l.startsWith('Comandos:'))
    const recent = (await $.state.get(RECENT)).value
    const button = (key: string, label: string) => <Button key={key} label={label} onPress={noop} />
    return (
      <Box flexDirection="column" width={width}>
        <Box key="title" flexDirection="column" marginBottom={1}>
          <Text bold>
            <Text color={PURPLE}>●</Text> Vault
          </Text>
          <Text dimColor wrap="wrap">Segundo cérebro no Obsidian: notas em Markdown, buscadas a cada prompt sem gastar tokens.</Text>
        </Box>
        <Box key="tiles" flexDirection="row" gap={1} width={width} marginBottom={1}>
          {tiles.map(t => (
            <Box key={`t-${t.label}`} flexDirection="column" borderStyle="round" paddingX={1} width={tileW}>
              <Text dimColor wrap="truncate-end">{t.label}</Text>
              <Text bold color={PURPLE} wrap="truncate-end">{t.value}</Text>
            </Box>
          ))}
        </Box>
        <Box key="do" flexDirection="column" marginBottom={1}>
          <Text bold>Pedir ao Claude</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {button('do:save', 'Guardar o chat')}
            {button('do:inbox', 'Processar a Inbox')}
            {button('do:review', 'Revisão semanal')}
          </Box>
          <Text dimColor wrap="wrap">Para perguntar ao vault: /vault ask &lt;pergunta&gt;</Text>
        </Box>
        <Box key="set" flexDirection="column" marginBottom={1}>
          <Text bold>Ajustes</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {button('do:index', 'Reindexar')}
            {button(`do:reads ${cfg.reads ? 'off' : 'on'}`, cfg.reads ? '☑ Leituras' : '☐ Leituras')}
            {button(`do:daily ${cfg.daily === false ? 'on' : 'off'}`, cfg.daily === false ? '☐ Nota diária' : '☑ Nota diária')}
            {button(`do:capture ${cfg.capture === false ? 'on' : 'off'}`, cfg.capture === false ? '☐ Captura pelo Haiku' : '☑ Captura pelo Haiku')}
          </Box>
        </Box>
        <Box key="status" flexDirection="column" marginBottom={1}>
          <Text bold>Estado</Text>
          {lines.map((l, i) => (
            <Text key={`s${i}`} dimColor wrap="wrap">
              {l}
            </Text>
          ))}
        </Box>
        <Box key="recent" flexDirection="column">
          <Text bold>Últimas dicas</Text>
          {Array.isArray(recent) && recent.length ? (
            [...recent].reverse().map((r, i) => (
              <Box key={`r${i}`} flexDirection="column">
                {r.hits.map((hit, j) => (
                  <Text key={`r${i}-${j}`} dimColor wrap="truncate-end">
                    {`${j === 0 ? '•' : ' '} ${hit}`}
                  </Text>
                ))}
              </Box>
            ))
          ) : (
            <Text dimColor>Nenhuma ainda neste chat.</Text>
          )}
        </Box>
      </Box>
    )
  })

  // A pane button runs the same /vault subcommand, then redraws the pane.
  on('ui.press', { plugin: 'vault' }, async ($, e, next) => {
    if (!e.element.startsWith('do:')) return next(e)
    const r = await run($, e.element.slice(3)).catch(err => ({ text: String(err) }))
    await log($, `pane ${e.element}: ${oneLine(r.text, 120)}`)
    const t = (await $.state.get(TICK)).value
    await $.state.set(TICK, (typeof t === 'number' ? t : 0) + 1)
    return { element: e.element }
  })

  on('ui.press', { plugin: 'vault', element: 'review-now' }, async ($, e) => {
    await run($, 'review').catch(err => log($, `review: ${String(err)}`))
    return { element: e.element }
  })

  on('ui.press', { plugin: 'vault', element: 'review-later' }, async ($, e) => {
    await $.state.set(REVIEW, null)
    return { element: e.element }
  })

  on('ui.press', { plugin: 'vault', element: 'ok' }, async ($, e) => {
    await $.state.set(BAND, null)
    return { element: e.element }
  })
}
