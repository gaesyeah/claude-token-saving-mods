import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'cache-clock',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } },
} as const

test('the band starts minimized and toggles', async ($, on) => {
  const now = Date.now()
  on('state.get', (_, e: any) => ({
    value: e.key === 'clock'
      ? { value: { lastEnd: now - 60_000, ttlMs: 3_600_000, ttlSource: 'detected', tokens: 163_000, now, note: '' }, version: 1 }
      : { value: null, version: 1 },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test' }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect((await ui.find({ key: 'expand' }))?.props.label).toBe('▾ Expand')
  expect(await ui.find({ key: 'keepwarm' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Cache warm/ })).toBeDefined()
  await ui.press({ key: 'expand' })
  expect((await ui.find({ key: 'expand' }))?.props.label).toBe('▴ Minimize')
  expect(await ui.find({ key: 'keepwarm' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^1 hour cache/ }))?.text).toBe("1 hour cache, as Anthropic's last reply set it. Reply now and 163k tokens cost 5 to 10% as much.")
  expect((await ui.find({ type: 'Text', text: /Cache warm/ }))?.text).not.toContain('Reply now')
  await ui.press({ key: 'expand' })
  expect((await ui.find({ key: 'expand' }))?.props.label).toBe('▾ Expand')
  await ui.unmount()
})
