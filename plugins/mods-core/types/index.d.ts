/** What a shell command answered. */
export type ModsRun = { exitCode: number; stdout: string; stderr: string }

/** Where Claude Code keeps its files on this machine. */
export type ModsPaths = {
  /** The person's home folder, with forward slashes. */
  home: string
  /** CLAUDE_CONFIG_DIR when it is set, else `<home>/.claude`. */
  claudeDir: string
}

/** The helpers the token-saving mods share, on `$.mods`. Each takes one object, as every `$` call does. */
export type Mods = {
  /** The home folder and Claude's config folder, read from the environment. */
  paths(): Promise<ModsPaths>
  /** switches.json, `{}` when there is none; throws when it is there but unreadable, so a mod can keep its last state. */
  readSwitches(): Promise<Record<string, unknown>>
  /** Sets keys in switches.json (`null` removes one), keeping the rest; throws when it cannot. */
  writeSwitches(input: { set: Record<string, unknown> }): Promise<void>
  /** The /mods switchboard's `switches.json`: `{ "<mod>": false }` turns a mod off; `{}` when there is none or it is unreadable. */
  switches(): Promise<Record<string, unknown>>
  /** Appends one line, stamped with the time, to `~/.claude/mods-logs/<file>` (or a full path); past 2 MB the file keeps its last 1 MB. Never throws. */
  log(input: { file: string; line: string }): Promise<void>
  /** Appends text to a file, making its folder; a true append, so two chats can share the file. */
  append(input: { path: string; text: string }): Promise<void>
  /** Runs a /bin/sh script with `$1`, `$2`… set to args. */
  sh(input: { script: string; args?: string[]; timeoutMs?: number }): Promise<ModsRun>
  /** Adds one row to `~/.claude/mods-logs/savings.jsonl`, the ledger Savings Proof reads. */
  ledger(input: { row: Record<string, unknown> }): Promise<void>
  /** Opens a file or link with xdg-open, gio or open; false when none could. */
  open(input: { target: string }): Promise<boolean>

  /** True (and the request removed) when the /mods pane's Open button asked this chat for that mod's pane. */
  openAsked(input: { mod: string }): Promise<boolean>

  /** Whether a mod may open its pane now: `asked` (its command, /mods' Open) always may and clears a close; otherwise not after the person closed it in this chat, nor while /mods hides it. */
  paneAllowed(input: { mod: string; asked?: boolean }): Promise<boolean>
  /** The person closed a mod's pane in this chat. */
  paneClosed(input: { mod: string }): Promise<void>

  /** The shared list-price table, per million tokens; `pattern` is a case-insensitive RegExp source, tried in order. */
  prices(): Promise<ModsPrice[]>

  /** A mod reports one model call it made (the call's `usage` as the engine answered it). */
  spent(input: { mod: string; model: string; usage: ModsUsage }): Promise<void>
  /** Today's and the last 7 days' spend on the mods' own model calls, one row per mod and model, the dearest first. */
  spend(): Promise<{ today: ModsSpendRow[]; week: ModsSpendRow[] }>

  /** qmd's path, '' when it is not installed; `fresh` looks again (after an install). */
  qmdFind(input?: { fresh?: boolean }): Promise<string>
  /** Whether qmd's own daemon answers on localhost:8181. */
  qmdUp(): Promise<boolean>
  /** One vector search in a collection, reranked; `rerank` is the reranker's 0..1 relevance (0 past 3 results). Throws when qmd fails. */
  qmdQuery(input: { collection: string; text: string; limit: number; ms?: number }): Promise<ModsQmdRow[]>
  /** Starts the daemon unless it already runs; `pid` is '' when it did not start one. */
  qmdStart(): Promise<{ pid: string; out: string }>
  /** Stops the daemon with that PID, only while qmd's pidfile still names it. */
  qmdStop(input: { pid: string }): Promise<'stopped' | 'other' | 'none'>

  /** The local judge's answer from the nearest examples, or null. */
  judgeGuess(input: ModsJudge & { text: string }): Promise<ModsGuess | null>
  /** Keeps a paid answer as an example; `extra` is kept beside it as `<hash>.json`. */
  judgeRemember(input: ModsJudge & { text: string; label: string; extra?: string }): Promise<void>
  /** Counts a local answer; true when this one should also go to the paid judge. */
  judgeUsed(input: { collection: string }): Promise<boolean>
  /** A sample's outcome; true when too little agreement stopped the local judge. */
  judgeSampled(input: { collection: string; agreed: boolean }): Promise<boolean>
  /** Starts a stopped local judge again, its samples counted from zero. */
  judgeReset(input: { collection: string }): Promise<void>
  /** One line for a mod's status: local answers and how the samples went. */
  judgeLine(input: { collection: string; dir: string; paid: string }): Promise<string>
}

/** One qmd result: the file's path in its collection, its title, its snippet and the reranker's relevance. */
export type ModsQmdRow = { file: string; title: string; snippet: string; rerank: number }

/** A local judge: its qmd collection, the folder its examples live in, and the labels it answers with. */
export type ModsJudge = { collection: string; dir: string; labels: string[] }

/** A local answer: the label, the nearest example's file, how many close examples agreed, the nearest's relevance. */
export type ModsGuess = { label: string; file: string; n: number; score: number }

declare module 'claude-code' {
  interface EngineInterface {
    mods: Mods
  }
}

/** A model call's token counts, as `$.model.complete` answers them. */
export type ModsUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** One mod's spend on one model family: calls, tokens in (cache included) and out, and the list-price estimate in US$. */
export type ModsSpendRow = { mod: string; model: string; calls: number; in: number; out: number; usd: number }

/** One price card per million tokens: input, output, cache read, cache write for the 5-minute and the 1-hour TTL. */
export type ModsCard = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

/** A model's prices: which ids it covers (`pattern`), its family name, and its card (`large` for a prompt over 100K tokens). */
export type ModsPrice = { pattern: string; name: string; small: ModsCard; large?: ModsCard }
