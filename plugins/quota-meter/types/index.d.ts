/** What the pane draws: the limits' headline, the full report, and the two windows' use in %. */
export type QuotaView = { line: string; report: string; five?: number; week?: number }

declare module 'claude-code' {
  interface PluginState {
    'quota-meter': {
      /** Rewritten at each measure and turn end, so the pane redraws. */
      view: QuotaView | null
    }
  }
}
