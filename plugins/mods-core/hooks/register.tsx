import type { Register } from 'claude-code'
import { afterSample, decide, EMBED, freshStats, hash, isQmdHealth, judgeLine, MIN_EXAMPLES, QMD_URL, rerankOf, SAMPLE_EVERY } from './qmd'

// Mods Core: what the token-saving mods share.
// 1. The band above the prompt: each mod draws its own row, and this stacks them with a subtle rule
//    between two rows (never above the first) and nothing else between them, so the rows read as
//    separate and evenly spaced.
// 2. $.mods: the helpers every mod used to copy (paths, the /mods switches, logs, shell, the savings
//    ledger, opening a file). A mod lists "mods-core" under dependencies to get it.
// 3. $.mods.qmd*: qmd and its daemon (localhost:8181), for the vault's search and Local Models.
//    $.mods.judge*: the local judge of Effort Optimizer and Model Router: it answers like the paid judge
//    did for prompts much like this one, from examples kept in a qmd collection, and samples itself.

// Dark enough to stay quiet on a dark theme, light enough to show on a light one.
const RULE = '#3f3f46'
// Opens a file or link: xdg-open (most Linux desktops), gio (GNOME), open (macOS).
const OPEN_SH = 'for c in xdg-open gio open; do command -v "$c" >/dev/null 2>&1 || continue; if [ "$c" = gio ]; then gio open "$1"; else "$c" "$1"; fi </dev/null >/dev/null 2>&1; exit $?; done; echo "no opener (xdg-open, gio or open)" >&2; exit 3'
const APPEND_SH = 'mkdir -p "$(dirname "$1")" && cat >> "$1"'

export const register: Register = on => {
  on('engine.create', async ($, e, next) => {
    const beneath = await next(e)
    const clean = (v: string | undefined) => (v ?? '').trim()
    const root = beneath.plugin.root
    const fwd = (p: string, windows: boolean) => {
      let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
      if (windows) s = s.replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toUpperCase()}:/`).replace(/^([a-z]):\//, (_, d: string) => `${d.toUpperCase()}:/`)
      return s
    }
    const paths = async () => {
      const windows = (clean(await beneath.env.get('OS').catch(() => undefined))) === 'Windows_NT'
      const profile = clean(await beneath.env.get('USERPROFILE').catch(() => undefined))
      const unix = clean(await beneath.env.get('HOME').catch(() => undefined))
      const pick = windows ? profile || unix : unix || profile
      // The plugin's own path is the last resort: a pack installed from ~/Downloads is not under ~/.claude.
      const home = pick ? fwd(pick, windows) : (root.replace(/\\/g, '/').split('/.claude/')[0] ?? '')
      const set = clean(await beneath.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))
      const full = set === '~' ? home : set.startsWith('~/') || set.startsWith('~\\') ? `${home}${set.slice(1)}` : set
      return { home, claudeDir: full ? fwd(full, windows) : `${home}/.claude` }
    }
    const sh = (script: string, args: string[] = [], timeoutMs = 15_000) => beneath.process.run(['/bin/sh', '-c', script, 'sh', ...args], { timeoutMs })
    const append = async (path: string, text: string) => {
      const r = await beneath.process.run(['/bin/sh', '-c', APPEND_SH, 'sh', path], { stdin: text, timeoutMs: 10_000 })
      if (r.exitCode !== 0) throw new Error(`append to ${path} failed: ${r.stderr.slice(0, 200)}`)
    }
    // The desktop app's PATH can miss the folders npm, Volta and bun install into.
    let qmd: string | null = null
    const qmdFind = async ({ fresh }: { fresh?: boolean } = {}) => {
      if (qmd !== null && !fresh) return qmd
      const r = await sh(
        'command -v qmd && exit 0; for p in "$HOME/.volta/bin/qmd" "$HOME/.bun/bin/qmd" "$HOME/.npm-global/bin/qmd" "$HOME/.local/bin/qmd" "/usr/local/bin/qmd"; do [ -x "$p" ] && echo "$p" && exit 0; done; exit 1',
      ).catch(() => undefined)
      qmd = r && r.exitCode === 0 ? (r.stdout.split('\n')[0] ?? '').trim() : ''
      return qmd
    }
    const within = async <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
      const box: { timer?: { cancel: () => void } } = {}
      const late = new Promise<never>((_, reject) => {
        box.timer = beneath.clock.after(ms, () => reject(new Error(`${what} gave no answer in ${ms} ms`)))
      })
      try {
        return await Promise.race([p, late])
      } finally {
        box.timer?.cancel()
      }
    }
    const qmdUp = async () => {
      const r = await within(beneath.http.fetch(`${QMD_URL}/health`), 1000, 'qmd health').catch(() => undefined)
      return Boolean(r?.ok && isQmdHealth(r.text))
    }
    // One vector search, reranked; three candidates keep every vector rank at 3 or under, where
    // rerankOf holds (more give rerank 0).
    const qmdQuery = async ({ collection, text, limit, ms = 2500 }: { collection: string; text: string; limit: number; ms?: number }) => {
      const body = JSON.stringify({ searches: [{ type: 'vec', query: text.replace(/\s+/g, ' ').slice(0, 500) }], collections: [collection], limit, rerank: true, candidateLimit: Math.max(3, limit) })
      const res = await within(beneath.http.fetch(`${QMD_URL}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), ms, 'qmd')
      if (!res.ok) throw new Error(`qmd HTTP ${res.status}: ${res.text.slice(0, 200)}`)
      return ((JSON.parse(res.text) as { results?: Record<string, unknown>[] }).results ?? []).slice(0, limit).map(row => ({
        file: decodeURIComponent(String(row.file ?? '').replace(/^qmd:\/\/[^/]+\//, '')),
        title: String(row.title ?? ''),
        snippet: String(row.snippet ?? ''),
        rerank: limit <= 3 ? rerankOf(typeof row.score === 'number' ? row.score : 0) : 0,
      }))
    }
    const env = { QMD_EMBED_MODEL: EMBED }
    // Judges: a collection's examples counted once, its index refreshed at most once a minute.
    const counts = new Map<string, number>()
    const ready = new Set<string>()
    const embeddedAt = new Map<string, number>()
    const examples = async (dir: string) => {
      if (!counts.has(dir)) counts.set(dir, (await beneath.fs.list(dir).catch(() => [])).filter(f => f.name.endsWith('.md')).length)
      return counts.get(dir) ?? 0
    }
    const stats = async (collection: string) => freshStats((await beneath.store.get(`judge:${collection}`).catch(() => undefined)) as never)
    const keep = (collection: string, s: ReturnType<typeof freshStats>) => beneath.store.set(`judge:${collection}`, s).catch(() => undefined)
    return {
      ...beneath,
      mods: {
        paths,
        switches: async () => {
          try {
            const path = `${(await paths()).claudeDir}/mods/switches.json`
            return (await beneath.fs.exists(path)) ? (JSON.parse(String(await beneath.fs.read(path))) as Record<string, unknown>) : {}
          } catch {
            return {}
          }
        },
        log: async ({ file, line }: { file: string; line: string }) => {
          const at = new Date(await beneath.clock.now()).toISOString()
          await append(`${(await paths()).claudeDir}/mods-logs/${file}`, `${at} ${line}\n`).catch(() => undefined)
        },
        append: ({ path, text }: { path: string; text: string }) => append(path, text),
        sh: ({ script, args, timeoutMs }: { script: string; args?: string[]; timeoutMs?: number }) => sh(script, args, timeoutMs),
        ledger: async ({ row }: { row: Record<string, unknown> }) => append(`${(await paths()).claudeDir}/mods-logs/savings.jsonl`, `${JSON.stringify(row)}\n`),
        open: async ({ target }: { target: string }) => (await sh(OPEN_SH, [target], 10_000).catch(() => ({ exitCode: 1 }))).exitCode === 0,
        qmdFind,
        qmdUp: () => qmdUp(),
        qmdQuery,
        // Started detached: it outlives the chat and serves every chat after it. Its PID, so a mod stops
        // only a daemon it started itself.
        qmdStart: async () => {
          if (!(await qmdFind()) || (await qmdUp())) return { pid: '', out: '' }
          const r = await sh('QMD_EMBED_MODEL="$2" "$1" mcp --http --daemon < /dev/null 2>&1', [qmd!, EMBED], 20_000)
          return { pid: r.stdout.match(/\(PID (\d+)\)/)?.[1] ?? '', out: r.stdout.replace(/\s+/g, ' ').slice(0, 160) }
        },
        // Only when qmd's pidfile still names that PID.
        qmdStop: async ({ pid }: { pid: string }) => {
          if (!pid || !(await qmdFind())) return 'none'
          const r = await sh('f="${XDG_CACHE_HOME:-$HOME/.cache}/qmd/mcp.pid"; [ "$(cat "$f" 2>/dev/null)" = "$2" ] || exit 3; "$1" mcp stop', [qmd!, pid])
          return r.exitCode === 3 ? 'other' : 'stopped'
        },
        // The nearest examples' label, or null when they are too few, too far, disagree, or qmd is not up.
        judgeGuess: async ({ collection, dir, labels, text }: { collection: string; dir: string; labels: string[]; text: string }) => {
          if ((await stats(collection)).stopped || (await examples(dir)) < MIN_EXAMPLES || !(await qmdFind()) || !(await qmdUp())) return null
          const rows = await qmdQuery({ collection, text, limit: 3 })
          const d = decide(rows.map(r => ({ name: r.file.split('/').pop() ?? '', rerank: r.rerank })), labels)
          return d ? { label: d.label, file: `${dir}/${d.name}`, n: d.n, score: d.score } : null
        },
        // Keeps a paid answer as an example (`extra` beside it as <hash>.json), then refreshes the index in
        // the background, once a minute at most.
        judgeRemember: async ({ collection, dir, labels, text, label, extra }: { collection: string; dir: string; labels: string[]; text: string; label: string; extra?: string }) => {
          if (!labels.includes(label) || !(await qmdFind())) return
          const name = hash(text)
          await beneath.process.run(['mkdir', '-p', dir])
          for (const l of labels) if (l !== label) await beneath.process.run(['rm', '-f', `${dir}/${l}--${name}.md`])
          await beneath.fs.write(`${dir}/${label}--${name}.md`, `${text.slice(0, 2000)}\n`)
          if (extra !== undefined) await beneath.fs.write(`${dir}/${name}.json`, extra)
          counts.delete(dir)
          if (!ready.has(collection)) {
            const list = await beneath.process.run([qmd!, 'collection', 'list'], { timeoutMs: 15_000, env }).catch(() => undefined)
            if (!list || !new RegExp(`\\b${collection}\\b`).test(list.stdout)) await beneath.process.run([qmd!, 'collection', 'add', dir, '--name', collection, '--mask', '**/*.md'], { timeoutMs: 60_000, env })
            ready.add(collection)
          }
          const now = await beneath.clock.now()
          if (now - (embeddedAt.get(collection) ?? 0) < 60_000) return
          embeddedAt.set(collection, now)
          await sh('(QMD_EMBED_MODEL="$2" nice "$1" update && QMD_EMBED_MODEL="$2" nice "$1" embed) > /dev/null 2>&1 < /dev/null &', [qmd!, EMBED])
        },
        // Counts a local answer; true when this one should also go to the paid judge.
        judgeUsed: async ({ collection }: { collection: string }) => {
          const s = await stats(collection)
          await keep(collection, { ...s, local: s.local + 1 })
          return (s.local + 1) % SAMPLE_EVERY === 0
        },
        // A sample's outcome; true when it stopped the local judge.
        judgeSampled: async ({ collection, agreed }: { collection: string; agreed: boolean }) => {
          const s = afterSample(await stats(collection), agreed)
          await keep(collection, s)
          return s.stopped
        },
        judgeReset: async ({ collection }: { collection: string }) => {
          await keep(collection, { ...(await stats(collection)), recent: [], stopped: false })
        },
        judgeLine: async ({ collection, dir, paid }: { collection: string; dir: string; paid: string }) => judgeLine(await stats(collection), await examples(dir), paid),
      },
    }
  })

  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const rows = e.props.rows
    if (rows.length < 2) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // One cell short of the box: a rule its full width wraps or ends in an ellipsis.
    const rule = '─'.repeat(Math.max(8, e.props.bodyColumns - 1))
    return (
      <Box flexDirection="column">
        {rows.map((r, i) => (
          <Box key={`row-${r.plugin}`} flexDirection="column">
            {i > 0 ? (
              <Text color={RULE} wrap="truncate">
                {rule}
              </Text>
            ) : null}
            {r.tree}
          </Box>
        ))}
      </Box>
    )
  })
}
