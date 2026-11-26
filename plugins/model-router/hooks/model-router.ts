/**
 * model-router: Claude Mod
 *
 * Picks the model each subagent runs on. The configured judge reads the task and answers in
 * JSON: a tier (fast, balanced or deep), its confidence in that tier from 0
 * to 1, an effort score and a risk score.
 *
 * This copy is BenAI's, from davila7/claude-code-templates (MIT). The
 * original asked TypeSafe's Jev; this version uses the provider-aware judge resolved by `mods-core`
 * and makes no other network call. What it changes is listed in README.md
 * under "Changes in this copy". In short:
 *
 *   - the configured judge's JSON confidence feeds the downgrade bar, so
 *     an easy task can move down from Opus when the judge is sure enough;
 *   - the tiers are full ids, the deep one `claude-opus-5-5`;
 *   - main-chat effort routing is off by default, and it leaves effort alone
 *     while Stably's `~/.claude/mods-logs/.stably-<session id>` file says active;
 *   - the main chat's model is never changed: a model change mid-chat throws
 *     the whole prompt cache away;
 *   - the /mods switch (switches.json) turns every hook into `next(e)`;
 *   - every subagent pick adds one line to `~/.claude/mods-logs/savings.jsonl`
 *     when the subagent's run ends: the model it ran on, the one it replaced
 *     and what the run would have cost on each, at list price.
 *
 * Every failure path is fail-open: a judge call that errors, runs past its
 * time limit or answers something unreadable leaves the request exactly as
 * the engine built it.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import {
  JUDGE_MODEL,
  JUDGE_SYSTEM,
  PRICE_DATE,
  setPrices,
  canonicalModel,
  describeDecision,
  describeSetup,
  describeStatus,
  judgePrompt,
  pendingDecisions,
  readJudgement,
  route,
  runCost,
  sumUsage,
  totalTokens,
  usd,
  bareCommand,
} from './policy.ts'
import type { Decision, Effort, JudgeState, PolicyConfig, StepUsage } from './policy.ts'
import { rankOf, TIER_ORDER } from './policy.ts'
import { family, registerPane, resetPane, setSwitchHidden } from './pane.tsx'
import type { Outcome, PickCard } from '../types'
import { workerFallbackLine } from './worker-fallback'

const NAME = 'model-router'
let workerFallbackSequence = 0
let paneCardSequence = 0
const TITLE = 'Model Router'

// Atom sources must be declared in the module that calls read/update: the
// Claude Code static scanner cannot trace atom objects across imports.
// These keys and the cards shape match the UI renderer in pane.tsx.
const cardsAtom = atom({ plugin: 'model-router', key: 'cards' } as const, [] as PickCard[], { shape: 'cards-1' })
const busyAtom = atom({ plugin: 'model-router', key: 'busy' } as const, 0)
const offAtom = atom({ plugin: 'model-router', key: 'off' } as const, false)

// Keep engine API access in the hooks module: the Claude Code host cannot follow
// `$` through an imported helper (the pane module only declares UI hooks/atoms).
async function openPane($: EngineInterface, asked = false): Promise<void> {
  if (!(await $.mods.paneAllowed({ mod: NAME, asked }).catch(() => true))) return
  try { await $.ui.open({ id: NAME, title: 'Subagent Model Selector' }) } catch { /* optional pane */ }
}
async function closePane($: EngineInterface): Promise<void> {
  try { await $.ui.close({ id: NAME }) } catch { /* optional pane */ }
}
async function setOff($: EngineInterface, value: boolean): Promise<void> {
  await update($, offAtom, () => value)
}
async function setBusy($: EngineInterface, busy: boolean): Promise<void> {
  await update($, busyAtom, n => Math.max(0, (typeof n === 'number' ? n : 0) + (busy ? 1 : -1)))
}
async function setCard($: EngineInterface, id: string, change: Partial<PickCard>): Promise<void> {
  await update($, cardsAtom, list => (list ?? []).map(card => card.id === id ? { ...card, ...change } : card))
}
async function addCard($: EngineInterface, card: Omit<PickCard, 'id' | 'at'>): Promise<string> {
  const at = await $.clock.now()
  const cards = (await read($, cardsAtom)) ?? []
  paneCardSequence = Math.max(paneCardSequence, ...cards.map(x => Number(x.id) || 0)) + 1
  const id = String(paneCardSequence)
  await update($, cardsAtom, list => [{ ...card, id, at }, ...(list ?? [])].slice(0, 20))
  return id
}

// Module variables reset on a reload.
let home = ''
// ---- Config folder ----
// Where Claude Code keeps its files: CLAUDE_CONFIG_DIR when it is set, else <home>/.claude.
// Read from the environment when a chat starts. The plugin's own path is only the last
// resort: a pack installed from a local folder (say ~/Downloads) does not sit under ~/.claude.
let claudeDir = ''
// Set by $.mods.paths() when the chat starts.
const claudeDirOf = (_: EngineInterface) => claudeDir
let session = ''
let timerStarted = false

// The /mods switchboard: "model-router": false turns the mod off in every chat, and
// "model-router:hidden": true keeps the pane shut until it is asked for. Read only.
let off = false
let hidden = false
let switchError = ''

async function readSwitch($: EngineInterface) {
  let now = off
  let nowHidden = hidden
  try {
    const json = await $.mods.readSwitches()
    now = json[NAME] === false
    nowHidden = json[`${NAME}:hidden`] === true
    switchError = ''
  } catch (err) {
    // A broken file changes nothing. Logged once, not every 3 seconds.
    const said = err instanceof Error ? err.message : String(err)
    if (said !== switchError) void log($, `switches.json not read, nothing changed: ${said}`)
    switchError = said
  }
  if (nowHidden !== hidden) {
    hidden = nowHidden
    setSwitchHidden(hidden)
    if (hidden) await closePane($)
  }
  const flipped = now !== off
  off = now
  if (flipped) {
    await setOff($, now)
    if (now) await closePane($)
  }
}

// Open in /mods writes an empty file named for this mod and this chat: open the pane, remove the file.
async function checkOpen($: EngineInterface) {
  if (!session || !home) return
  if (!(await $.mods.openAsked({ mod: NAME }))) return
  if (!off) await openPane($, true)
}

// Stably's marker can stay on disk as {"active":false} when its rm fails, so
// only `active: true` counts. A missing, unreadable or bad file is Stably off.
async function stablyActive($: EngineInterface) {
  try {
    const path = `${claudeDir}/mods-logs/.stably-${session}`
    if (!(await $.fs.exists(path))) return false
    const json = JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
    return json.active === true
  } catch {
    return false
  }
}

const logPath = () => `${claudeDir}/mods-logs/${NAME}.log`
const ledgerPath = () => `${claudeDir}/mods-logs/savings.jsonl`
const detailDir = () => `${claudeDir}/mods-logs/${NAME}`

// A true append through mods-core (which falls back to read and write where the shell fails).
async function append($: EngineInterface, path: string, line: string) {
  await $.mods.append({ path, text: line.endsWith('\n') ? line : `${line}\n` })
}

async function log($: EngineInterface, line: string) {
  await $.mods.log({ file: logPath(), line }).catch(() => undefined)
}

/** Home, session id and the switch timer, whichever hook runs first. */
async function ready($: EngineInterface) {
  if (!home) {
    ;({ home, claudeDir } = await $.mods.paths())
    setPrices(await $.mods.prices().catch(() => []))
  }
  if (!session) session = await $.session.id().catch(() => '')
  if (!timerStarted) {
    timerStarted = true
    await readSwitch($).catch(() => undefined)
    $.clock.every(3000, () => {
      void readSwitch($)
        .then(() => checkOpen($))
        .catch(err => log($, `switch poll: ${String(err)}`))
    })
  }
}

/** A pick waiting for its subagent's run to end, to be priced and logged. */
type Pick = {
  toolUseId: string | null
  subagentType: string
  description: string
  replaced: string
  model: string
  changed: boolean
  reason: string
  decision: string
  router: string
  helper: { model: string; in: number; out: number | null } | null
  steps: StepUsage[]
  /** The pane's card for this subagent. */
  cardId: string | null
}


// Set once by register from the plugin's options.
export function modelForRequest(resolved: { model: string; provider: string | null; source: 'clauderipple' | 'fallback' }): string {
  if (resolved.source !== 'clauderipple' || !resolved.provider) return resolved.model
  const prefix = `${resolved.provider}:`
  return resolved.model.startsWith(prefix) ? resolved.model : `${prefix}${resolved.model}`
}

type Config = {
  timeoutMs: number
  routeSubagentModel: boolean
  routeMainEffort: boolean
  logDecisions: boolean
  policy: PolicyConfig
}
let cfg: Config

/**
 * How long a judge call may take. The previous Haiku judge answered in 1.2 to 1.3 s in the live
 * test; the old 800 ms budget was sized for Jev and would end every call.
 */
const DEFAULT_TIMEOUT_MS = 8000

// The judge's JSON is about 60 tokens; this leaves room for a stray sentence.
const JUDGE_MAX_TOKENS = 200

// The setup line is written once, at the first judge call.
let announced = false

/**
 * Asks the configured judge which tier a task needs. Returns the decision (null when none
 * came back or it could not be read) and what the judge call used.
 */
async function classify(
  $: EngineInterface,
  state: JudgeState,
): Promise<{ decision: Decision | null; helper: Pick['helper']; router: string; ms: number; text: string }> {
  if (!announced) {
    announced = true
    const setup = describeSetup(
      { subagentModel: cfg.routeSubagentModel, mainEffort: cfg.routeMainEffort, mainModel: false },
      cfg.timeoutMs,
    )
    await log($, setup)
    if (cfg.logDecisions) $.ui.log(`[${NAME}] ${setup}`)
  }
  const startedAt = await $.clock.now()
  let decision: Decision | null = null
  let helper: Pick['helper'] = null
  let judgeModel = JUDGE_MODEL
  let text = ''
  try {
    const completed = await $.mods.modelComplete({
      mod: NAME, role: 'judge', fallback: JUDGE_MODEL,
      request: { system: JUDGE_SYSTEM, prompt: judgePrompt(state), maxTokens: JUDGE_MAX_TOKENS, timeoutMs: cfg.timeoutMs },
    })
    const { model, result } = completed
    judgeModel = model
    // No usd here: Savings Proof reads a helper's usd as a billed amount, and
    // this is list price. It prices the helper itself from the model id.
    const used = result.usage
    if (used) {
      helper = {
        model,
        in: used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens,
        out: used.output_tokens,
      }
    }
    if (result.isAnswered) {
      text = result.text
      decision = readJudgement(result.text)
      if (!decision) await log($, `judge answer unreadable, model kept: ${JSON.stringify(result.text.slice(0, 200))}`)
    } else {
      const why = result.reason === 'api-error' ? `api-error ${result.status ?? ''}`.trim() : result.reason
      await log($, `judge gave no answer (${why}), model kept`)
    }
  } catch (error) {
    await log($, `judge call refused, model kept: ${String(error)}`)
  }
  const ms = (await $.clock.now()) - startedAt
  return { decision, helper, router: judgeModel, ms, text }
}

// The local judge answers like Haiku did for tasks much like this one (see local-judge.ts); each
// example keeps the remote judge's whole answer beside it, so a local answer is a real Decision.
// The local judge, in mods-core: its qmd collection, its examples' folder and its labels.
const judge = () => ({ collection: 'router-examples', dir: `${claudeDir}/mods-logs/${NAME}/examples`, labels: [...TIER_ORDER] })
const taskText = (s: JudgeState) => `${s.agentType}: ${s.description ?? ''}\n${s.prompt}`

async function judgeTask($: EngineInterface, state: JudgeState, cardId: string | null): Promise<Awaited<ReturnType<typeof classify>>> {
  const text = taskText(state)
  const startedAt = await $.clock.now()
  const local = await $.mods.judgeGuess({ ...judge(), text }).catch(async err => (await log($, `local judge: ${String(err)}`), null))
  if (local) {
    const saved = String(await $.fs.read(local.file.replace(/[^/]*--([^/]+)\.md$/, '$1.json')).catch(() => ''))
    const decision = readJudgement(saved)
    if (decision && decision.tier === local.label) {
      const said = `Local: like ${local.n} past tasks the remote judge judged ${local.label} (no remote call).`
      // A sample: The remote judge also samples in the background; the card's answer says whether they agree.
      if (await $.mods.judgeUsed({ collection: judge().collection }))
        void (async () => {
          const paid = await classify($, state)
          if (!paid.decision) return
          const agreed = paid.decision.tier === local.label
          const stopped = await $.mods.judgeSampled({ collection: judge().collection, agreed })
          await $.mods.judgeRemember({ ...judge(), text, label: paid.decision.tier, extra: paid.text })
          await log($, `local sample: local ${local.label}, remote judge ${paid.decision.tier}${stopped ? '; local judge stopped' : ''}`)
          if (cardId) await setCard($, cardId, { judge: `${said}\n\nSample: remote judge ${agreed ? 'agrees' : `says ${paid.decision.tier}`}.\n${paid.text}`.slice(0, 2000) })
        })().catch(err => log($, `local sample: ${String(err)}`))
      return { decision, helper: null, router: 'local', ms: (await $.clock.now()) - startedAt, text: `${said}\n${saved}` }
    }
  }
  const judged = await classify($, state)
  if (judged.decision) void $.mods.judgeRemember({ ...judge(), text, label: judged.decision.tier, extra: judged.text }).catch(err => log($, `local remember: ${String(err)}`))
  return judged
}

// Said once per hook, so the log shows which hooks fire in this app.
const heard = new Set<string>()
async function first($: EngineInterface, hook: string, where: string) {
  if (heard.has(hook)) return
  heard.add(hook)
  await log($, `first ${hook} (${where})`)
}


// Use ClaudeRipple's explicitly configured ladder when available. A missing or ambiguous rung
// keeps the exact tier id configured by this plugin; the main conversation model is never changed.
async function policyFor($: EngineInterface): Promise<PolicyConfig> {
  const [fast, balanced, deep] = await Promise.all([
    $.mods.modelResolve({ role: 'light', fallback: cfg.policy.tiers.fast }),
    $.mods.modelResolve({ role: 'standard', fallback: cfg.policy.tiers.balanced }),
    $.mods.modelResolve({ role: 'hard', fallback: cfg.policy.tiers.deep }),
  ])
  return {
    ...cfg.policy,
    tiers: { fast: fast.model, balanced: balanced.model, deep: deep.model },
    requestTiers: { fast: modelForRequest(fast), balanced: modelForRequest(balanced), deep: modelForRequest(deep) },
  }
}

// Main-loop effort, only when routeMainEffort is on.
let pending = pendingDecisions()
let appliedTurnId: string | undefined
let applied: { effort?: Effort } | null = null
let lastMainCacheRead: number | null = null
let effortChange: { turnId: string; before: number | null; to: Effort } | null = null

// Subagent picks, by agentId, until the run ends.
const picks = new Map<string, Pick>()
// Every routed subagent's card, by agentId, so the card ends with the run, ledger line or not.
const cardOf = new Map<string, string>()
const recent: string[] = []
let sessionSaved = 0
let sessionPicks = 0

async function writeLedger(
  $: EngineInterface,
  agentId: string,
  pick: Pick,
  turnUsage: (StepUsage & { model: string }) | null,
) {
  const usage = pick.steps.length > 0 ? sumUsage(pick.steps) : turnUsage
  const tokens = usage ? totalTokens(usage) : 0
  const costBefore = runCost(pick.replaced, pick.steps, turnUsage)
  const costAfter = runCost(pick.model, pick.steps, turnUsage)
  const saved = costBefore !== null && costAfter !== null ? costBefore - costAfter : null
  const now = new Date(await $.clock.now()).toISOString()
  const stamp = now.replace(/[:]/g, '').replace('T', '-').slice(0, 17)
  const detail = `${detailDir()}/${stamp}-${agentId.slice(0, 8)}.md`
  const replaced = canonicalModel(pick.replaced)
  const model = canonicalModel(pick.model)
  const money = (v: number | null) => (v === null ? 'unknown' : `$${usd(v).toFixed(6)}`)

  const line = {
    ts: now,
    session,
    tool_use_id: pick.toolUseId,
    mod: NAME,
    action: pick.changed
      ? `${pick.subagentType} subagent on ${model}, not ${replaced}${saved === null ? '' : `, ~$${usd(saved).toFixed(4)} ${saved >= 0 ? 'less' : 'more'}`}`
      : `${pick.subagentType} subagent kept ${replaced}`,
    // A model swap saves dollars, not tokens: the run read the same tokens
    // either way. The dollar difference is in cost_usd.
    before: tokens,
    after: tokens,
    helper: pick.helper,
    measured: 'estimated',
    detail,
    model,
    replaced,
    changed: pick.changed,
    answered_by: turnUsage?.model ?? null,
    cost_usd: {
      before: costBefore === null ? null : usd(costBefore),
      after: costAfter === null ? null : usd(costAfter),
      saved: saved === null ? null : usd(saved),
    },
    router: pick.router,
  }
  await $.mods.ledger({ row: line })

  sessionPicks += 1
  if (saved !== null) sessionSaved += saved
  recent.push(`${pick.subagentType}: ${pick.changed ? `${replaced} -> ${model}` : `kept ${replaced}`}, saved ${money(saved)}`)

  const body = [
    `# ${TITLE}: ${pick.subagentType} subagent`,
    '',
    `- Time: ${now}`,
    `- Task: ${pick.description || 'no description'}`,
    `- Decision (${pick.router}): ${pick.decision}`,
    `- Policy: ${pick.reason}`,
    `- Model before: ${replaced}. Model after: ${model}. Changed: ${pick.changed ? 'yes' : 'no'}.`,
    `- Model the API reported: ${turnUsage?.model ?? 'unknown'}`,
    `- Requests seen by turn.step: ${pick.steps.length}${pick.steps.length === 0 ? ' (priced from the run total, short-prompt rate)' : ''}`,
    usage
      ? `- Tokens: ${usage.input_tokens} in, ${usage.output_tokens} out, ${usage.cache_read_input_tokens} cache read, ${usage.cache_creation_input_tokens} cache write`
      : '- Tokens: none reported',
    `- Cost on ${replaced}: ${money(costBefore)}. Cost on ${model}: ${money(costAfter)}. Difference: ${money(saved)}.`,
    `- Prices: list price per million tokens, cached ${PRICE_DATE}. Cache writes at the 5-minute rate.`,
    '- Estimate: the same tokens priced on both models. A different model may use a different number of tokens.',
    '',
  ].join('\n')
  await append($, detail, body)
  await log($, `ledger: ${line.action}`)
  if (pick.cardId) {
    await setCard($, pick.cardId, {
      phase: 'done',
      costBefore: line.cost_usd.before,
      costAfter: line.cost_usd.after,
      saved: line.cost_usd.saved,
      detail,
    }).catch(() => undefined)
  }
}

const BAR_NAME = (m: string) => family(canonicalModel(m))

/** The card's sentence: why the subagent moved or stayed, in plain words. */
export function explain(
  decision: Decision | null,
  current: string,
  model: string | null,
  policy: PolicyConfig,
): { outcome: Outcome; why: string } {
  if (!decision) return { outcome: 'no-answer', why: `The judge gave no answer, so it kept ${BAR_NAME(current)}.` }
  const c = decision.confidence
  const sure = c === null ? 'no confidence given' : `confidence ${c.toFixed(2)}`
  if (decision.risky !== null && decision.risky > 0.7) {
    return model
      ? { outcome: 'forced', why: `The judge saw risk (${decision.risky.toFixed(2)}), so it went to ${BAR_NAME(model)}.` }
      : { outcome: 'agreed', why: `The judge saw risk, and ${BAR_NAME(current)} is already the top model.` }
  }
  if (model) return { outcome: 'moved', why: `Moved to ${BAR_NAME(model)}: ${sure}, over the bar.` }
  const wanted = TIER_ORDER.indexOf(decision.tier)
  const have = rankOf(current, policy.tiers)
  if (have === null || have === wanted || policy.tiers[decision.tier] === current) {
    return { outcome: 'agreed', why: `Kept ${BAR_NAME(current)}: The judge agrees it fits (${sure}).` }
  }
  const down = wanted < have
  const bar = down ? policy.minDowngradeConfidence : policy.minUpgradeConfidence
  return {
    outcome: 'under-bar',
    why:
      c === null
        ? `Kept ${BAR_NAME(current)}: The judge wanted ${BAR_NAME(policy.tiers[decision.tier])} but gave no confidence.`
        : `Kept ${BAR_NAME(current)}: confidence ${c.toFixed(2)} under the ${bar} bar${down ? '' : ' to move up'}.`,
  }
}

export const register: Register = (on, options) => {
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback
  const named = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback

  cfg = {
    timeoutMs: number('timeoutMs', DEFAULT_TIMEOUT_MS),
    routeSubagentModel: flag('routeSubagentModel', true),
    // Off by default: a mid-chat effort change can throw the message cache away.
    routeMainEffort: flag('routeMainEffort', false),
    logDecisions: flag('logDecisions', true),
    policy: {
      tiers: {
        fast: named('fastModel', 'claude-haiku-5-5'),
        balanced: named('balancedModel', 'claude-sonnet-5-5'),
        deep: named('deepModel', 'claude-opus-5-5'),
      },
      minUpgradeConfidence: number('minUpgradeConfidence', 0.3),
      minDowngradeConfidence: number('minDowngradeConfidence', 0.6),
    },
  }
  const { routeSubagentModel, routeMainEffort, logDecisions, policy } = cfg

  // A load starts clean: a reload must not keep the last load's state or picks.
  home = ''
  claudeDir = ''
  session = ''
  timerStarted = false
  off = false
  hidden = false
  switchError = ''
  announced = false
  heard.clear()
  pending = pendingDecisions()
  appliedTurnId = undefined
  applied = null
  lastMainCacheRead = null
  effortChange = null
  picks.clear()
  cardOf.clear()
  resetPane()
  paneCardSequence = 0
  recent.length = 0
  sessionSaved = 0
  sessionPicks = 0

  registerPane(on)

  on('session.start', async ($, e, next) => {
    await ready($)
    await $.command.register({
      name: NAME,
      description: 'Model Router: the configured judge picks each subagent model. Shows what it picked and the saving. pane: open the pane',
      argumentHint: '[pane]',
    })
    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    await ready($)
    if (off) return { text: `${TITLE} is off. Turn it on with /mods.` }
    if (e.args.trim().toLowerCase() === 'reset-local') {
      await $.mods.judgeReset({ collection: judge().collection })
      return { text: `${TITLE}: the local judge answers again, with its samples counted from zero.` }
    }
    await openPane($, true)
    if (e.args.trim().toLowerCase() === 'pane') {
      return { text: `${TITLE}: pane open. This chat: ${sessionPicks} picks logged, about $${usd(sessionSaved).toFixed(4)} saved.` }
    }
    const activePolicy = await policyFor($)
    const activeJudge = await $.mods.modelResolve({ role: 'judge', fallback: JUDGE_MODEL })
    const lines = [
      `${TITLE} is on.`,
      `Judge: ${activeJudge.model} (JSON tier and confidence). Moves down only at confidence ${policy.minDowngradeConfidence} or more, up at ${policy.minUpgradeConfidence} or more. Time limit ${cfg.timeoutMs}ms.`,
      `Subagent model routing: ${routeSubagentModel ? 'on' : 'off'}. Main chat effort routing: ${routeMainEffort ? 'on' : 'off'}. Main chat model: never changed.`,
      `Tiers: ${activePolicy.tiers.fast} / ${activePolicy.tiers.balanced} / ${activePolicy.tiers.deep}.`,
      await $.mods.judgeLine({ collection: judge().collection, dir: judge().dir, paid: activeJudge.source === 'fallback' ? 'Haiku' : activeJudge.model }),
      `This chat: ${sessionPicks} picks logged, about $${usd(sessionSaved).toFixed(4)} saved at list price (${PRICE_DATE}).`,
      ...(recent.length > 0 ? ['Last picks:', ...recent.slice(-5).map(r => `  ${r}`)] : []),
      `Ledger: ${ledgerPath()}`,
    ]
    return { text: lines.join('\n') }
  })

  on('prompt.submit', async ($, e, next) => {
    await ready($)
    if (off) return next(e)
    await first($, 'prompt.submit', 'main')
    if (!routeMainEffort) return next(e)

    // A slash command alone gives the decision model only the command's name.
    if (bareCommand(e.text)) {
      pending.put(null)
      return next(e)
    }
    const { decision, ms } = await classify($, { prompt: e.text })
    await log($, `main prompt: ${describeDecision(decision, ms)}`)
    pending.put(decision)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await ready($)
    if (off) return yield* next(e)
    await first($, e.agentId ? 'turn.step:agent' : 'turn.step:main', e.agentId ?? 'main')

    // A picked subagent: keep each request's counts, for a per-request price.
    if (e.agentId) {
      const result = yield* next(e)
      const pick = picks.get(e.agentId)
      if (pick && result.usage) pick.steps.push(result.usage)
      return result
    }

    if (!routeMainEffort) return yield* next(e)

    // Every request after the first reuses what the turn settled on.
    if (e.index > 0 && e.turnId === appliedTurnId) {
      return yield* next(applied ? { ...e, ...applied } : e)
    }

    const decision = pending.take()
    appliedTurnId = e.turnId
    applied = null

    // Stably owns effort while its word is in the prompt.
    if (await stablyActive($)) {
      await log($, 'main effort left alone: Stably is on for this turn')
      return yield* next(e)
    }

    // The model is never changed here; only effort is read from the routing.
    const activePolicy = await policyFor($)
    const routing = route(decision, { model: e.model, effort: e.effort }, activePolicy)
    if (routing.effort) applied = { effort: routing.effort }
    if (logDecisions) $.ui.status(describeStatus(decision, applied))
    if (!applied) {
      await log($, `main effort kept: ${routing.reason}`)
      return yield* next(e)
    }
    effortChange = { turnId: e.turnId, before: lastMainCacheRead, to: routing.effort as Effort }
    await log($, `main effort ${String(e.effort)} -> ${routing.effort}: ${routing.reason}`)
    return yield* next({ ...e, ...applied })
  })

  on('agent.spawn', async ($, e, next) => {
    await ready($)
    if (off) return next(e)
    await first($, 'agent.spawn', e.subagentType)

    const asked = e.model && e.model !== 'inherit' ? e.model : undefined
    // The task's own words, so parallel spawns of one type can be told apart in the log.
    const task = e.description ? ` "${e.description.replace(/\s+/g, ' ').slice(0, 80)}"` : ''
    await log(
      $,
      `spawn ${e.subagentType}${task}: model ${asked ?? 'not set'}, parent ${e.parentModel}${e.fork ? ', fork' : ''}${e.resume ? ', resume' : ''}${e.workflow ? `, workflow #${e.workflow.agentIndex}` : ''}`,
    )

    // A fork inherits its parent's model; a resume keeps its own.
    if (!routeSubagentModel || e.fork || e.resume) return next(e)

    // The pane's card goes up before the judge answers, so the judging shows.
    const cardId = await addCard($, {
      agentType: e.subagentType,
      task: e.description,
      prompt: e.prompt.slice(0, 1200),
      phase: 'judging',
    }).catch(() => null)
    await setBusy($, true).catch(() => undefined)
    void openPane($)
    let judged: Awaited<ReturnType<typeof classify>>
    try {
      judged = await judgeTask(
        $,
        {
          prompt: e.prompt,
          description: e.description,
          agentType: e.subagentType,
        },
        cardId,
      )
    } finally {
      await setBusy($, false).catch(() => undefined)
    }
    const { decision, helper, router, ms, text } = judged
    const said = describeDecision(decision, ms)
    await log($, `judge (${e.subagentType}${task}): ${said}`)
    if (logDecisions) $.ui.log(`[${NAME}] judge (${e.subagentType}): ${said}`)

    // The subagent's own model wins when the caller named one; otherwise it
    // would inherit the parent's, so that is what a change is measured from.
    // The Agent tool takes no effort, so only the model is ours to set here.
    const current = asked ?? e.parentModel
    // Effort is dropped before routing: an effort answer alone would count as
    // a change and hide the "kept, wanted" reason in the log.
    const modelOnly = decision ? { ...decision, effort: null, effortConfidence: null } : null
    const activePolicy = await policyFor($)
    const { model, requestModel, reason } = route(modelOnly, { model: current }, activePolicy)
    const ran = model ?? current
    const { outcome, why } = explain(decision, current, model, activePolicy)
    if (cardId) {
      await setCard($, cardId, {
        phase: 'running',
        tier: decision?.tier,
        confidence: decision?.confidence ?? null,
        risky: decision?.risky ?? null,
        ran: canonicalModel(ran),
        would: canonicalModel(current),
        outcome,
        why,
        policy: reason,
        judge: text.slice(0, 2000),
        judgeMs: Math.round(ms),
      }).catch(() => undefined)
    }
    let spawn = requestModel ? { ...e, model: requestModel } : e
    if (requestModel) {
      const tier = (['fast', 'balanced', 'deep'] as const).find(name => activePolicy.requestTiers?.[name] === requestModel)
      if (tier) {
        const role = tier === 'fast' ? 'light' : tier === 'balanced' ? 'standard' : 'hard'
        const candidates = await $.mods.modelCandidates({ role, fallback: activePolicy.tiers[tier] }).catch(() => [])
        const pick = `mr-${(await $.clock.now()).toString(36)}-${(++workerFallbackSequence).toString(36)}`
        const marker = workerFallbackLine(pick, requestModel, candidates)
        if (marker) spawn = { ...spawn, prompt: `${marker}\n${e.prompt}` }
      }
    }
    const result = await next(spawn)

    await log($, `${e.subagentType}${task}: ${model ? `${current} -> ${model}` : `kept ${current}`}: ${reason}`)
    if (logDecisions) {
      $.ui.log(`[${NAME}] ${e.subagentType} ${model ? `-> ${model}` : `kept ${current}`}: ${reason}`)
      $.ui.status(`router · ${e.subagentType} → ${canonicalModel(ran)}`)
    }

    if (cardId && (result.deny !== undefined || !result.agentId)) {
      await setCard($, cardId, { phase: result.deny !== undefined ? 'failed' : 'done' }).catch(() => undefined)
    }
    if (cardId && result.deny === undefined && result.agentId) cardOf.set(result.agentId, cardId)

    // Only a started subagent with an id can be priced when its run ends.
    if (result.deny === undefined && result.agentId && decision) {
      const toolUseId = e.workflow
        ? `${e.tool_use_id || `wf:${e.workflow.runId}`}#${e.workflow.agentIndex}`
        : e.tool_use_id || null
      picks.set(result.agentId, {
        toolUseId,
        subagentType: e.subagentType,
        description: e.description,
        replaced: current,
        model: ran,
        changed: Boolean(model),
        reason,
        decision: said,
        router,
        helper,
        steps: [],
        cardId,
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await ready($)
    if (off) return next(e)
    await first($, e.agentId ? 'turn.complete:agent' : 'turn.complete:main', e.agentId ?? 'main')

    if (!e.agentId) {
      // An effort change can throw the message cache away: log cache_read for
      // the turn before it and the turn it ran in.
      const read = e.usage ? e.usage.cache_read_input_tokens : null
      if (effortChange && effortChange.turnId === e.turnId) {
        await log($, `effort -> ${effortChange.to}: cache_read before ${effortChange.before ?? 'unknown'}, after ${read ?? 'unknown'}`)
        effortChange = null
      }
      lastMainCacheRead = read
      return next(e)
    }

    const cardId = cardOf.get(e.agentId)
    if (cardId) {
      cardOf.delete(e.agentId)
      // A run with no ledger line (no judge answer) ends here; a priced one ends in writeLedger.
      if (!picks.has(e.agentId)) await setCard($, cardId, { phase: e.reason === 'answer' ? 'done' : 'failed' }).catch(() => undefined)
    }
    const pick = picks.get(e.agentId)
    if (pick) {
      // One line per pick: a resumed run of the same agent is not counted again.
      picks.delete(e.agentId)
      void writeLedger($, e.agentId, pick, e.usage ?? null).catch(err => log($, `ledger: ${String(err)}`))
    }
    return next(e)
  })
}
