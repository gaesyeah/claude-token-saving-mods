/** The band: 'offer', 'installing', or the install's result. */
export type Band = string

declare module 'claude-code' {
  interface PluginState {
    'local-models': {
      /** The band: 'offer', 'installing', or the install's result; null hides it. */
      band: Band | null
    }
  }
}
