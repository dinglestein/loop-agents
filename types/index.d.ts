export type LoopSnapshot = {
  /** Agents started and not yet answered, whose transcript moved in the last few minutes. */
  running: number
  /** The phase of the newest running agent ("Build", "Review"...). */
  phase: string
  /** Up to three running agents' labels, newest first. */
  labels: string[]
  /** Agents that have answered so far, across the live workflows. */
  done: number
}

declare module 'claude-code' {
  interface PluginState {
    'loop-agents': { snapshot: LoopSnapshot | null; isHidden: boolean }
  }
}
