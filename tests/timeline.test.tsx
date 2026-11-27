import { expect, test } from 'claude-code/testing'

import { caption, estimates, metaTitles, phasesOfRun, timelineOf, timelineSvg, type PastRun } from '../hooks/register'
import type { LoopSnapshot } from '../types'

const MIN = 60_000

test('a finished run gives each phase from its first agent to the next phase, the last to the run end', async () => {
  const run = {
    workflowName: 'daily-loop',
    status: 'completed',
    startTime: 0,
    durationMs: 100 * MIN,
    phases: [{ title: 'Plan' }, { title: 'Build' }, { title: 'Report' }],
    workflowProgress: [
      { type: 'workflow_phase' },
      { type: 'workflow_agent', phaseTitle: 'Plan', startedAt: 0 },
      { type: 'workflow_agent', phaseTitle: 'Build', startedAt: 10 * MIN },
      { type: 'workflow_agent', phaseTitle: 'Build', startedAt: 20 * MIN },
      { type: 'workflow_agent', phaseTitle: 'Report', startedAt: 90 * MIN },
    ],
  }
  expect(phasesOfRun(run)).toEqual({ Plan: 10 * MIN, Build: 80 * MIN, Report: 10 * MIN })
  // A stopped run: only the phases a later one followed count.
  expect(phasesOfRun({ ...run, status: 'killed' })).toEqual({ Plan: 10 * MIN, Build: 80 * MIN })
})

test('the estimate is each phase’s median over the same workflow’s runs', async () => {
  const runs: PastRun[] = [
    { name: 'daily-loop', at: 3, phases: { Plan: 10 * MIN, Build: 60 * MIN } },
    { name: 'daily-loop', at: 2, phases: { Plan: 20 * MIN, Build: 90 * MIN } },
    { name: 'daily-loop', at: 1, phases: { Plan: 30 * MIN } },
    { name: 'other', at: 4, phases: { Plan: 99 * MIN } },
  ]
  const e = estimates(runs, 'daily-loop')
  expect(e.runs).toBe(3)
  expect(e.byPhase.get('Plan')).toBe(20 * MIN)
  expect(e.byPhase.get('Build')).toBe(75 * MIN)
})

test('time left is the rest of this phase and every phase to come', async () => {
  const t = timelineOf({
    runId: 'wf_1',
    name: 'daily-loop',
    titles: ['Plan', 'Build', 'Report'],
    starts: new Map([['Plan', 0], ['Build', 10 * MIN]]),
    current: 'Build',
    now: 40 * MIN,
    estimate: { byPhase: new Map([['Plan', 10 * MIN], ['Build', 60 * MIN], ['Report', 5 * MIN]]), runs: 4 },
  })
  expect(t.phases.map(p => p.state)).toEqual(['done', 'now', 'next'])
  expect(t.phases[1]!.spentMs).toBe(30 * MIN)
  expect(t.leftMs).toBe(35 * MIN)
  expect(t.isLowerBound).toBe(false)
  expect(caption(t)).toBe('daily-loop · Build 2/3 · ~35m left')
})

test('a phase past its usual length leaves only what comes after, and says so', async () => {
  const t = timelineOf({
    runId: 'wf_1',
    name: 'review-team',
    titles: ['Review', 'Verify', 'Fix'],
    starts: new Map([['Review', 0], ['Verify', 60 * MIN]]),
    current: 'Verify',
    now: 200 * MIN,
    estimate: { byPhase: new Map([['Review', 60 * MIN], ['Verify', 60 * MIN]]), runs: 1 },
  })
  expect(t.isOver).toBe(true)
  // Fix has never finished before: nothing to go on, so what's shown is a lower bound.
  expect(t.isLowerBound).toBe(true)
  expect(caption(t)).toBe('review-team · Verify 2/3 · running long')
})

test('with no past runs it says how long it has been going', async () => {
  const t = timelineOf({ runId: 'wf_2', name: 'new-one', titles: ['A', 'B'], starts: new Map([['A', 0]]), current: 'A', now: 5 * MIN, estimate: { byPhase: new Map(), runs: 0 } })
  expect(t.leftMs).toBeNull()
  expect(caption(t)).toBe('new-one · A 1/2 · 5m in')
  expect(timelineSvg(t)).toMatch(/^<svg [^>]*width="300" height="32"/)
})

test('the phase titles come from the script’s meta', async () => {
  const script = "export const meta = {\n  name: 'x',\n  phases: [\n    { title: 'Plan', detail: 'a' },\n    { title: \"Build\" },\n  ],\n}\nphase('Plan')\n"
  expect(metaTitles(script)).toEqual(['Plan', 'Build'])
})

const BAND = {
  plugin: 'loop-agents',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const SNAP: LoopSnapshot = {
  running: 3,
  phase: 'Verify',
  labels: ['verify 1: a recovery tap'],
  done: 40,
  timelines: [
    timelineOf({
      runId: 'wf_1',
      name: 'review-team',
      titles: ['Review', 'Verify', 'Fix'],
      starts: new Map([['Review', 0], ['Verify', 60 * MIN]]),
      current: 'Verify',
      now: 90 * MIN,
      estimate: { byPhase: new Map([['Review', 60 * MIN], ['Verify', 60 * MIN], ['Fix', 30 * MIN]]), runs: 2 },
    }),
  ],
}

test('the band shows the timeline at its right: an SVG in the editor and desktop, cells in the terminal', async ($, on) => {
  on('state.get', (_, e) => ({ value: { value: (e as { key: string }).key === 'snapshot' ? SNAP : false, version: 1 } }))
  for (const surface of ['vscode', 'desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Loop: 3 agents running/ }))?.text).toContain('(Verify)')
    if (surface === 'terminal') { const all = await ui.find({ type: 'Text', text: /review-team/ }); expect(all?.text).toContain('review-team · Verify 2/3 · ~1h left') }
    else expect((await ui.find({ type: 'Svg' }))?.props?.alt).toBe('review-team · Verify 2/3 · ~1h left')
    await ui.unmount()
  }
})

test('a snapshot stored by 0.1 (no timelines) still draws the line', async ($, on) => {
  const { timelines: _gone, ...old } = SNAP
  on('state.get', (_, e) => ({ value: { value: (e as { key: string }).key === 'snapshot' ? old : false, version: 1 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /Loop: 3 agents running/ }))).toBeTruthy()
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  await ui.unmount()
})
