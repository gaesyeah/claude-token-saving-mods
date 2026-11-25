import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'
import type { QuotaView } from '../types'

// Quota Meter: a side pane with how much of the 5-hour and weekly limits each turn spends, and what the
// mods spend on their own model calls (from mods-core's $.mods.spend).
// The engine reports each window in whole points, so one turn is usually 0 or 1 point:
// the meter averages the last turns (kept across chats in $.store) to make that readable.
// /quota opens the pane; it opens by itself once a chat when a window passes AUTO_OPEN %.
// Read only: it changes nothing in the chat and calls no model.

const NAME = 'quota-meter'
const KEEP = 40
const KEY = `${NAME}:turns`
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'semana' }
const PANE = 'quota-meter'
const VIEW = { plugin: 'quota-meter', key: 'view' } as const
const AUTO_OPEN = 80
const ORANGE = '#d97757'

type Turn = { at: number; five?: number; week?: number }

let claudeDir = ''
let off = false
let now: Record<string, number> = {}
let resets: Record<string, string> = {}
let start: Record<string, number> | null = null
// Opened by itself in this chat already (a limit passed AUTO_OPEN).
let autoOpened = false
let sid = ''

const trim = (v: string | undefined) => (v ?? '').trim()
const pt = (n: number) => n.toFixed(1).replace('.', ',')
const usd = (n: number) => `US$ ${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`.replace('.', ',')
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n))

async function setup($: EngineInterface) {
  claudeDir = (await $.mods.paths()).claudeDir
}

// The /mods switchboard: false in switches.json turns the mod off.
async function readSwitch($: EngineInterface) {
  off = (await $.mods.switches())[NAME] === false
}

function take(limits: SessionRateLimit[]) {
  for (const l of limits) {
    if (!(l.kind in WINDOWS)) continue
    now[l.kind] = l.percentUsed
    if (l.resetsAt) resets[l.kind] = l.resetsAt
  }
}

// The pane's view, rewritten after each reading; past AUTO_OPEN % the pane opens itself, once a chat.
async function show($: EngineInterface, list: Turn[]) {
  const view: QuotaView = { line: line(list) ?? '', report: report(list), five: now.five_hour, week: now.seven_day }
  await $.state.set(VIEW, view).catch(() => undefined)
  // Only where a surface can draw it (not under claude -p).
  if (!autoOpened && Math.max(now.five_hour ?? 0, now.seven_day ?? 0) >= AUTO_OPEN && (await $.session.surfaces().catch(() => [])).length) {
    autoOpened = true
    await $.ui.open({ id: PANE, title: 'Quota Meter' }).catch(() => undefined)
  }
}

// The /mods pane's Open button, checked every 3 s through mods-core.
async function openAsked($: EngineInterface) {
  if (off || !(await $.mods.openAsked({ mod: NAME }))) return
  await $.ui.open({ id: PANE, title: 'Quota Meter' }).catch(() => undefined)
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
    autoOpened = false
    // The status line it used before 0.3 stays clear: the pane holds it all now.
    $.ui.status(undefined)
    sid = await $.session.id().catch(() => '')
    if (!off) $.clock.every(3000, () => void openAsked($).catch(() => undefined))
    if (!off) await $.command.register({ name: 'quota', description: 'Abre o painel da cota de 5h e semanal, e do gasto dos mods com Haiku e Sonnet' }).catch(() => undefined)
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    if (!off) {
      take(e.rateLimits)
      void turns($).then(list => show($, list))
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
    await show($, list)
    return r
  })

  // /quota opens the pane; /quota status prints the report here.
  on('command.run', { command: 'quota' }, async ($, e) => {
    const list = await turns($)
    if (e.args?.trim() === 'status') return { text: report(list) }
    await show($, list)
    await $.ui.open({ id: PANE, title: 'Quota Meter' }).catch(() => undefined)
    return { text: `${line(list) ?? 'Quota Meter: ainda sem leitura dos limites.'} · painel aberto ao lado (/quota status mostra aqui).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (off) return <Text dimColor>O Quota Meter está desligado. Ligue em /mods.</Text>
    const width = Math.max(32, e.props.bodyColumns)
    const { value: view } = await $.state.get(VIEW)
    const spend = await $.mods.spend().catch(() => ({ today: [], week: [] }))
    const tiles = [
      { label: '5h', value: typeof view?.five === 'number' ? `${pt(view.five)}%` : '–' },
      { label: 'Semana', value: typeof view?.week === 'number' ? `${pt(view.week)}%` : '–' },
      { label: 'Mods hoje', value: usd(spend.today.reduce((n, r) => n + r.usd, 0)) },
    ]
    const tileW = Math.floor((width - (tiles.length - 1)) / tiles.length)
    const table = (title: string, rows: typeof spend.today) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{title}</Text>
        {rows.length ? (
          rows.map(r => (
            <Text key={`${title}-${r.mod}-${r.model}`} dimColor wrap="truncate-end">
              {`${r.mod} · ${r.model} · ${r.calls} ${r.calls === 1 ? 'chamada' : 'chamadas'} · ${k(r.in)} → ${k(r.out)} tok · ${usd(r.usd)}`}
            </Text>
          ))
        ) : (
          <Text dimColor>Nenhuma chamada.</Text>
        )}
      </Box>
    )
    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" gap={1} width={width} marginBottom={1}>
          {tiles.map(t => (
            <Box key={`t-${t.label}`} flexDirection="column" borderStyle="round" paddingX={1} width={tileW}>
              <Text dimColor wrap="truncate-end">{t.label}</Text>
              <Text bold color={ORANGE} wrap="truncate-end">
                {t.value}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Cota</Text>
          {(view?.report ?? 'Ainda sem leitura dos limites: aparece depois da primeira resposta.').split('\n').map((l, i) => (
            <Text key={`q${i}`} dimColor wrap="wrap">
              {l}
            </Text>
          ))}
        </Box>
        {table('Gasto dos mods com modelos, hoje', spend.today)}
        {table('Últimos 7 dias', spend.week)}
        <Text dimColor wrap="wrap">Os valores dos mods são estimativas a preço de tabela. Numa assinatura, eles contam na cota acima, não em dólares.</Text>
      </Box>
    )
  })
}
