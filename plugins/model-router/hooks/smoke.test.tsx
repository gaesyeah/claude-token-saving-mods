import { expect } from 'claude-code/testing'
import { test } from './mods-stub'
import { modelForRequest } from './model-router'
import { route } from './policy.ts'

test('the module loads and /model-router shows the local judge line', async ($, on) => {
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  for (const ev of ['command.register', 'store.set', 'ui.status', 'ui.invalidate', 'state.set', 'clock.every']) on(ev, () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: null, version: 1 } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('clock.now', () => ({ value: 0 }))
  on('mods.judgeLine', (_: any, e: any) => ({ value: `Local judge: learning, 0/30 examples from ${e.paid}'s answers` }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  const r = (await $.command.run({ command: 'model-router', args: '' } as any)) as any
  expect(r.text).toContain("Local judge: learning, 0/30 examples from Haiku's answers")
})

test('provider-qualifies Ripple models but leaves fallback aliases unchanged', () => {
  expect(modelForRequest({ model: 'qwen2.5:3b', provider: 'ollama-local', source: 'clauderipple' })).toBe('ollama-local:qwen2.5:3b')
  expect(modelForRequest({ model: 'ollama-local:qwen2.5:3b', provider: 'ollama-local', source: 'clauderipple' })).toBe('ollama-local:qwen2.5:3b')
  expect(modelForRequest({ model: 'claude-haiku-5-5', provider: null, source: 'fallback' })).toBe('claude-haiku-5-5')
})

test('keeps raw tier IDs for accounting and returns provider-qualified IDs for agent requests', () => {
  const result = route(
    { tier: 'fast', confidence: 1, risky: null, effort: null, effortConfidence: null },
    { model: 'balanced-model' },
    {
      tiers: { fast: 'fast-model', balanced: 'balanced-model', deep: 'deep-model' },
      requestTiers: { fast: 'ollama-local:fast-model', balanced: 'balanced-model', deep: 'deep-model' },
      minUpgradeConfidence: 0.7,
      minDowngradeConfidence: 0.9,
    },
  )
  expect(result.model).toBe('fast-model')
  expect(result.requestModel).toBe('ollama-local:fast-model')
})
