import { expect } from 'claude-code/testing'
import { test } from './mods-stub'

// Host-level behavior: the plugin (not the test) owns $.state and $.model.fork.
// The time-based fork retry is tested by warm-policy.test.ts and the E2E script.
test('keep warm starts after a reply and stops when the person sends a prompt', async ($, on) => {
  const now = 300_000
  const state = new Map<string, any>([
    ['clock', { lastEnd: now, ttlMs: 300_000, ttlSource: 'default', tokens: 30_000, now, note: '' }],
  ])
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'warm-e2e' }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('state.get', (_: any, e: any) => ({ value: { value: state.get(e.key) ?? null, version: 1 } }))
  on('state.set', (_: any, e: any) => (state.set(e.key, e.value), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const reply = await $.command.run({ command: 'keepwarm', args: 'on' } as any) as any
  expect(reply.text).toContain('Keep warm is on')
  expect(state.get('warm')?.failures).toBe(0)
  await $.prompt.submit({ text: 'a new task', origin: { kind: 'composer' } } as any)
  for (let i = 0; i < 40; i++) await Promise.resolve()
  expect(state.get('warm')).toBe(null)
})
