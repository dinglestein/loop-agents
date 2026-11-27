import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, FsEntry, Register } from 'claude-code'

import type { LoopSnapshot, LoopTimeline, PhaseBar } from '../types'

// The built-in agents chip counts only agents this chat started itself, so a workflow's agents (its builders, reviewers
// and verifiers) show as 0. This reads the workflows' journals beside the session's transcript instead:
// <transcript without .jsonl>/subagents/workflows/wf_*/journal.jsonl, one JSON line per agent "started" and per "result".
//
// The timeline at the band's right estimates what's left of each run from earlier runs of the same workflow: each finished
// run leaves a record (<session>/workflows/wf_*.json) with every agent's phase, start and duration, so a phase's usual
// length is the median of what it took before, across every project's sessions.

const snapshot = atom({ plugin: 'loop-agents', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'loop-agents', key: 'isHidden' } as const, false)

/** An agent whose transcript hasn't moved in this long is taken as gone (a stopped workflow leaves "started" with no result). */
const STALE_MS = 10 * 60 * 1000
const POLL_MS = 5000
const CHUNK = 1024 * 1024
/** Past runs are looked for at the start and this often after (a run that just finished joins the estimates). */
const HISTORY_MS = 15 * 60 * 1000
const HISTORY_KEY = 'history-v1'
/** The newest this many runs of a workflow make its estimates; the store keeps at most HISTORY_CAP runs in all. */
const SAMPLES = 10
const HISTORY_CAP = 300

type Started = { agentId: string; label: string; phase: string; order: number }
type Journal = { offset: number; carry: string; started: Map<string, Started>; answered: Set<string> }

/** A past run, as far as estimates need it: how long each phase that finished took. */
export type PastRun = { name: string; at: number; phases: Record<string, number> }
type History = { files: Record<string, number>; runs: Record<string, PastRun> }

const journals = new Map<string, Journal>()
/** When each agent started: the first timestamp in its transcript, read once. */
const agentStart = new Map<string, number>()
/** Each run's workflow name and phase titles, from the script the Workflow tool saved for it. */
const runMeta = new Map<string, { name: string; titles: string[] }>()
let history: History = { files: {}, runs: {} }
let order = 0
let tick: { cancel: () => void } | undefined
let historyTick: { cancel: () => void } | undefined
let scanning = false

const join = (...parts: string[]) => parts.join('/').replace(/\\/g, '/')
const parent = (path: string) => path.replace(/\\/g, '/').replace(/\/[^/]*\/?$/, '')

/** Reads what the journal gained since the last poll (it only grows), keeping a partial last line for the next one. */
async function readJournal($: Engine, path: string): Promise<Journal> {
  let j = journals.get(path)
  if (!j) journals.set(path, (j = { offset: 0, carry: '', started: new Map(), answered: new Set() }))
  const { size } = await $.fs.stat(path)
  if (size < j.offset) {
    j.offset = 0
    j.carry = ''
    j.started.clear()
    j.answered.clear()
  }
  while (j.offset < size) {
    const length = Math.min(CHUNK, size - j.offset)
    const text = (await $.fs.read(path, { offset: j.offset, length })) as string
    j.offset += length
    const lines = (j.carry + text).split('\n')
    j.carry = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let row: { type?: string; key?: string; agentId?: string; label?: string; phase?: string }
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!row.key) continue
      if (row.type === 'started') j.started.set(row.key, { agentId: row.agentId ?? '', label: row.label ?? 'agent', phase: row.phase ?? '', order: order++ })
      else if (row.type === 'result') j.answered.add(row.key)
    }
  }
  return j
}

/** The first timestamp in an agent's transcript: when it started. */
async function startOf($: Engine, wfDir: string, agentId: string): Promise<number | null> {
  if (agentStart.has(agentId)) return agentStart.get(agentId)!
  try {
    const head = (await $.fs.read(join(wfDir, `agent-${agentId}.jsonl`), { offset: 0, length: 4096 })) as string
    const at = Date.parse(head.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1] ?? '')
    if (!Number.isFinite(at)) return null
    agentStart.set(agentId, at)
    return at
  } catch {
    return null
  }
}

/** The phase titles in a workflow script's `meta` (a pure literal, so a pattern reads it). */
export function metaTitles(script: string): string[] {
  const meta = script.match(/export const meta\s*=\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  const phases = meta.match(/phases\s*:\s*\[([\s\S]*?)\]\s*,?\s*\n/)?.[1] ?? ''
  return [...phases.matchAll(/title\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2] ?? '')
}

/** The workflow's name and phases for a run, from the script saved as <session>/workflows/scripts/<name>-<runId>.js. */
async function metaOf($: Engine, sessionDir: string, runId: string): Promise<{ name: string; titles: string[] }> {
  const known = runMeta.get(runId)
  if (known) return known
  let meta = { name: runId, titles: [] as string[] }
  try {
    const dir = join(sessionDir, 'workflows', 'scripts')
    const file = (await $.fs.list(dir)).find(f => f.name.endsWith(`-${runId}.js`))
    if (file) meta = { name: file.name.slice(0, -(runId.length + 4)), titles: metaTitles((await $.fs.read(join(dir, file.name))) as string) }
  } catch {
    // no saved script: the run id stands for the name, the phases come from the journal
  }
  runMeta.set(runId, meta)
  return meta
}

type RunRecord = {
  workflowName?: string
  status?: string
  startTime?: number
  durationMs?: number
  phases?: { title: string }[]
  workflowProgress?: { type: string; phaseTitle?: string; startedAt?: number; durationMs?: number }[]
}

/**
 * How long each phase of a finished or stopped run took: from its first agent's start to the next phase's, the last one to
 * the run's end. Of a run that didn't finish, only the phases a later phase followed.
 */
export function phasesOfRun(d: RunRecord): Record<string, number> {
  const starts = new Map<string, number>()
  for (const p of d.workflowProgress ?? []) {
    if (p.type !== 'workflow_agent' || !p.phaseTitle || typeof p.startedAt !== 'number') continue
    starts.set(p.phaseTitle, Math.min(starts.get(p.phaseTitle) ?? Infinity, p.startedAt))
  }
  const titles = (d.phases ?? []).map(p => p.title).filter(t => starts.has(t))
  for (const t of starts.keys()) if (!titles.includes(t)) titles.push(t)
  titles.sort((a, b) => starts.get(a)! - starts.get(b)!)
  const out: Record<string, number> = {}
  const isDone = d.status === 'completed'
  titles.forEach((t, i) => {
    const after = titles[i + 1]
    const end = after !== undefined ? starts.get(after)! : isDone && typeof d.startTime === 'number' && typeof d.durationMs === 'number' ? d.startTime + d.durationMs : null
    if (end !== null && end > starts.get(t)!) out[t] = end - starts.get(t)!
  })
  return out
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Each phase's usual length for a workflow: the median of its newest runs that went through that phase. */
export function estimates(runs: PastRun[], name: string): { byPhase: Map<string, number>; runs: number } {
  const mine = runs.filter(r => r.name === name).sort((a, b) => b.at - a.at)
  const byPhase = new Map<string, number>()
  const titles = new Set(mine.flatMap(r => Object.keys(r.phases)))
  for (const t of titles) {
    const m = median(mine.filter(r => t in r.phases).slice(0, SAMPLES).map(r => r.phases[t]!))
    if (m !== null) byPhase.set(t, m)
  }
  return { byPhase, runs: mine.length }
}

/**
 * A live run's timeline. `titles`: its phases in order; `starts`: when each phase's first agent started; `current`: the
 * furthest phase reached (a workflow only moves forward; a later step checking in an earlier phase doesn't move it back).
 */
export function timelineOf(args: {
  runId: string
  name: string
  titles: string[]
  starts: Map<string, number>
  current: string
  now: number
  estimate: { byPhase: Map<string, number>; runs: number }
}): LoopTimeline {
  const { runId, name, starts, current, now, estimate } = args
  const titles = [...args.titles]
  for (const t of starts.keys()) if (!titles.includes(t)) titles.push(t)
  const k = Math.max(0, titles.indexOf(current))
  const phases: PhaseBar[] = titles.map((title, i) => {
    const state = i < k ? 'done' : i === k ? 'now' : 'next'
    const start = starts.get(title)
    const nextStart = titles.slice(i + 1).map(t => starts.get(t)).find((s): s is number => s !== undefined)
    const spentMs = start === undefined ? 0 : state === 'now' ? now - start : state === 'done' ? (nextStart ?? now) - start : 0
    return { title, state, estMs: estimate.byPhase.get(title) ?? null, spentMs: Math.max(0, spentMs) }
  })
  const first = Math.min(...[...starts.values()])
  const here = phases[k]
  const later = phases.slice(k + 1)
  const isOver = here?.estMs != null && here.spentMs > here.estMs
  const known = [here, ...later].filter(p => p && p.estMs != null)
  // What's left of the current phase (none once it has run past its usual length), then each phase to come.
  const hereLeft = here?.estMs != null ? Math.max(0, here.estMs - here.spentMs) : 0
  const leftMs = known.length ? hereLeft + later.reduce((s, p) => s + (p.estMs ?? 0), 0) : null
  return {
    runId,
    name,
    phases,
    elapsedMs: Number.isFinite(first) ? Math.max(0, now - first) : 0,
    leftMs,
    isLowerBound: leftMs !== null && (here?.estMs == null || later.some(p => p.estMs == null)),
    isOver,
    runs: estimate.runs,
  }
}

/** "1h 40m", "12m", "45s". */
export function duration(ms: number): string {
  const m = Math.round(ms / 60000)
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

/** The words beside a timeline: where it is and what's left. */
export function caption(t: LoopTimeline): string {
  const k = t.phases.findIndex(p => p.state === 'now')
  const here = t.phases[k]
  const where = here ? `${here.title} ${k + 1}/${t.phases.length}` : ''
  const left =
    t.leftMs === null
      ? `${duration(t.elapsedMs)} in`
      : t.isOver && t.leftMs < 60000
        ? 'running long'
        : `${t.isLowerBound ? '≥' : '~'}${duration(t.leftMs)} left${t.isOver ? ' (long)' : ''}`
  return [t.name, where, left].filter(Boolean).join(' · ')
}

const COLOURS = { done: '#3fb950', now: '#d29922', over: '#f85149', track: '#3d444d', text: '#8b949e' }
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Each phase's share of the bar: its usual length, else what it took, else the mean of the known ones. */
function weights(t: LoopTimeline): number[] {
  const raw = t.phases.map(p => p.estMs ?? (p.state === 'done' && p.spentMs > 0 ? p.spentMs : null))
  const known = raw.filter((x): x is number => x !== null)
  const fill = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1
  return raw.map(x => x ?? fill)
}

/** The timeline as an SVG: one segment per phase, done ones full, the current one filling, a caption under it. */
export function timelineSvg(t: LoopTimeline, width = 300): string {
  const gap = 3
  const w = weights(t)
  const total = w.reduce((a, b) => a + b, 0) || 1
  const room = width - gap * Math.max(0, t.phases.length - 1)
  let x = 0
  const parts: string[] = []
  t.phases.forEach((p, i) => {
    const seg = Math.max(6, ((w[i] ?? 0) / total) * room)
    parts.push(`<rect x="${x.toFixed(1)}" y="2" width="${seg.toFixed(1)}" height="8" rx="2" fill="${p.state === 'done' ? COLOURS.done : COLOURS.track}"><title>${xml(p.title)}</title></rect>`)
    if (p.state === 'now') {
      const share = p.estMs ? Math.min(1, p.spentMs / p.estMs) : 0.5
      parts.push(`<rect x="${x.toFixed(1)}" y="2" width="${Math.max(2, seg * share).toFixed(1)}" height="8" rx="2" fill="${t.isOver ? COLOURS.over : COLOURS.now}"/>`)
    }
    x += seg + gap
  })
  parts.push(`<text x="0" y="26" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="11" fill="${COLOURS.text}">${xml(caption(t))}</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32" viewBox="0 0 ${width} 32">${parts.join('')}</svg>`
}

/** The terminal's timeline: a row of cells per phase, filled as it goes. */
export function timelineCells(t: LoopTimeline, cells = 24): { done: string; now: string; rest: string } {
  const w = weights(t)
  const total = w.reduce((a, b) => a + b, 0) || 1
  let done = 0
  let now = 0
  let all = 0
  t.phases.forEach((p, i) => {
    const n = Math.max(1, Math.round(((w[i] ?? 0) / total) * cells))
    all += n
    if (p.state === 'done') done += n
    if (p.state === 'now') now += Math.round(n * (p.estMs ? Math.min(1, p.spentMs / p.estMs) : 0.5))
  })
  return { done: '━'.repeat(done), now: '━'.repeat(now), rest: '─'.repeat(Math.max(0, all - done - now)) }
}

/** Past runs, from every project's sessions; each record read once, then kept in the plugin's store. */
async function scanHistory($: Engine): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const stored = (await $.store.get(HISTORY_KEY)) as History | undefined
    if (stored && stored.files && stored.runs) history = stored
    const { transcriptPath } = await $.session.info()
    const projects = parent(parent(transcriptPath))
    let changed = false
    for (const project of await $.fs.list(projects)) {
      if (project.kind !== 'dir') continue
      let sessions: FsEntry[] = []
      try {
        sessions = await $.fs.list(join(projects, project.name))
      } catch {
        continue
      }
      for (const s of sessions) {
        if (s.kind !== 'dir') continue
        const dir = join(projects, project.name, s.name, 'workflows')
        let records: FsEntry[] = []
        try {
          records = (await $.fs.list(dir)).filter(f => f.kind === 'file' && /^wf_.*\.json$/.test(f.name))
        } catch {
          continue
        }
        for (const f of records) {
          const path = join(dir, f.name)
          if (history.files[path] === f.mtimeMs) continue
          try {
            const d = JSON.parse((await $.fs.read(path)) as string) as RunRecord
            const phases = phasesOfRun(d)
            if (d.workflowName && Object.keys(phases).length) history.runs[f.name.slice(0, -5)] = { name: d.workflowName, at: d.startTime ?? f.mtimeMs, phases }
          } catch {
            // a record mid-write: read again next time
            continue
          }
          history.files[path] = f.mtimeMs
          changed = true
        }
      }
    }
    if (changed) {
      const keep = Object.entries(history.runs).sort((a, b) => b[1].at - a[1].at).slice(0, HISTORY_CAP)
      history.runs = Object.fromEntries(keep)
      await $.store.set(HISTORY_KEY, history)
    }
  } catch {
    // no projects folder to read: the timelines show without estimates
  } finally {
    scanning = false
  }
}

async function refresh($: Engine): Promise<void> {
  const { transcriptPath } = await $.session.info()
  const sessionDir = transcriptPath.replace(/\.jsonl$/, '')
  const dir = join(sessionDir, 'subagents', 'workflows')
  if (!(await $.fs.exists(dir))) {
    await update($, snapshot, () => null)
    return
  }
  const now = await $.clock.now()
  const running: Started[] = []
  const timelines: LoopTimeline[] = []
  let done = 0
  for (const wf of await $.fs.list(dir)) {
    if (wf.kind !== 'dir') continue
    const wfDir = join(dir, wf.name)
    const files = await $.fs.list(wfDir)
    const journal = files.find((f: FsEntry) => f.name === 'journal.jsonl')
    if (!journal) continue
    const moved = new Map(files.filter((f: FsEntry) => f.name.startsWith('agent-') && f.name.endsWith('.jsonl')).map((f: FsEntry): [string, number] => [f.name.slice(6, -6), f.mtimeMs]))
    // A workflow nobody has touched lately is finished or stopped: skip it whole.
    const newest = Math.max(journal.mtimeMs, ...[...moved.values()])
    if (now - newest > STALE_MS) continue
    const j = await readJournal($, join(wfDir, 'journal.jsonl'))
    done += j.answered.size
    let live = 0
    for (const [key, s] of j.started) {
      if (j.answered.has(key)) continue
      const at = moved.get(s.agentId) ?? journal.mtimeMs
      if (now - at <= STALE_MS) {
        running.push(s)
        live++
      }
    }
    if (!live) continue
    // Where this run is: each phase's first start, and the furthest phase an agent has started in.
    const meta = await metaOf($, sessionDir, wf.name)
    const starts = new Map<string, number>()
    let furthest = ''
    let furthestAt = -1
    for (const s of j.started.values()) {
      if (!s.phase) continue
      const at = await startOf($, wfDir, s.agentId)
      if (at !== null) starts.set(s.phase, Math.min(starts.get(s.phase) ?? Infinity, at))
      const rank = meta.titles.indexOf(s.phase)
      const place = rank >= 0 ? rank : meta.titles.length + s.order
      if (place > furthestAt) {
        furthestAt = place
        furthest = s.phase
      }
    }
    if (!starts.size) continue
    timelines.push(timelineOf({ runId: wf.name, name: meta.name, titles: meta.titles, starts, current: furthest, now, estimate: estimates(Object.values(history.runs), meta.name) }))
  }
  running.sort((a, b) => b.order - a.order)
  const next: LoopSnapshot | null =
    running.length || done ? { running: running.length, phase: running[0]?.phase ?? '', labels: running.slice(0, 3).map(r => r.label), done, timelines } : null
  await update($, snapshot, () => next)
}

async function poll($: Engine): Promise<void> {
  try {
    await refresh($)
  } catch {
    // a journal mid-write or a folder just removed: the next poll tries again
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    tick?.cancel()
    historyTick?.cancel()
    tick = $.clock.every(POLL_MS, () => poll($))
    historyTick = $.clock.every(HISTORY_MS, () => scanHistory($))
    const stored = (await $.store.get(HISTORY_KEY)) as History | undefined
    if (stored && stored.files && stored.runs) history = stored
    void scanHistory($).then(() => poll($))
    await poll($)
    return next(e)
  })

  // A workflow fired in the chat: show the line now instead of at the next tick, and bring it back if it was hidden for an
  // earlier run (Hide is for the run on screen, not every loop after it).
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, isHidden, () => false)
      await poll($)
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (!snap || snap.running === 0 || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const who = snap.labels.map(l => (l.length > 48 ? `${l.slice(0, 47)}…` : l)).join(' · ')
    const timelines = snap.timelines ?? []
    // The timelines take the band's right side: drawn as a small SVG where the surface has one, as cells in the terminal.
    const els = $.ui.resolve(e)
    // The terminal has no Svg (its table answers one anyway, drawn as nothing): cells there.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const wide = e.props.bodyColumns >= 100
    const right = timelines.length ? (
      <Box key="timelines" flexDirection="column" alignItems="flex-end" flexShrink={0}>
        {timelines.map(t => {
          if (Svg) return <Svg key={t.runId} source={timelineSvg(t)} alt={caption(t)} width={300} height={32} />
          const c = timelineCells(t, wide ? 24 : 12)
          return (
            <Box key={t.runId}>
              <Text color="green">{c.done}</Text>
              <Text color={t.isOver ? 'red' : 'yellow'}>{c.now}</Text>
              <Text dimColor>{c.rest} {caption(t)}</Text>
            </Box>
          )
        })}
      </Box>
    ) : null
    return (
      <Box flexDirection={wide || Svg ? 'row' : 'column'} justifyContent="space-between" width="100%">
        <Box flexShrink={1}>
          <Text>
            Loop: {snap.running} {snap.running === 1 ? 'agent' : 'agents'} running{snap.phase ? ` (${snap.phase})` : ''}
          </Text>
          <Text dimColor>
            {' '}
            · {snap.done} done · {who}{' '}
          </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {right}
      </Box>
    )
  })
}
