import type { Register } from 'claude-code'
import { afterSample, decide, EMBED, freshStats, hash, isQmdHealth, judgeLine, MIN_EXAMPLES, QMD_URL, rerankOf, SAMPLE_EVERY } from './qmd'
import { addCall, type Day, dayKey, rowsOf, type Usage } from './spend'
import { PRICES } from './prices'

// Mods Core: what the token-saving mods share.
// 1. $.mods: the helpers every mod used to copy (paths, the /mods switches, logs, shell, the savings
//    ledger, opening a file). A mod lists "mods-core" under dependencies to get it.
// 2. $.mods.qmd*: qmd and its daemon (localhost:8181), for the vault's search and Local Models.
//    $.mods.judge*: the local judge of Effort Optimizer and Model Router: it answers like the paid judge
//    did for prompts much like this one, from examples kept in a qmd collection, and samples itself.
// 3. $.mods.spent / $.mods.spend: what each mod spends on its own model calls (Haiku, Sonnet), kept per
//    day for 14 days, for Quota Meter's pane.

// Opens a file or link: xdg-open (most Linux desktops), gio (GNOME), open (macOS).
const OPEN_SH = 'for c in xdg-open gio open; do command -v "$c" >/dev/null 2>&1 || continue; if [ "$c" = gio ]; then gio open "$1"; else "$c" "$1"; fi </dev/null >/dev/null 2>&1; exit $?; done; echo "no opener (xdg-open, gio or open)" >&2; exit 3'
const APPEND_SH = 'mkdir -p "$(dirname "$1")" && cat >> "$1"'
// Appends, then trims a log past 2 MB to its last 1 MB (whole lines).
const LOG_SH = `${APPEND_SH} && [ "$(wc -c < "$1")" -gt 2000000 ] && tail -c 1000000 "$1" | tail -n +2 > "$1.tmp" && mv "$1.tmp" "$1"; exit 0`

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
    // A true append through the shell; where the shell fails, read and write the whole file instead.
    let shellFailed = false
    const append = async (path: string, text: string) => {
      if (!shellFailed) {
        const r = await beneath.process.run(['/bin/sh', '-c', APPEND_SH, 'sh', path], { stdin: text, timeoutMs: 10_000 }).catch(() => undefined)
        if (r?.exitCode === 0) return
        shellFailed = true
      }
      const old = (await beneath.fs.exists(path)) ? String(await beneath.fs.read(path)) : ''
      await beneath.fs.write(path, old + text)
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
    // Panes the person closed in a chat ("<chat id>:<mod>"): a mod stops opening those by itself.
    const closedPanes = new Set<string>()
    const chatOf = async () => (await beneath.session.id().catch(() => '')) || 'chat'
    const stats = async (collection: string) => freshStats((await beneath.store.get(`judge:${collection}`).catch(() => undefined)) as never)
    const keep = (collection: string, s: ReturnType<typeof freshStats>) => beneath.store.set(`judge:${collection}`, s).catch(() => undefined)
    return {
      ...beneath,
      mods: {
        paths,
        // The /mods switchboard's switches.json: {} when there is none; throws when it is there but
        // unreadable, so a mod can keep what it had.
        readSwitches: async () => {
          const path = `${(await paths()).claudeDir}/mods/switches.json`
          if (!(await beneath.fs.exists(path))) return {}
          const json = JSON.parse(String(await beneath.fs.read(path))) as unknown
          return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
        },
        // Sets keys in switches.json (null removes one) and keeps the rest; throws when it cannot.
        writeSwitches: async ({ set }: { set: Record<string, unknown> }) => {
          const dir = `${(await paths()).claudeDir}/mods`
          const path = `${dir}/switches.json`
          const was = (await beneath.fs.exists(path)) ? (JSON.parse(String(await beneath.fs.read(path))) as Record<string, unknown>) : {}
          const json = { ...was }
          for (const [k, v] of Object.entries(set)) {
            if (v === null) delete json[k]
            else json[k] = v
          }
          await beneath.process.run(['mkdir', '-p', dir])
          await beneath.fs.write(path, `${JSON.stringify(json, null, 2)}\n`)
        },
        switches: async () => {
          try {
            const path = `${(await paths()).claudeDir}/mods/switches.json`
            return (await beneath.fs.exists(path)) ? (JSON.parse(String(await beneath.fs.read(path))) as Record<string, unknown>) : {}
          } catch {
            return {}
          }
        },
        // `file` under ~/.claude/mods-logs, or a full path; past 2 MB it keeps its last 1 MB.
        log: async ({ file, line }: { file: string; line: string }) => {
          const at = new Date(await beneath.clock.now()).toISOString()
          const path = file.startsWith('/') ? file : `${(await paths()).claudeDir}/mods-logs/${file}`
          await beneath.process
            .run(['/bin/sh', '-c', LOG_SH, 'sh', path], { stdin: `${at} ${line.endsWith('\n') ? line : `${line}\n`}`, timeoutMs: 10_000 })
            .catch(() => undefined)
        },
        append: ({ path, text }: { path: string; text: string }) => append(path, text),
        sh: ({ script, args, timeoutMs }: { script: string; args?: string[]; timeoutMs?: number }) => sh(script, args, timeoutMs),
        ledger: async ({ row }: { row: Record<string, unknown> }) => append(`${(await paths()).claudeDir}/mods-logs/savings.jsonl`, `${JSON.stringify(row)}\n`),
        open: async ({ target }: { target: string }) => (await sh(OPEN_SH, [target], 10_000).catch(() => ({ exitCode: 1 }))).exitCode === 0,
        // The /mods pane's Open button leaves ~/.claude/mods/.open-<mod>-<chat id>: true (and the file gone)
        // when it asked this chat for that mod's pane. Each mod opens its own pane; a mod can open only its own.
        openAsked: async ({ mod }: { mod: string }) => {
          const sid = await beneath.session.id().catch(() => '')
          if (!sid) return false
          const ask = `${(await paths()).claudeDir}/mods/.open-${mod}-${sid}`
          if (!(await beneath.fs.exists(ask).catch(() => false))) return false
          await beneath.process.run(['rm', '-f', ask]).catch(() => undefined)
          return true
        },
        // Whether a mod may open its pane now: asked (its command, /mods' Open) always may, and clears
        // a close; on its own, not after the person closed it in this chat, nor while /mods hides it.
        paneAllowed: async ({ mod, asked }: { mod: string; asked?: boolean }) => {
          const key = `${await chatOf()}:${mod}`
          if (asked) {
            closedPanes.delete(key)
            return true
          }
          if (closedPanes.has(key)) return false
          const path = `${(await paths()).claudeDir}/mods/switches.json`
          const json = (await beneath.fs.exists(path).catch(() => false)) ? (JSON.parse(String(await beneath.fs.read(path))) as Record<string, unknown>) : {}
          return json[`${mod}:hidden`] !== true
        },
        // The person closed a mod's pane (its ui.close with origin "person").
        paneClosed: async ({ mod }: { mod: string }) => {
          closedPanes.add(`${await chatOf()}:${mod}`)
        },
        // The shared list-price table: a mod copies it at chat start and looks models up in its copy.
        prices: async () => PRICES,
        // A mod reports each model call it made; kept per calendar day, the last 14.
        spent: async ({ mod, model, usage }: { mod: string; model: string; usage: Usage }) => {
          const now = await beneath.clock.now()
          const all = ((await beneath.store.get('spend').catch(() => undefined)) ?? {}) as Record<string, Day>
          const key = dayKey(now)
          const kept = Object.fromEntries(Object.entries(all).filter(([d]) => d >= dayKey(now - 13 * 86_400_000)))
          await beneath.store.set('spend', { ...kept, [key]: addCall(kept[key] ?? {}, mod, model, usage ?? {}) }).catch(() => undefined)
        },
        // Today's and the last 7 days' spend, one row per mod and model, the dearest first.
        spend: async () => {
          const now = await beneath.clock.now()
          const all = ((await beneath.store.get('spend').catch(() => undefined)) ?? {}) as Record<string, Day>
          const week = Object.entries(all).filter(([d]) => d >= dayKey(now - 6 * 86_400_000)).map(([, day]) => day)
          return { today: rowsOf([all[dayKey(now)] ?? {}]), week: rowsOf(week) }
        },
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
}
