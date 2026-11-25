// qmd's pure rules, shared by the vault's search and the local judges: no $ here, so a test reads them directly.

export const QMD_URL = 'http://localhost:8181'
// The embedding model every collection in the qmd index is embedded with.
export const EMBED = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf'

// qmd 2.x blends rank and reranker: for vector rank k (1-3) the score is 0.75/k + 0.25 × rerank, so the
// reranker's own 0..1 relevance is read back from it. The ranges do not overlap for k=1 (0.75-1); for 2
// or 3 the lower reading is taken.
// shortcut: those are qmd 2.x's weights (store.ts, rrfWeight); re-read them if qmd changes its blend.
export const rerankOf = (s: number) => Math.max(0, s >= 0.75 ? (s - 0.75) / 0.25 : s >= 0.375 ? (s - 0.375) / 0.25 : (s - 0.25) / 0.25)

// A qmd daemon's /health body: only qmd's own counts as up, since the port is fixed.
export function isQmdHealth(text: string) {
  try {
    const b = JSON.parse(text) as { status?: unknown; uptime?: unknown }
    return b.status === 'ok' && typeof b.uptime === 'number'
  } catch {
    return false
  }
}

// ---- the local judge ----

// Fewer examples than this and the nearest ones are not near enough to trust.
export const MIN_EXAMPLES = 30
// The reranker's 0..1 relevance. A near-copy of an old prompt scores 0.8 or more.
const NEAR = 0.8
const CLOSE = 0.5
export const SAMPLE_EVERY = 5
// Below this share of agreement in the last WINDOW samples, local answers stop.
const MIN_AGREE = 0.8
const WINDOW = 20

export type JudgeRow = { name: string; rerank: number }
export type JudgeStats = { local: number; sampled: number; agreed: number; recent: boolean[]; stopped: boolean }

// An example's file is `<label>--<hash>.md`.
export const labelOf = (name: string) => name.split('--')[0] ?? ''

// The nearest examples' label: only when the nearest is very close, at least two are close, and every
// close one agrees.
export function decide(rows: readonly JudgeRow[], labels: readonly string[]) {
  const close = rows.filter(r => r.rerank >= CLOSE)
  const top = rows[0]
  if (!top || top.rerank < NEAR || !labels.includes(labelOf(top.name)) || close.length < 2 || close.some(r => labelOf(r.name) !== labelOf(top.name))) return null
  return { label: labelOf(top.name), name: top.name, n: close.length, score: top.rerank }
}

export const freshStats = (s?: Partial<JudgeStats> | null): JudgeStats => ({
  local: s?.local ?? 0,
  sampled: s?.sampled ?? 0,
  agreed: s?.agreed ?? 0,
  recent: Array.isArray(s?.recent) ? s.recent : [],
  stopped: s?.stopped === true,
})

// One more sample: too little agreement in the last WINDOW stops local answers.
export function afterSample(s: JudgeStats, agreed: boolean): JudgeStats {
  const recent = [...s.recent, agreed].slice(-WINDOW)
  const stopped = s.stopped || (recent.length >= 5 && recent.filter(Boolean).length / recent.length < MIN_AGREE)
  return { ...s, sampled: s.sampled + 1, agreed: s.agreed + (agreed ? 1 : 0), recent, stopped }
}

// One line for a mod's status: how often it answered locally and how the samples went.
export function judgeLine(s: JudgeStats, examples: number, paid: string) {
  const recent = s.recent.length ? `${s.recent.filter(Boolean).length}/${s.recent.length}` : 'none yet'
  if (s.stopped) return `Local judge: stopped, the last samples agreed with ${paid} only ${recent}. Type reset-local to try again.`
  if (examples < MIN_EXAMPLES) return `Local judge: learning, ${examples}/${MIN_EXAMPLES} examples from ${paid}'s answers (needs qmd: the Local Models mod installs it).`
  return `Local judge: ${s.local} answers without ${paid}; 1 in ${SAMPLE_EVERY} also asked ${paid}: agreed ${s.agreed}/${s.sampled} (last ${WINDOW}: ${recent}).`
}

// djb2: a stable name for an example, so the same prompt is kept once.
export function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
