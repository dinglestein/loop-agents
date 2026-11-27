/** One phase of a workflow on its timeline: done, the one running now, or still to come. */
export type PhaseBar = {
  title: string
  state: 'done' | 'now' | 'next'
  /** How long it usually takes, from past runs of the same workflow; null with none to go on. */
  estMs: number | null
  /** Time it has taken so far (a done phase: all of it; the current one: since it started). */
  spentMs: number
}

/** One running workflow's progress and what's left, for the timeline at the band's right. */
export type LoopTimeline = {
  runId: string
  /** The workflow's name ("nightly", "review"), or its run id when the name can't be found. */
  name: string
  phases: PhaseBar[]
  elapsedMs: number
  /** Estimated time left; null when no past run says anything about what's left. */
  leftMs: number | null
  /** Some phase still to come has no past runs to go on: the time left is at least this. */
  isLowerBound: boolean
  /** The current phase has run past its usual length. */
  isOver: boolean
  /** How many past runs the estimate draws on. */
  runs: number
}

export type LoopSnapshot = {
  /** Agents started and not yet answered, whose transcript moved in the last few minutes. */
  running: number
  /** The phase of the newest running agent ("Build", "Review"...). */
  phase: string
  /** Up to three running agents' labels, newest first. */
  labels: string[]
  /** Agents that have answered so far, across the live workflows. */
  done: number
  /** One timeline for each live workflow. Absent in a snapshot stored by 0.1. */
  timelines?: LoopTimeline[]
}

declare module 'claude-code' {
  interface PluginState {
    'loop-agents': { snapshot: LoopSnapshot | null; isHidden: boolean }
  }
}
