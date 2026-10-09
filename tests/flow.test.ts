import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { hasSurvey: false, isWorking: true, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const VIEW = { columns: 140, rows: 50 }

// The real hook path, with the engine's own answers mocked: a subagent starts, searches,
// finishes, and the crew leaves the stage with the next message.
test('a real subagent is tracked from spawn to finish, and engine-internal loops are ignored', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Find the bug', type: 'Explore', status: 'running' }] }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  await $.agent.spawn({ prompt: 'Find where login fails', description: 'Find the bug', subagentType: 'Explore' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await $.tool.call({ tool: 'Grep', pattern: 'func login', agentId: 'a1', tool_use_id: 't1' } as any)
  // A loop the mod never saw start (compaction, a fork) is ignored
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await $.tool.call({ tool: 'Read', file_path: '/x.ts', agentId: 'engine-fork', tool_use_id: 't2' } as any)
  await clock.advance(1_000) // the ticker flushes the buffer

  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^Find the bug$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Searching$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /func login/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('engine-fork')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: 'x', agentId: 'a1', reason: 'answer' } as any)
  expect(await ui.find({ type: 'Text', text: /^Done$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^took / })).toBeDefined()
  await ui.unmount()

  // The next message clears a finished crew
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await $.prompt.submit({ text: 'thanks', origin: { kind: 'composer' } } as any)
  const after = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await after.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  await after.unmount()
})

test('an agent that vanished without a turn.complete is retired', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  on('agent.spawn', () => ({ agentId: 'lost', model: 'claude-haiku-5-5' }))
  on('agent.list', () => ({ value: [] })) // the engine no longer knows it
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'p', description: 'Lost agent', subagentType: 'Explore' })
  await clock.advance(45_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^Cancelled$/ })).toBeDefined()
  await ui.unmount()
})

/** A test world with the engine's answers mocked; `listed` is what $.agent.list() reports. */
async function world($: Engine, on: On, listed: () => { id: string; status: string }[]) {
  const clock = mock.clock(on, { now: 1_000_000 })
  // The plugin's store, answered here so a test can look into it
  const saved: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  let nextTask = 0
  on('tool.call', ($, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: String(++nextTask), subject: (e as unknown as { subject: string }).subject } } } : { result: { success: true } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))
  on('agent.list', () => ({ value: listed().map(x => ({ description: 'd', type: 'Explore', ...x })) }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } }
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'p', description: 'Long build', subagentType: 'Explore' })
  const step = async (turnId: string, index: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = $.turn.step({ turnId, index, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' } as any)
    for await (const _ of s) void _
    await s.result
  }
  const complete = (turnId: string, reason: 'answer' | 'error' | 'aborted' = 'answer') =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId, agentId: 'a1', reason } as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (tool: string, input: Record<string, unknown>) => $.tool.call({ tool, agentId: 'a1', tool_use_id: `u${Math.random()}`, ...input } as any)
  /** The agent's state as its row shows it. */
  const status = async () => {
    const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
    const label = async (text: string) => (await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) })) !== undefined
    const shown = (await label('Done')) ? 'done' : (await label('Cancelled')) ? 'cancelled' : (await label('Failed')) ? 'failed' : 'running'
    await ui.unmount()
    return shown
  }
  return { clock, step, complete, tool, status, saved }
}

test('a quiet agent the engine still lists as running is never retired', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.clock.advance(16 * 60_000) // a 20-minute build makes no events
  expect(await w.status()).toBe('running')
})

test('an agent the engine reports ended is closed with that outcome', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'completed' }])
  await w.clock.advance(11_000) // the next list check
  expect(await w.status()).toBe('done')
})

test("events of a turn that already ended don't bring the agent back", async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.step('t1', 0)
  await w.clock.advance(1_000)
  await w.complete('t1')
  await w.step('t1', 1) // a late event of the turn that just ended
  await w.clock.advance(1_000)
  expect(await w.status()).toBe('done')
})

test('a resumed agent runs again, and a short resumed turn keeps its real outcome', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.step('t1', 0)
  await w.clock.advance(1_000)
  await w.complete('t1')
  await w.clock.advance(2_000)
  await w.step('t2', 0) // resumed with SendMessage: a new turn
  await w.clock.advance(1_000)
  expect(await w.status()).toBe('running')
  await w.complete('t2')
  await w.clock.advance(2_000)
  expect(await w.status()).toBe('done')
  await w.step('t3', 0) // resumed again, and over before the next tick flushes it
  await w.complete('t3', 'error')
  expect(await w.status()).toBe('failed')
})

test('an agent the mod closed takes its real outcome when it finally reports, and is learned', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'completed' }])
  await w.clock.advance(11_000) // the list check closes it
  expect(await w.status()).toBe('done')
  await w.complete('t9', 'answer')
  const history = w.saved.history as Record<string, { ms: number }[]>
  expect(history['Explore|haiku']).toHaveLength(1)
})

test('task tools drive real step progress, and a failed update changes nothing', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.tool('TaskCreate', { subject: 'Read the code', description: 'd' })
  await w.tool('TaskCreate', { subject: 'Write the fix', description: 'd' })
  await w.tool('TaskUpdate', { taskId: '1', status: 'completed' })
  await w.tool('TaskUpdate', { taskId: '2', status: 'in_progress' })
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^Step 2\/2$/ })).toBeDefined()
  await ui.unmount()
})
