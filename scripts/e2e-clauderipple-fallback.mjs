#!/usr/bin/env node
/**
 * Live fallback smoke test: real ClaudeRipple catalogue -> real mods-core candidate
 * resolver and completion retry -> real ClaudeRipple HTTPS proxy -> chosen provider.
 *
 * The first failure is deliberately injected as an API-error/429 equivalent so the
 * test remains deterministic and does NOT call Claude or depend on its quota.
 * The second call is live. No user prompts, keys or credentials are logged.
 *
 * Run with Node >=22 and --experimental-strip-types. The helper transport reuses
 * e2e-clauderipple-proxy.py (Python stdlib + installed Ripple CA settings).
 * It does NOT invoke the Claude Code plugin engine's $.mods.modelComplete hook;
 * that host-level boundary is covered by plugin tests and needs manual QA.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { completeWithFallback, requestModel } from '../plugins/mods-core/hooks/model-completion.ts'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isSelfTest = process.argv.includes('--self-test')
const role = process.argv.find(arg => arg.startsWith('--role='))?.slice(7) ?? 'light'
if (!['judge', 'light'].includes(role)) throw new Error('Unknown role: expected judge or light')
const allowRemote = process.argv.includes('--allow-remote')
const help = process.argv.includes('--help') || process.argv.includes('-h')
const PROMPT = 'Reply with a short acknowledgement of the ClaudeRipple fallback test.'

if (help) {
  console.log(`Usage: node --experimental-strip-types scripts/e2e-clauderipple-fallback.mjs [--allow-remote | --self-test]\n\nDefault: refuse paid/subscription targets unless they are an Ollama provider.\n--allow-remote: permit one live request to the second configured worker (e.g. GPT).\n--self-test: test the runtime and retry semantics without ClaudeRipple/network.\n\nThe first candidate always receives an injected api-error (as an exhausted Claude\nmodel would). The second is a real request via the existing Ripple proxy E2E helper.\nThis is a core+proxy E2E, not a full Claude Desktop hook E2E.`)
  process.exit(0)
}

const pythonBridge = String.raw`
import importlib.util
import json
import sys
from pathlib import Path

script, provider, model, prompt = sys.argv[1:5]
spec = importlib.util.spec_from_file_location('ripple_proxy_smoke', script)
if spec is None or spec.loader is None:
    raise RuntimeError('cannot load existing Ripple proxy smoke test')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.PROMPT = prompt
home = Path(__import__('os').environ.get('CLAUDERIPPLE_HOME', str(Path.home() / '.clauderipple'))).expanduser()
proxy, ca_file = module.load_proxy_settings()
old_ids = module.request_log_ids(home)
response = module.proxy_request(proxy, ca_file, provider, model)
blocks = response.get('content', [])
text = ' '.join(x.get('text', '') for x in blocks if isinstance(x, dict) and x.get('type') == 'text' and isinstance(x.get('text'), str)) if isinstance(blocks, list) else ''
if not text.strip():
    module.fail('the live secondary model returned no text')
log = module.check_request_log(home, provider, old_ids)
if log is None:
    module.fail('live model answered, but no new successful provider row was found in Ripple request logs')
raw = model.rsplit('@', 1)[0]
target = log.get('target')
if isinstance(target, str) and target and target not in (raw, f'{provider}:{raw}'):
    module.fail(f'log target differs from requested fallback model: {target!r} versus {raw!r}')
message_id = response.get('id')
logged_message_id = log.get('messageId')
if message_id and logged_message_id and str(message_id) != str(logged_message_id):
    module.fail('new log entry was not from this response (messageId mismatch)')
print(json.dumps({
    'isAnswered': True,
    'text': text,
    'usage': response.get('usage') if isinstance(response.get('usage'), dict) else None,
    'proxy': {'provider': log.get('provider'), 'target': target, 'status': log.get('status'), 'requestId': str(log.get('id', ''))},
}))
`

async function selfTest() {
  const candidates = [
    { model: 'claude-haiku-5-5', provider: null, effort: 'low', source: 'clauderipple' },
    { model: 'gpt-6-luna', provider: 'assinatura-do-chatgpt', effort: 'low', source: 'clauderipple' },
  ]
  const seen = []
  const attempts = []
  const done = await completeWithFallback({
    candidates,
    request: { prompt: PROMPT },
    complete: async request => {
      seen.push(request.model)
      return seen.length === 1 ? { isAnswered: false, reason: 'api-error' } : { isAnswered: true, text: 'OK' }
    },
    onAttempt: async attempt => attempts.push(attempt.model),
  })
  assert.equal(done.model, 'gpt-6-luna')
  assert.equal(done.result.isAnswered, true)
  assert.deepEqual(seen, ['claude-haiku-5-5', 'assinatura-do-chatgpt:gpt-6-luna'])
  assert.deepEqual(attempts, ['claude-haiku-5-5', 'gpt-6-luna'])
  assert.equal(requestModel(candidates[1]), seen[1])
  // Non-recoverable errors must not trigger a second model request.
  let invalidCalls = 0
  const denied = await completeWithFallback({ candidates, request: { prompt: PROMPT }, complete: async () => {
    invalidCalls++
    return { isAnswered: false, reason: 'invalid-request' }
  } })
  assert.equal(invalidCalls, 1)
  assert.equal(denied.result.reason, 'invalid-request')
  // Retryable thrown provider errors also select the next candidate.
  let thrownCalls = 0
  const recovered = await completeWithFallback({ candidates, request: { prompt: PROMPT }, complete: async () => {
    thrownCalls++
    if (thrownCalls === 1) throw new Error('429 rate_limit_error')
    return { isAnswered: true, text: 'OK' }
  } })
  assert.equal(thrownCalls, 2)
  assert.equal(recovered.model, 'gpt-6-luna')
  console.log('PASS: local fallback test (API error, 429 exception, request qualification, non-retryable error, accounting callback).')
}

async function main() {
  if (isSelfTest) return selfTest()
  if (process.argv.some(x => x.startsWith('-') && x !== '--allow-remote' && x !== '--role=judge' && x !== '--role=light')) throw new Error('Unknown option. See --help.')

  const home = process.env.CLAUDERIPPLE_HOME ? resolve(process.env.CLAUDERIPPLE_HOME.replace(/^~(?=\/|$)/, homedir())) : join(homedir(), '.clauderipple')
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  const port = Number(config?.admin?.port ?? (Number.isInteger(config?.listen?.port) ? config.listen.port + 1 : NaN))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid ClaudeRipple admin port')
  const api = `http://127.0.0.1:${port}`
  async function getJson(route) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const response = await fetch(api + route, { signal: controller.signal })
      if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`)
      return await response.json()
    } finally { clearTimeout(timer) }
  }
  const [options, settings] = await Promise.all([getJson('/api/mod-options'), getJson('/api/mod-settings')])
  const { normalizeModelCatalog, resolveModelCandidatesFromCatalog } = await import('../plugins/mods-core/hooks/models.ts')
  const catalog = normalizeModelCatalog(options, settings)
  if (!catalog) throw new Error('ClaudeRipple model catalogue is unavailable or malformed')
  const all = resolveModelCandidatesFromCatalog(catalog, role, 'haiku')
  const candidates = all.slice(0, 2)
  if (candidates.length < 2) throw new Error('Low worker needs at least two distinct available candidates (primary and fallback)')
  const [primary, secondary] = candidates
  if (primary.model === secondary.model && primary.provider === secondary.provider) throw new Error('Candidates are not distinct')
  if (!secondary.provider) {
    if (role !== 'judge' || !primary.provider) {
      throw new Error('The second candidate is native Claude: an unauthenticated proxy E2E cannot test that fallback safely')
    }
    const firstProvider = catalog.providers.find(p => p.name === primary.provider)
    if (!firstProvider?.usable) throw new Error('Configured judge provider is not usable')
    if (!/ollama/i.test(primary.provider) && !allowRemote) {
      throw new Error('Live judge provider may consume quota: rerun with --allow-remote')
    }
    const rawModel = primary.model.startsWith(`${primary.provider}:`) ? primary.model.slice(primary.provider.length + 1) : primary.model
    const requestedModel = `${rawModel}${primary.effort ? `@${primary.effort}` : ''}`
    const { stdout } = await execFileAsync('python3', ['-c', pythonBridge,
      join(ROOT, 'scripts', 'e2e-clauderipple-proxy.py'), primary.provider, requestedModel, PROMPT],
      { timeout: 125_000, maxBuffer: 32 * 1024 })
    const result = JSON.parse(stdout)
    assert.equal(result.isAnswered, true)
    assert.equal(result.proxy.provider, primary.provider)
    assert.equal(Number(result.proxy.status), 200)
    console.log(`PASS: configured judge provider ${primary.provider}/${primary.model} answered through the real Ripple proxy (HTTP 200).`)
    console.log('SKIP judge live failover: the next ordered candidate is native Claude, which requires a live authenticated Claude request.')
    console.log('Judge fallback logic is covered by unit tests and deterministic integration; no actual failover is claimed here.')
    return
  }
  const provider = catalog.providers.find(p => p.name === secondary.provider)
  if (!provider?.usable) throw new Error('The selected fallback provider is not currently usable')
  const isOllama = /ollama/i.test(secondary.provider)
  if (!isOllama && !allowRemote) {
    throw new Error(`Fallback ${secondary.provider}/${secondary.model} may consume remote quota. Rerun explicitly with --allow-remote.`)
  }
  // The bridge executes through the very same Ripple CONNECT transport verified
  // by scripts/e2e-clauderipple-proxy.py. Only selected candidate #2 is called.
  console.log(`Primary: ${primary.provider ?? 'native Claude'} / ${primary.model} (will inject API error; not contacted)`)
  console.log(`Fallback: ${secondary.provider} / ${secondary.model} (${provider.type ?? 'unknown provider type'})`)
  const seen = []
  const accounted = []
  const live = await completeWithFallback({
    candidates,
    request: { prompt: PROMPT, maxTokens: 64, timeoutMs: 90_000 },
    complete: async request => {
      seen.push(request.model)
      if (seen.length === 1) return { isAnswered: false, reason: 'api-error', usage: { input_tokens: 0, output_tokens: 0 } }
      const rawModel = secondary.model.startsWith(`${secondary.provider}:`) ? secondary.model.slice(secondary.provider.length + 1) : secondary.model
      const requestedModel = `${rawModel}${request.effort ? `@${request.effort}` : ''}`
      const bridgePath = join(ROOT, 'scripts', 'e2e-clauderipple-proxy.py')
      const { stdout } = await execFileAsync('python3', ['-c', pythonBridge, bridgePath, secondary.provider, requestedModel, PROMPT], { timeout: 125_000, maxBuffer: 32 * 1024 })
      return JSON.parse(stdout)
    },
    onAttempt: async attempt => accounted.push(attempt.model),
  })
  assert.equal(live.model, secondary.model, 'The fallback did not select the second configured candidate')
  assert.equal(live.result.isAnswered, true, 'The fallback model did not answer')
  assert.equal(live.attempts.length, 2, 'The runner must attempt exactly two models')
  assert.equal(seen[0], requestModel(primary), 'Incorrect first model')
  assert.equal(seen[1], requestModel(secondary), 'Incorrect second model/provider')
  assert.deepEqual(accounted, [primary.model, secondary.model])
  assert.equal(live.result.proxy.provider, secondary.provider)
  assert.equal(Number(live.result.proxy.status), 200)
  console.log(`Live fallback proxy: HTTP 200, provider=${live.result.proxy.provider}, model=${live.result.proxy.target ?? secondary.model}`)
  console.log(`Routed requests: ${seen.join(' -> ')}`)
  console.log('PASS: actual mods-core failover algorithm -> ClaudeRipple HTTPS proxy -> configured second provider -> verified request log.')
  console.log('Scope: primary 429 is injected; actual Claude subscription exhaustion and Claude Desktop hook registration are NOT exercised.')
}

main().catch(error => { console.error('FAIL:', String(error?.message ?? error).slice(0, 600)); process.exitCode = 1 })
