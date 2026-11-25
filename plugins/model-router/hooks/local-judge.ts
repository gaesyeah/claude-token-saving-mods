// Local judge: answers like the paid judge did for prompts much like this one, through the qmd daemon
// the Local Models mod keeps running (localhost:8181). No Claude call, no tokens.
//
// Every paid answer is kept as an example: one Markdown file `<label>--<hash>.md` holding the prompt,
// in its own qmd collection, outside the vault. A new prompt asks the daemon for its 3 nearest examples,
// reranked; when the nearest is very close and the close ones agree, their label is the answer.
// Every SAMPLE_EVERY-th local answer is also asked of the paid judge, in the background, and the two are
// compared; if the last samples agree too little, local answers stop until the person resets them.
//
// The same file sits in effort-optimizer and model-router (each mod is installed on its own).
import type { EngineInterface } from 'claude-code'

const QMD_URL = 'http://localhost:8181'
// The vault's embedding model: every collection in the qmd index must be embedded with the same one.
const EMBED = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf'
// Fewer examples than this and the nearest ones are not near enough to trust.
const MIN_EXAMPLES = 30
// The reranker's 0..1 relevance. A near-copy of an old prompt scores 0.8 or more.
const NEAR = 0.8
const CLOSE = 0.5
export const SAMPLE_EVERY = 5
// Below this share of agreement in the last WINDOW samples, local answers stop.
const MIN_AGREE = 0.8
const WINDOW = 20

export type Guess = { label: string; file: string; n: number; score: number }
type Stats = { local: number; sampled: number; agreed: number; recent: boolean[]; stopped: boolean }

// qmd 2.x blends rank and reranker: for vector rank k (1-3) the score is 0.75/k + 0.25 × rerank.
// shortcut: those are qmd 2.x's weights (the vault mod reads them the same way); re-read them if qmd changes.
const rerankOf = (s: number) => (s >= 0.75 ? (s - 0.75) / 0.25 : s >= 0.375 ? (s - 0.375) / 0.25 : (s - 0.25) / 0.25)

// djb2: a stable name for an example, so the same prompt is kept once.
function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

async function within<T>($: EngineInterface, p: Promise<T>, ms: number): Promise<T> {
  const box: { timer?: { cancel: () => void } } = {}
  const late = new Promise<never>((_, reject) => {
    box.timer = $.clock.after(ms, () => reject(new Error(`no answer in ${ms} ms`)))
  })
  try {
    return await Promise.race([p, late])
  } finally {
    box.timer?.cancel()
  }
}

export type Judge = { collection: string; dir: string; labels: readonly string[] }

let qmd: string | null = null
const ready = new Set<string>()
const embeddedAt = new Map<string, number>()
const counts = new Map<string, number>()

function sh($: EngineInterface, script: string, args: string[]) {
  return $.process.run(['/bin/sh', '-c', script, 'sh', ...args], { timeoutMs: 15_000 })
}

// The desktop app's PATH can miss the folders npm, Volta and bun install into.
async function findQmd($: EngineInterface) {
  if (qmd !== null) return qmd
  const r = await sh(
    $,
    'command -v qmd && exit 0; for p in "$HOME/.volta/bin/qmd" "$HOME/.bun/bin/qmd" "$HOME/.npm-global/bin/qmd" "$HOME/.local/bin/qmd" "/usr/local/bin/qmd"; do [ -x "$p" ] && echo "$p" && exit 0; done; exit 1',
    [],
  ).catch(() => undefined)
  qmd = r && r.exitCode === 0 ? (r.stdout.split('\n')[0] ?? '').trim() : ''
  return qmd
}

async function qmdUp($: EngineInterface) {
  const r = await within($, $.http.fetch(`${QMD_URL}/health`), 1000).catch(() => undefined)
  try {
    const b = r?.ok ? (JSON.parse(r.text) as { status?: unknown; uptime?: unknown }) : {}
    return b.status === 'ok' && typeof b.uptime === 'number'
  } catch {
    return false
  }
}

async function examples($: EngineInterface, j: Judge) {
  if (!counts.has(j.dir)) counts.set(j.dir, (await $.fs.list(j.dir).catch(() => [])).filter(f => f.name.endsWith('.md')).length)
  return counts.get(j.dir)!
}

export async function judgeStats($: EngineInterface): Promise<Stats> {
  const s = (await $.store.get('localJudge').catch(() => undefined)) as Partial<Stats> | undefined
  return { local: s?.local ?? 0, sampled: s?.sampled ?? 0, agreed: s?.agreed ?? 0, recent: Array.isArray(s?.recent) ? s.recent : [], stopped: s?.stopped === true }
}

// The nearest examples' label, or null when they are too few, too far, disagree, or qmd is not up.
export async function judgeGuess($: EngineInterface, j: Judge, text: string): Promise<Guess | null> {
  if ((await judgeStats($)).stopped || (await examples($, j)) < MIN_EXAMPLES || !(await findQmd($)) || !(await qmdUp($))) return null
  const body = JSON.stringify({ searches: [{ type: 'vec', query: text.replace(/\s+/g, ' ').slice(0, 500) }], collections: [j.collection], limit: 3, rerank: true, candidateLimit: 3 })
  const res = await within($, $.http.fetch(`${QMD_URL}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 2500)
  if (!res.ok) throw new Error(`qmd HTTP ${res.status}`)
  const rows = ((JSON.parse(res.text) as { results?: { file?: unknown; score?: unknown }[] }).results ?? []).slice(0, 3).map(r => {
    const name = decodeURIComponent(String(r.file ?? '')).split('/').pop() ?? ''
    return { name, label: name.split('--')[0] ?? '', score: Math.max(0, rerankOf(typeof r.score === 'number' ? r.score : 0)) }
  })
  const close = rows.filter(r => r.score >= CLOSE)
  const top = rows[0]
  if (!top || top.score < NEAR || !j.labels.includes(top.label) || close.length < 2 || close.some(r => r.label !== top.label)) return null
  return { label: top.label, file: `${j.dir}/${top.name}`, n: close.length, score: top.score }
}

// Keeps a paid answer as an example, then refreshes the index in the background (once a minute at most).
export async function judgeRemember($: EngineInterface, j: Judge, text: string, label: string, extra?: string) {
  if (!j.labels.includes(label) || !(await findQmd($))) return
  const name = hash(text)
  await $.process.run(['mkdir', '-p', j.dir])
  for (const l of j.labels) if (l !== label) await $.process.run(['rm', '-f', `${j.dir}/${l}--${name}.md`])
  await $.fs.write(`${j.dir}/${label}--${name}.md`, `${text.slice(0, 2000)}\n`)
  if (extra !== undefined) await $.fs.write(`${j.dir}/${name}.json`, extra)
  counts.delete(j.dir)
  const env = { QMD_EMBED_MODEL: EMBED }
  if (!ready.has(j.collection)) {
    const list = await $.process.run([qmd!, 'collection', 'list'], { timeoutMs: 15_000, env }).catch(() => undefined)
    if (!list || !new RegExp(`\\b${j.collection}\\b`).test(list.stdout)) await $.process.run([qmd!, 'collection', 'add', j.dir, '--name', j.collection, '--mask', '**/*.md'], { timeoutMs: 60_000, env })
    ready.add(j.collection)
  }
  const now = await $.clock.now()
  if (now - (embeddedAt.get(j.collection) ?? 0) < 60_000) return
  embeddedAt.set(j.collection, now)
  await sh($, '(QMD_EMBED_MODEL="$2" nice "$1" update && QMD_EMBED_MODEL="$2" nice "$1" embed) > /dev/null 2>&1 < /dev/null &', [qmd!, EMBED])
}

// Counts a local answer; true when this one should also go to the paid judge.
export async function judgeUsed($: EngineInterface) {
  const s = await judgeStats($)
  await $.store.set('localJudge', { ...s, local: s.local + 1 }).catch(() => undefined)
  return (s.local + 1) % SAMPLE_EVERY === 0
}

// A sample's outcome. Too little agreement in the last WINDOW samples stops local answers.
export async function judgeSampled($: EngineInterface, agreed: boolean) {
  const s = await judgeStats($)
  const recent = [...s.recent, agreed].slice(-WINDOW)
  const stopped = s.stopped || (recent.length >= 5 && recent.filter(Boolean).length / recent.length < MIN_AGREE)
  await $.store.set('localJudge', { ...s, sampled: s.sampled + 1, agreed: s.agreed + (agreed ? 1 : 0), recent, stopped }).catch(() => undefined)
  return stopped
}

export async function judgeReset($: EngineInterface) {
  const s = await judgeStats($)
  await $.store.set('localJudge', { ...s, recent: [], stopped: false })
}

// One line for the mod's status: how often it answered locally and how the samples went.
export async function judgeLine($: EngineInterface, j: Judge, paid: string) {
  const s = await judgeStats($)
  const n = await examples($, j)
  const recent = s.recent.length ? `${s.recent.filter(Boolean).length}/${s.recent.length}` : 'none yet'
  if (s.stopped) return `Local judge: stopped, the last samples agreed with ${paid} only ${recent}. Type reset-local to try again.`
  if (n < MIN_EXAMPLES) return `Local judge: learning, ${n}/${MIN_EXAMPLES} examples from ${paid}'s answers (needs qmd: the Local Models mod installs it).`
  return `Local judge: ${s.local} answers without ${paid}; 1 in ${SAMPLE_EVERY} also asked ${paid}: agreed ${s.agreed}/${s.sampled} (last ${WINDOW}: ${recent}).`
}
