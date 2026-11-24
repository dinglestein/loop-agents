import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, FsEntry, Register } from 'claude-code'

import type { LoopSnapshot } from '../types'

// The built-in agents chip counts only agents this chat started itself, so a workflow's agents (its builders, reviewers
// and verifiers) show as 0. This reads the workflows' journals beside the session's transcript instead:
// <transcript without .jsonl>/subagents/workflows/wf_*/journal.jsonl, one JSON line per agent "started" and per "result".

const snapshot = atom({ plugin: 'loop-agents', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'loop-agents', key: 'isHidden' } as const, false)

/** An agent whose transcript hasn't moved in this long is taken as gone (a stopped workflow leaves "started" with no result). */
const STALE_MS = 10 * 60 * 1000
const POLL_MS = 5000
const CHUNK = 1024 * 1024

type Started = { agentId: string; label: string; phase: string; order: number }
type Journal = { offset: number; carry: string; started: Map<string, Started>; answered: Set<string> }

const journals = new Map<string, Journal>()
let order = 0
let tick: { cancel: () => void } | undefined

const join = (...parts: string[]) => parts.join('/').replace(/\\/g, '/')

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

async function refresh($: Engine): Promise<void> {
  const { transcriptPath } = await $.session.info()
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', 'workflows')
  if (!(await $.fs.exists(dir))) {
    await update($, snapshot, () => null)
    return
  }
  const now = await $.clock.now()
  const running: Started[] = []
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
    for (const [key, s] of j.started) {
      if (j.answered.has(key)) continue
      const at = moved.get(s.agentId) ?? journal.mtimeMs
      if (now - at <= STALE_MS) running.push(s)
    }
  }
  running.sort((a, b) => b.order - a.order)
  const next: LoopSnapshot | null =
    running.length || done ? { running: running.length, phase: running[0]?.phase ?? '', labels: running.slice(0, 3).map(r => r.label), done } : null
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
    tick = $.clock.every(POLL_MS, () => poll($))
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
    return (
      <Box>
        <Text>
          Loop: {snap.running} {snap.running === 1 ? 'agent' : 'agents'} running{snap.phase ? ` (${snap.phase})` : ''}
        </Text>
        <Text dimColor>
          {' '}
          · {snap.done} done · {who}{' '}
        </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
