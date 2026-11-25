// The one list-price table the mods share (per million tokens), from the claude-api skill, read
// 2026-11-02. A mod gets it from $.mods.prices() at chat start and looks a model up in its own copy.

export type Card = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
// `pattern` is a case-insensitive RegExp source, tried in order; `large` is the card for a prompt over 100K tokens.
export type PriceEntry = { pattern: string; name: string; small: Card; large?: Card }

// A cache read is readX × input; a write is 1.25× input for the 5-minute TTL, 2× for the 1-hour one.
const card = (input: number, output: number, readX: number): Card => ({
  input,
  output,
  cacheRead: input * readX,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
})

export const PRICES: PriceEntry[] = [
  { pattern: 'fable|mythos', name: 'Fable', small: card(10, 50, 0.025) },
  { pattern: 'opus-5[-.]5|^opus(\\[|$)', name: 'Opus', small: card(4, 20, 0.05) },
  { pattern: 'opus-5(?![-.]\\d)', name: 'Opus', small: card(5, 25, 0.1) },
  { pattern: 'sonnet', name: 'Sonnet', small: card(2, 10, 0.1) },
  { pattern: 'haiku-4[-.]5', name: 'Haiku', small: card(1, 5, 0.1) },
  { pattern: 'haiku', name: 'Haiku', small: card(0.1, 0.5, 0.1), large: card(0.5, 2.5, 0.1) },
]

// The entry for a model id or alias, or undefined for one with no price.
export const entryOf = (model: string) => PRICES.find(p => new RegExp(p.pattern, 'i').test(model))
