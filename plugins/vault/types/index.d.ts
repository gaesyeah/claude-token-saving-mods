/** The band's text: what the first chat set up by itself. */
export type Band = string

declare module 'claude-code' {
  interface PluginState {
    vault: {
      /** What the first chat set up by itself, shown in the band until closed; null hides it. */
      band: Band | null
      /** True while an empty vault waits for the PARA or Zettelkasten pick in the band. */
      choice: boolean | null
      /** The qmd install row: 'offer', 'installing', or the install's result; null hides it. */
      qmd: string | null
    }
  }
}
