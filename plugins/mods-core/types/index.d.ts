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
  /** The /mods switchboard's `switches.json`: `{ "<mod>": false }` turns a mod off; `{}` when there is none. */
  switches(): Promise<Record<string, unknown>>
  /** Appends one line, stamped with the time, to `~/.claude/mods-logs/<file>`. Never throws. */
  log(input: { file: string; line: string }): Promise<void>
  /** Appends text to a file, making its folder; a true append, so two chats can share the file. */
  append(input: { path: string; text: string }): Promise<void>
  /** Runs a /bin/sh script with `$1`, `$2`… set to args. */
  sh(input: { script: string; args?: string[]; timeoutMs?: number }): Promise<ModsRun>
  /** Adds one row to `~/.claude/mods-logs/savings.jsonl`, the ledger Savings Proof reads. */
  ledger(input: { row: Record<string, unknown> }): Promise<void>
  /** Opens a file or link with xdg-open, gio or open; false when none could. */
  open(input: { target: string }): Promise<boolean>

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
