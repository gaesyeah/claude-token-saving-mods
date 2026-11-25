// What the mods spend on their own model calls (Haiku, Sonnet): pure rules, no $ here.

// List prices per million tokens, as Model Router's policy.ts cached them on 2026-10-06.
const PRICES: { family: RegExp; name: string; input: number; output: number; cacheRead: number; cacheWrite: number }[] = [
  { family: /haiku/i, name: 'Haiku', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { family: /sonnet/i, name: 'Sonnet', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { family: /opus/i, name: 'Opus', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
]

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
// One day's spend: mod → model family → totals.
export type Day = Record<string, Record<string, { calls: number; in: number; out: number; usd: number }>>
export type SpendRow = { mod: string; model: string; calls: number; in: number; out: number; usd: number }

export const familyOf = (model: string) => PRICES.find(p => p.family.test(model))?.name ?? model

export function usdOf(model: string, u: Usage) {
  const p = PRICES.find(x => x.family.test(model))
  if (!p) return 0
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6
}

// Adds one call to a day.
export function addCall(day: Day, mod: string, model: string, u: Usage): Day {
  const fam = familyOf(model)
  const was = day[mod]?.[fam] ?? { calls: 0, in: 0, out: 0, usd: 0 }
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return { ...day, [mod]: { ...(day[mod] ?? {}), [fam]: { calls: was.calls + 1, in: was.in + input, out: was.out + (u.output_tokens ?? 0), usd: was.usd + usdOf(model, u) } } }
}

// The rows of several days summed, the dearest first.
export function rowsOf(days: readonly Day[]): SpendRow[] {
  const sum = new Map<string, SpendRow>()
  for (const day of days)
    for (const [mod, models] of Object.entries(day))
      for (const [model, t] of Object.entries(models)) {
        const k = `${mod}|${model}`
        const r = sum.get(k) ?? { mod, model, calls: 0, in: 0, out: 0, usd: 0 }
        sum.set(k, { ...r, calls: r.calls + t.calls, in: r.in + t.in, out: r.out + t.out, usd: r.usd + t.usd })
      }
  return [...sum.values()].sort((a, b) => b.usd - a.usd || b.calls - a.calls)
}

// A local calendar day as YYYY-MM-DD.
export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
