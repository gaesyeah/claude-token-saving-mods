import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Quota Meter: how much of the 5-hour and weekly limits each turn spends.
// The engine reports each window in whole points, so one turn is usually 0 or 1 point:
// the meter averages the last turns (kept across chats in $.store) to make that readable.
// Read only: it changes nothing in the chat and calls no model.

const NAME = 'quota-meter'
const KEEP = 40
const KEY = `${NAME}:turns`
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'semana' }

type Turn = { at: number; five?: number; week?: number }

let claudeDir = ''
let off = false
let now: Record<string, number> = {}
let resets: Record<string, string> = {}
let start: Record<string, number> | null = null

const trim = (v: string | undefined) => (v ?? '').trim()
const pt = (n: number) => n.toFixed(1).replace('.', ',')

async function setup($: EngineInterface) {
  const home = trim(await $.env.get('HOME').catch(() => undefined)) || $.plugin.root.split('/.claude/')[0] || ''
  const set = trim(await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))
  claudeDir = set ? set.replace(/^~(?=\/|$)/, home) : `${home}/.claude`
}

// The /mods switchboard: false in switches.json turns the mod off.
async function readSwitch($: EngineInterface) {
  try {
    const path = `${claudeDir}/mods/switches.json`
    const raw = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    off = raw ? (JSON.parse(raw) as Record<string, unknown>)[NAME] === false : false
  } catch {
    off = false
  }
}

function take(limits: SessionRateLimit[]) {
  for (const l of limits) {
    if (!(l.kind in WINDOWS)) continue
    now[l.kind] = l.percentUsed
    if (l.resetsAt) resets[l.kind] = l.resetsAt
  }
}

async function turns($: EngineInterface): Promise<Turn[]> {
  const v = await $.store.get(KEY).catch(() => undefined)
  return Array.isArray(v) ? (v as Turn[]) : []
}

// Average points per turn over the kept turns that measured that window.
function average(list: Turn[], field: 'five' | 'week') {
  const xs = list.map(t => t[field]).filter((x): x is number => typeof x === 'number')
  return xs.length ? { avg: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null
}

function line(list: Turn[]) {
  const parts: string[] = []
  const five = average(list, 'five')
  if ('five_hour' in now) parts.push(`Cota 5h ${pt(now.five_hour)}%${five ? ` (~${pt(five.avg)} pt/turno)` : ''}`)
  if ('seven_day' in now) parts.push(`semana ${pt(now.seven_day)}%`)
  return parts.length ? parts.join(' · ') : undefined
}

function report(list: Turn[]) {
  if (!Object.keys(now).length) return 'Quota Meter: ainda sem leitura dos limites (só aparece numa assinatura, depois da primeira resposta).'
  const rows = [`Quota Meter (média dos últimos ${list.length} turnos, guardados entre chats):`]
  for (const [kind, label] of Object.entries(WINDOWS)) {
    if (!(kind in now)) continue
    const a = average(list, kind === 'five_hour' ? 'five' : 'week')
    const left = a && a.avg > 0 ? `, dá para ~${Math.floor((100 - now[kind]) / a.avg)} turnos assim` : ''
    const reset = resets[kind] ? `, renova ${new Date(resets[kind]).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''
    rows.push(`- ${label}: ${pt(now[kind])}% usado${a ? `, ~${pt(a.avg)} pt por turno` : ''}${left}${reset}`)
  }
  rows.push('A cota chega em pontos inteiros: um turno sozinho costuma marcar 0 ou 1, por isso vale a média.')
  return rows.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setup($)
    await readSwitch($)
    if (!off) await $.command.register({ name: 'quota', description: 'Quanto da cota de 5h e da semanal cada turno gasta' }).catch(() => undefined)
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    if (!off) {
      take(e.rateLimits)
      void turns($).then(list => $.ui.status(line(list)))
    }
    return next(e)
  })

  // Only the main chat's turns count; a subagent's turn is part of the main one.
  on('turn.start', ($, e, next) => {
    if (!off && !e.agentId) start = { ...now }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (off || e.agentId || !start) return r
    const t: Turn = { at: await $.clock.now() }
    // A drop means the window renewed during the turn: that turn's spend is unknown.
    const d = (k: string) => (k in start! && k in now && now[k] >= start![k] ? now[k] - start![k] : undefined)
    t.five = d('five_hour')
    t.week = d('seven_day')
    start = null
    if (t.five === undefined && t.week === undefined) return r
    const list = [...(await turns($)), t].slice(-KEEP)
    await $.store.set(KEY, list).catch(() => undefined)
    $.ui.status(line(list))
    return r
  })

  on('command.run', { command: 'quota' }, async $ => ({ text: report(await turns($)) }))
}
