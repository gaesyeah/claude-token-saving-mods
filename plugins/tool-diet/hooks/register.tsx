import type { EngineInterface, Register } from 'claude-code'

// Tool Diet: every tool listed in front costs its schema in every chat (written to the cache,
// then read on every request). A big tool this project has not used in its last chats moves
// behind ToolSearch, where it costs nothing until Claude asks for it by name (one extra step then).
// Measure first: it moves tools only when the ones it would move add up to 5k tokens or more.
// The decision is made when a chat starts and never changes mid-chat, so it never breaks the cache.

const NAME = 'tool-diet'
const SAVE_AT = 5000
// A tool smaller than this is not worth an extra ToolSearch step.
const BIG = 400
// How many recent chats of a project count, and how many must exist before anything moves.
const KEEP = 5
const NEED = 3
// The work tools and the ones the app needs every turn stay in front.
const NEVER = /^(Bash|Read|Edit|Write|Grep|Glob|Agent|Skill|ToolSearch|NotebookEdit|mcp__ccd_turn__.*)$/

type Chat = { sid: string; used: string[] }

let claudeDir = ''
let off = false
let sid = ''
let cwd = ''
// What this chat saw: each tool in front and its estimated tokens, and what it moved.
const front: Record<string, number> = {}
const moved: string[] = []
const used = new Set<string>()
let plan: { tools: string[]; tokens: number } | null = null

const tok = (chars: number) => Math.round(chars / 4)
const trim = (v: string | undefined) => (v ?? '').trim()

async function setup($: EngineInterface) {
  claudeDir = (await $.mods.paths()).claudeDir
  off = (await $.mods.switches())[NAME] === false
  sid = await $.session.id().catch(() => '')
  cwd = await $.session.cwd().catch(() => '')
}

const chatsKey = () => `chats:${cwd}`
async function chats($: EngineInterface): Promise<Chat[]> {
  const v = await $.store.get(chatsKey()).catch(() => undefined)
  return Array.isArray(v) ? (v as Chat[]) : []
}
async function sizes($: EngineInterface): Promise<Record<string, number>> {
  const v = await $.store.get('sizes').catch(() => undefined)
  return v && typeof v === 'object' ? (v as Record<string, number>) : {}
}

// Which tools to move in this chat, from the sizes and the use seen in earlier chats.
async function decide($: EngineInterface) {
  if (!cwd || !claudeDir) await setup($)
  const past = (await chats($)).filter(c => c.sid !== sid)
  if (past.length < NEED) return { tools: [], tokens: 0 }
  const seen = new Set(past.flatMap(c => c.used))
  const all = await sizes($)
  const tools = Object.keys(all).filter(t => !NEVER.test(t) && all[t] >= BIG && !seen.has(t))
  const tokens = tools.reduce((a, t) => a + all[t], 0)
  return tokens >= SAVE_AT ? { tools, tokens } : { tools: [], tokens }
}

async function remember($: EngineInterface) {
  if (!cwd || !sid) return
  const list = (await chats($)).filter(c => c.sid !== sid)
  list.push({ sid, used: [...used] })
  await $.store.set(chatsKey(), list.slice(-KEEP)).catch(() => undefined)
}

function report(tokensInFront: number) {
  const rows = [`Tool Diet: ${Object.keys(front).length} ferramentas na frente neste chat, ~${tokensInFront} tokens de descrição.`]
  if (moved.length) rows.push(`Movidas para trás do ToolSearch (sem uso nos últimos chats deste projeto): ${moved.join(', ')}, ~${plan?.tokens ?? 0} tokens a menos por chat.`)
  else if (plan && plan.tokens) rows.push(`Candidatas somam ~${plan.tokens} tokens: abaixo de ${SAVE_AT}, nada foi movido.`)
  else rows.push(`Nada movido: precisa de ${NEED} chats anteriores neste projeto para saber o que ele usa.`)
  const big = Object.entries(front).sort((a, b) => b[1] - a[1]).slice(0, 8)
  if (big.length) rows.push(`Maiores na frente: ${big.map(([t, n]) => `${t} ~${n}`).join(', ')}.`)
  return rows.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const k of Object.keys(front)) delete front[k]
    moved.length = 0
    used.clear()
    plan = null
    await setup($)
    if (!off) await $.command.register({ name: 'tool-diet', description: 'Quais ferramentas o Tool Diet tirou da frente e quanto isso economiza' }).catch(() => undefined)
    return next(e)
  })

  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    if (off || r.isDeferred || e.isDeferred) return r
    if (!cwd || !claudeDir) await setup($)
    const n = tok(r.description.length)
    // Sizes are kept across chats: the next chat decides with them.
    const all = await sizes($)
    if (all[e.tool] !== n) await $.store.set('sizes', { ...all, [e.tool]: n }).catch(() => undefined)
    plan ??= await decide($)
    if (plan.tools.includes(e.tool)) {
      moved.push(e.tool)
      return { ...r, isDeferred: true }
    }
    front[e.tool] = n
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (!off && !used.has(e.tool)) {
      used.add(e.tool)
      void remember($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A chat that used no tool still counts as one of the project's chats.
    if (!off && !e.agentId) void remember($)
    return next(e)
  })

  on('command.run', { command: 'tool-diet' }, async () => ({ text: report(Object.values(front).reduce((a, b) => a + b, 0)) }))
}
