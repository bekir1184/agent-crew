import { expect, test } from 'claude-code/testing'

import type { Agent } from '../types'
import {
  FIXED_EXTRAS, addUsage, barSvg, capAgents, crewSummary, doingText, emptyTokens, estimateText, expectation, freshTokens,
  layout, learn, progress, remaining, sanitizeHistory, shownActivity, shownProgress, spriteSvg, stepSummary, stepsFromTodos,
  tree, withActivity, withStepCreated, withStepUpdated,
} from '../hooks/draw'

const agent = (o: Partial<Agent>): Agent => ({
  id: 'a', type: 'Explore', description: 'x', model: 'claude-haiku-5-5', status: 'running', activity: 'searching', target: '',
  activityAt: 0, seenAt: 0, startedAt: 0, tokens: emptyTokens(), tools: 0, requests: 0, ...o,
})

test('progress rises over time, is never 100% before done, and the shown bar never goes backwards', async () => {
  const a = agent({ expectedMs: 10_000 })
  expect(progress(a, 5_000, {})).toBeGreaterThan(progress(a, 1_000, {}))
  let shown = a
  let last = 0
  for (let t = 1_000; t <= 200_000; t += 1_000) {
    const share = shownProgress(shown, t, {})
    expect(share).toBeGreaterThanOrEqual(last)
    expect(share).toBeLessThan(0.995)
    shown = { ...shown, shownShare: share }
    last = share
  }
  expect(progress(agent({ status: 'done' }), 0, {})).toBe(1)
})

test('past the estimate the time left is re-estimated, not counted as overtime', async () => {
  const late = estimateText(agent({ expectedMs: 10_000 }), 20_000, {})
  expect(late.main).toMatch(/^~\d+:\d\d left$/)
  expect(late.extra).toBe('re-estimated')
})

test('re-estimating uses the past runs that lasted at least this long', async () => {
  let h = {}
  for (const ms of [10_000, 11_000, 12_000, 30_000, 40_000]) h = learn(h, agent({}), { ms, requests: 0 })
  const r = remaining(agent({}), 20_000, h) // past the 12 s median: runs that got this far took 30–40 s
  expect(r.basis).toBe('history')
  expect(r.ms).toBe(15_000)
  expect(remaining(agent({}), 60_000, h).basis).toBe('stretch') // longer than any past run
})

test('estimates use the median and learn per type and model', async () => {
  let h = {}
  for (const ms of [10_000, 12_000, 11_000, 90_000]) h = learn(h, agent({}), { ms, requests: 5 })
  const e = expectation(agent({}), h)
  expect(e.ms).toBe(11_500) // the median of 10, 11, 12 and 90 s: one long run doesn't skew it
  expect(e.low).toBeDefined()
  expect(expectation(agent({ model: 'claude-opus-5-5' }), h).learned).toBe(true) // falls back to the type's other models
  expect(expectation(agent({ type: 'Plan' }), h).learned).toBe(false)
})

test('a malformed history from the store is cleaned, never trusted', async () => {
  const h = sanitizeHistory({ 'Explore|haiku': null, 'Plan|opus': [{ ms: 5000, requests: 3 }, { ms: 'x' }, { ms: -1 }], bad: 'x' })
  expect(h).toEqual({ 'Plan|opus': [{ ms: 5000, requests: 3 }] })
  expect(sanitizeHistory('garbage')).toEqual({})
})

test('with a to-do list the time per step predicts the rest, and steps drive progress', async () => {
  const steps = stepsFromTodos([
    { content: 'A', activeForm: 'Doing A', status: 'completed' },
    { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
    { content: 'C', activeForm: 'Doing C', status: 'pending' },
    { content: 'D', activeForm: 'Doing D', status: 'pending' },
  ])
  const a = agent({ steps })
  expect(stepSummary(a)).toEqual({ total: 4, done: 1, current: 'Doing B' })
  expect(doingText(a, 0, 0).main).toBe('Step 2/4')
  expect(remaining(a, 30_000, {})).toEqual({ ms: 50_000, basis: 'steps', revised: false }) // 1.5 steps in 30 s, 2.5 to go
  expect(progress(a, 30_000, {})).toBe(1.5 / 4)
  expect(stepSummary(agent({ steps: withStepUpdated(steps, { taskId: 't1', status: 'completed' }) }))?.done).toBe(2)
  expect(withStepCreated([], 'task-9', 'Write docs')).toEqual([{ id: 'task-9', label: 'Write docs', status: 'pending' }])
})

test('a short thinking pause keeps the accessory, in the text and in the sprite', async () => {
  const b = withActivity(agent({ activity: 'searching', target: 'login', activityAt: 0 }), 'thinking', '', 10_000)
  expect(shownActivity(b, 10_500).activity).toBe('searching')
  expect(shownActivity(b, 12_000).activity).toBe('thinking')
  expect(spriteSvg(b, 10_500)).toBe(spriteSvg(agent({ activity: 'searching' }), 0))
  expect(spriteSvg(b, 12_000)).not.toBe(spriteSvg(agent({ activity: 'searching' }), 0))
})

test('each SVG carries only the animations it uses', async () => {
  const bar = barSvg(0.5, '#4C7DF0', true, 112)
  expect(bar).toContain('@keyframes on')
  expect(bar).not.toContain('@keyframes hop')
  expect(barSvg(0.5, '#4C7DF0', false, 112)).not.toContain('@keyframes')
})

test('a running bar is never drawn full', async () => {
  const full = (svg: string) => (svg.match(/fill="#123456"/g) ?? []).length
  // 13 filled segments plus the blinking one: the last never sits full while running
  expect(full(barSvg(0.99, '#123456', true, 112)) - 1).toBeLessThan(14)
  expect(full(barSvg(1, '#123456', false, 112))).toBe(14)
})

test('helpers sit right below their parent; cycles and deep chains never lose a row', async () => {
  const list = [agent({ id: 'p' }), agent({ id: 'q' }), agent({ id: 'c1', parentId: 'p' }), agent({ id: 'c2', parentId: 'c1' }), agent({ id: 'o', parentId: 'gone' })]
  expect(tree(list).map(x => `${x.a.id}:${x.depth}`)).toEqual(['p:0', 'c1:1', 'c2:2', 'q:0', 'o:0'])
  expect(tree([agent({ id: 'x', parentId: 'y' }), agent({ id: 'y', parentId: 'x' })])).toHaveLength(2)
  const chain = Array.from({ length: 12 }, (_, i) => agent({ id: `n${i}`, parentId: i ? `n${i - 1}` : undefined }))
  const rows = tree(chain)
  expect(rows).toHaveLength(12)
  expect(Math.max(...rows.map(r => r.depth))).toBe(4)
})

test('past the cap finished agents go first and running ones stay', async () => {
  const list = Array.from({ length: 13 }, (_, i) => agent({ id: `a${i}`, status: i > 0 && i < 4 ? 'done' : 'running' }))
  const kept = capAgents(list)
  expect(kept).toHaveLength(12)
  expect(kept.some(a => a.id === 'a0')).toBe(true)
  expect(kept.some(a => a.id === 'a1')).toBe(false)
})

test('fresh tokens leave cache re-reads out', async () => {
  const t = addUsage(emptyTokens(), { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 30_000 })
  expect(freshTokens(t)).toBe(350)
  expect(t.cacheRead).toBe(30_000)
})

test('the header shows the longest time left among running agents', async () => {
  const late = agent({ id: 'l', expectedMs: 10_000 })
  const onTime = agent({ id: 'o', expectedMs: 60_000 })
  expect(crewSummary([late], 20_000, {}).leftMs).toBeGreaterThan(0)
  expect(crewSummary([late, onTime], 20_000, {}).leftMs).toBe(40_000)
  expect(crewSummary([agent({ status: 'done', endedAt: 5_000 })], 20_000, {}).share).toBe(1)
})

test('a parent waiting on a helper says so', async () => {
  expect(doingText(agent({}), 0, 2)).toEqual({ main: 'Waiting', extra: 'on 2 helpers' })
})

test('a row always fits its width; tokens stay until the surface is very narrow', async () => {
  const width = (L: ReturnType<typeof layout>) => FIXED_EXTRAS + L.type + L.task + L.doing + L.pct + L.eta + L.barCells + (L.showTokens ? L.tokens : 0)
  for (let columns = 90; columns <= 220; columns += 5) {
    // The desktop lays cells out wider than it reports, so a desktop row keeps 6% free
    expect(width(layout(columns, true))).toBeLessThanOrEqual(Math.floor(columns * 0.94))
    expect(width(layout(columns, false))).toBeLessThanOrEqual(columns)
    if (columns >= 95) expect(layout(columns, true).showTokens).toBe(true)
  }
})
