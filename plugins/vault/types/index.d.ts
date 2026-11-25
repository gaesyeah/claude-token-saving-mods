/** The band's text: what the first chat set up by itself. */
export type Band = string

declare module 'claude-code' {
  interface PluginState {
    vault: {
      /** What the first chat set up by itself, shown in the band until closed; null hides it. */
      band: Band | null
      /** True while an empty vault waits for the PARA or Zettelkasten pick in the band. */
      choice: boolean | null
      /** The low line above the chat: what qmd did for the last prompt; null hides it. */
      search: string | null
      /** The last hints, newest last, for the pane. */
      recent: { at: number; hits: string[] }[] | null
      /** True while the weekly review offer shows in the band. */
      review: boolean | null
      /** Bumped by a pane button so the pane redraws. */
      tick: number | null
    }
  }
}
