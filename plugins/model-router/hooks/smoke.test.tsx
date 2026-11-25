import { expect } from 'claude-code/testing'
import { test } from './mods-stub'

test('the module loads and /model-router shows the local judge line', async ($, on) => {
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  for (const ev of ['command.register', 'store.set', 'ui.status', 'ui.invalidate', 'state.set']) on(ev, () => ({ value: undefined }))
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
