import { expect } from 'claude-code/testing'
import { test } from './mods-stub'

const BIG = 'x'.repeat(4 * 3000) // ~3000 tokens
const SMALL = 'x'.repeat(4 * 100)

function engine(on: any, store: Map<string, unknown>, sid: { v: string }) {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sid.v }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('command.register', () => ({ value: { command: 'tool-diet' } }))
  on('command.run', () => ({ text: '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('tool.describe', (_: any, e: any) => ({ description: e.description }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', (_: any, e: any) => ({ turnId: e.turnId, text: '' }))
}

const TOOLS: [string, string][] = [
  ['Bash', BIG],
  ['Artifact', BIG],
  ['mcp__Claude_Browser__computer', BIG],
  ['mcp__visualize__show_widget', BIG],
  ['ListAgents', SMALL],
]

// One chat: describe every tool, then call the ones it uses. Returns the tools it moved.
async function chat($: any, uses: string[]) {
  const movedNow: string[] = []
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true } as any)
  for (const [tool, description] of TOOLS) {
    const r: any = await $.tool.describe({ tool, description, provider: { plugin: 'engine', tier: 'core' } } as any)
    if (r.isDeferred) movedNow.push(tool)
  }
  for (const tool of uses) await $.tool.call({ tool, tool_use_id: `u-${tool}` } as any)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
  return movedNow
}

test('after 3 chats of a project, big tools it never used move behind ToolSearch; work tools and used ones stay', async ($, on) => {
  const sid = { v: 'a' }
  engine(on, new Map(), sid)
  const run = (id: string, uses: string[]) => ((sid.v = id), chat($, uses))
  expect(await run('a', ['Bash'])).toEqual([])
  expect(await run('b', ['Bash', 'Artifact'])).toEqual([])
  expect(await run('c', ['Bash'])).toEqual([])
  // Browser + visualize: ~6000 tokens unused. Artifact was used, Bash never moves, ListAgents is small.
  expect(await run('d', [])).toEqual(['mcp__Claude_Browser__computer', 'mcp__visualize__show_widget'])
  const r: any = await $.command.run({ command: 'tool-diet', args: '' } as any)
  expect(r.text).toContain('~6000 tokens a menos por chat')
})

test('below 5k tokens nothing moves', async ($, on) => {
  const sid = { v: 'a' }
  engine(on, new Map(), sid)
  for (const id of ['a', 'b', 'c']) ((sid.v = id), await chat($, ['Bash', 'Artifact', 'mcp__Claude_Browser__computer']))
  sid.v = 'd'
  expect(await chat($, [])).toEqual([])
})
