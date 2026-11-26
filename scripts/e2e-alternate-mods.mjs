#!/usr/bin/env node
/**
 * Deterministic cross-module integration checks for the three optional mods.
 * Requires Node 22+ and --experimental-strip-types, no Claude account in --self-test.
 * --live also runs the real ClaudeRipple HTTPS-proxy E2E for the selected judge/worker
 * using the existing e2e-clauderipple-fallback.mjs (primary error injected).
 * Does NOT start Claude Desktop or execute the host agent.spawn/model.fork hooks.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { workerFallbackLine } from '../plugins/model-router/hooks/worker-fallback.ts'
import { warmFailure } from '../plugins/cache-clock/hooks/warm-policy.ts'

const ROOT = dirname(fileURLToPath(import.meta.url))
const suites = ['effort-optimizer', 'model-router', 'cache-clock']
const desired = process.argv.find(arg => arg.startsWith('--mod='))?.slice(6) ?? 'all'
const live = process.argv.includes('--live')
const allowRemote = process.argv.includes('--allow-remote')
if (process.argv.includes('--help') || ![...suites, 'all'].includes(desired)) {
  console.log('Usage: node --experimental-strip-types scripts/e2e-alternate-mods.mjs [--mod=effort-optimizer|model-router|cache-clock|all] [--live] [--allow-remote]')
  process.exit(process.argv.includes('--help') ? 0 : 2)
}

async function catalog() {
  const { normalizeModelCatalog } = await import('../plugins/mods-core/hooks/models.ts')
  return normalizeModelCatalog({
    agents: [{ name: 'gpt-luna', model: 'gpt-6-luna', provider: 'gpt', efforts: ['low'] }],
    providers: [{ name: 'gpt', usable: true }],
    models: [{ model: 'gpt-6-luna', provider: 'gpt' }],
    claudeLatest: { haiku: 'claude-haiku-5-5' }, claudeEfforts: ['low'],
  }, { settings: { rules: { general: { rungs: {
    light: [{ target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' }, { target: { agent: 'gpt-luna' }, effort: 'low' }],
  } } } } })
}

async function runJudge(name) {
  const { resolveModelCandidatesFromCatalog } = await import('../plugins/mods-core/hooks/models.ts')
  const { completeWithFallback } = await import('../plugins/mods-core/hooks/model-completion.ts')
  const candidates = resolveModelCandidatesFromCatalog(await catalog(), 'judge', 'haiku')
  assert.deepEqual(candidates.map(c => c.model), ['claude-haiku-5-5', 'gpt-6-luna'])
  const calls = []
  const done = await completeWithFallback({ candidates, request: { prompt: name === 'effort-optimizer' ? 'classify effort' : 'classify model tier' }, complete: async request => {
    calls.push(request.model)
    if (calls.length === 1) return { isAnswered: false, reason: 'api-error', status: 429 }
    return { isAnswered: true, text: name === 'effort-optimizer' ? '{"level":"high","why":"test"}' : '{"tier":"deep","confidence":1,"risky":0,"effort":2,"effort_confidence":1}' }
  } })
  assert.equal(done.model, 'gpt-6-luna')
  assert.equal(done.attempts.length, 2)
  assert.deepEqual(calls, ['claude-haiku-5-5', 'gpt:gpt-6-luna'])
  assert.equal(JSON.parse(done.result.text)[name === 'effort-optimizer' ? 'level' : 'tier'], name === 'effort-optimizer' ? 'high' : 'deep')
  console.log(`PASS ${name}: configured judge -> injected 429 -> GPT response parsed`)
}

async function runAgent() {
  const { resolveModelCandidatesFromCatalog } = await import('../plugins/mods-core/hooks/models.ts')
  const candidates = resolveModelCandidatesFromCatalog(await catalog(), 'light', 'haiku')
  const marker = workerFallbackLine('mr-contract-1', 'claude-haiku-5-5', candidates)
  assert.ok(marker)
  const encoded = /^<!-- clauderipple-ladder (\S+) -->$/.exec(marker)?.[1]
  assert.ok(encoded)
  const payload = JSON.parse(decodeURIComponent(encoded))
  assert.deepEqual(payload, { pick: 'mr-contract-1', model: 'claude-haiku-5-5', fallbacks: ['gpt:gpt-6-luna@low'] })
  assert.equal(workerFallbackLine('mr-invalid', 'claude-opus-5-5', candidates), null)
  assert.equal(workerFallbackLine('mr-no-ripple', 'haiku', [{ model: 'haiku', provider: null, source: 'fallback' }]), null)
  console.log('PASS model-router: configured worker -> proxy ladder metadata -> eligible fallback')
}

function runClock() {
  let failures = 0
  let now = 1_000
  for (let i = 1; i <= 3; i++) {
    const state = warmFailure(failures, now)
    assert.equal(state.failures, i)
    assert.equal(state.retryAt, now + 20_000)
    assert.equal(state.stop, i === 3)
    failures = state.failures
    now = state.retryAt
  }
  // This check is only a source-level guard: the host hook test verifies the real fork.
  const src = readFileSync(join(ROOT, '..', 'plugins', 'cache-clock', 'hooks', 'register.tsx'), 'utf8')
  assert.match(src, /\$\.model\.fork\(\{ prompt: PING_PROMPT \}\)/)
  assert.doesNotMatch(src, /\$\.mods\.modelComplete/)
  console.log('PASS cache-clock: same-conversation fork preserved; 20 s retry; stop at 3 failures')
}

async function main() {
  for (const suite of (desired === 'all' ? suites : [desired])) {
    if (suite !== 'cache-clock') await runJudge(suite)
    if (suite === 'model-router') await runAgent()
    if (suite === 'cache-clock') runClock()
  }
  if (!live) {
    console.log('PASS: deterministic integrations. For a live proxy request add --live [--allow-remote].')
    console.log('Scope: the Claude Code host hook tests (*.test.tsx) are separate and must run in that host environment.')
    return
  }
  const roles = desired === 'all' ? ['judge', 'light'] : desired === 'cache-clock' ? [] : [desired === 'model-router' ? 'light' : 'judge']
  if (!roles.length) {
    console.log('cache-clock has no model-switching proxy E2E: run its keepwarm host test and /keepwarm in a real Claude session.')
    return
  }
  for (const role of roles) {
    const args = ['--experimental-strip-types', join(ROOT, 'e2e-clauderipple-fallback.mjs'), `--role=${role}`, ...(allowRemote ? ['--allow-remote'] : [])]
    execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 180_000 })
  }
}
main().catch(error => { console.error('FAIL:', String(error?.message ?? error).slice(0, 600)); process.exitCode = 1 })
