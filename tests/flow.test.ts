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
  // Redraw requests, counted: the ticker asks for one every second while it runs
  const redraws = { count: 0 }
  on('ui.invalidate', () => {
    redraws.count += 1
    return { value: undefined }
  })
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
  // Redraw requests, counted: the ticker asks for one every second while it runs
  const redraws = { count: 0 }
  on('ui.invalidate', () => {
    redraws.count += 1
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  on('agent.spawn', () => ({ agentId: 'lost', model: 'claude-haiku-5-5' }))
  on('agent.list', () => ({ value: [] })) // the engine no longer knows it
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'p', description: 'Lost agent', subagentType: 'Explore' })
  await clock.advance(45_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  // Retired as cancelled, it leaves the band, and with nobody else there the engine draws its own
  expect(await ui.find({ type: 'Text', text: /Lost agent/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ENGINE ROW/ })).toBeDefined()
  await ui.unmount()
})

/** A test world with the engine's answers mocked; `listed` is what $.agent.list() reports. */
async function world($: Engine, on: On, listed: () => { id: string; status: string }[], spawn = true) {
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
  // Redraw requests, counted: the ticker asks for one every second while it runs
  const redraws = { count: 0 }
  on('ui.invalidate', () => {
    redraws.count += 1
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))
  on('agent.list', () => ({ value: listed().map(x => ({ description: 'd', type: 'Explore', ...x })) }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  // What each model request reports; a test may change it
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { ...usage } }
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  if (spawn) await $.agent.spawn({ prompt: 'p', description: 'Long build', subagentType: 'Explore' })
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
  return { clock, step, complete, tool, status, saved, redraws, usage }
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

test('an agent waiting on the person shows it, and the wait ends when the tool goes on', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await $.classic.PermissionRequest({ agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'rm -r build' } } as any)
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^Needs approval$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 agent needs your approval/ })).toBeDefined()
  await w.tool('Bash', { command: 'rm -r build' }) // approved: the call ran
  await w.clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /^Needs approval$/ })).toBeUndefined()
  await ui.unmount()
})

test("the title's arrow hides and shows the agent rows", async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ key: 'open-a1' })).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'open-a1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /AGENT CREW/ })).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'open-a1' })).toBeDefined()
  await ui.unmount()
})

test('the minimise button shrinks the whole band to one line, and the choice is kept', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  await ui.press({ key: 'minimize' })
  expect(await ui.find({ key: 'open-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'collapse' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /AGENT CREW/ })).toBeDefined()
  expect(w.saved.minimized).toBe(true)
  await ui.press({ key: 'minimize' })
  expect(await ui.find({ key: 'open-a1' })).toBeDefined()
  expect(w.saved.minimized).toBe(false)
  await ui.unmount()
})

test('a cancelled agent leaves the band; the others stay', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  let spawned = 0
  on('agent.spawn', () => ({ agentId: `a${++spawned}`, model: 'claude-haiku-5-5' }))
  // The engine reports the first one killed (stopped by the person), the second still running
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'd', type: 'Explore', status: 'killed' }, { id: 'a2', description: 'd', type: 'Explore', status: 'running' }] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'p', description: 'Stopped', subagentType: 'Explore' })
  await $.agent.spawn({ prompt: 'p', description: 'Still going', subagentType: 'Explore' })
  await clock.advance(11_000) // the next list check
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ key: 'open-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'open-a2' })).toBeDefined()
  await ui.unmount()
})

test('the crew starts in the side pane; ⇤ brings the band back and ⇥ moves it to the side again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const saved: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  const opens: { id: string; columns?: number }[] = []
  on('ui.open', ($, e) => {
    opens.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'd', type: 'Explore', status: 'running' }] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  // No pane until an agent starts
  expect(opens.length).toBe(0)
  await $.agent.spawn({ prompt: 'p', description: 'Side job', subagentType: 'Explore' })
  await clock.advance(1_000)

  // The side pane is the default: it opens with the first agent, and the band stays empty
  expect(opens.at(-1)).toMatchObject({ id: 'crew', columns: 38 })
  const band = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await band.find({ type: 'Text', text: /ENGINE ROW/ })).toBeDefined()
  await band.unmount()

  for (const surface of ['desktop', 'terminal'] as const) {
    const pane = await $.ui.mount({ plugin: 'agent-crew', surface, component: 'Pane', requestId: 'crew', props: { title: 'Agent Crew', isFocused: false, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: VIEW })
    expect(await pane.find({ type: 'Text', text: /Side job/ })).toBeDefined()
    expect(await pane.find({ key: 'open-a1' })).toBeDefined()
    await pane.unmount()
  }

  // The pane's ⇤ moves the crew back: the band returns, and the next session starts without the pane
  const pane = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'Pane', requestId: 'crew', props: { title: 'Agent Crew', isFocused: false, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: VIEW })
  await pane.press({ key: 'unside' })
  expect(saved.side).toBe(false)
  await pane.unmount()
  const again = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await again.find({ key: 'open-a1' })).toBeDefined()
  // and the band's ⇥ moves it to the side again
  const opened = opens.length
  await again.press({ key: 'side' })
  expect(opens.length).toBe(opened + 1)
  expect(saved.side).toBe(true)
  await again.unmount()
})

test('a quiet agent is flagged without being retired', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.clock.advance(130_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^Quiet$/ })).toBeDefined()
  await ui.unmount()
})

test('while hidden the crew sums itself up on the status line', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push((e as unknown as { text?: string }).text)
    return { value: undefined }
  })
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await $.command.run({ command: 'crew', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 140 } } as any)
  await w.clock.advance(1_000)
  expect(statuses.some(t => t?.startsWith('Agent Crew: 1 working'))).toBe(true)
})

test('/clear sends a finished crew away', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.complete('t1')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await $.classic.SessionStart({ source: 'clear' } as any)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  await ui.unmount()
})

test('with costs on, rows and the title show a ≈ dollar estimate', { options: { showCost: true } }, async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.step('t1', 0)
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /tok ≈\$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tokens {2}· {2}≈\$/ })).toBeDefined()
  await ui.unmount()
})

test("the details panel lists the files an agent changed and read", async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.tool('Read', { file_path: '/work/src/auth.ts' })
  await w.tool('Edit', { file_path: '/work/src/login.ts', old_string: 'a', new_string: 'b' })
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  await ui.press({ key: 'open-a1' })
  expect(await ui.find({ type: 'Text', text: /^src\/login\.ts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^src\/auth\.ts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Changed 1/ })).toBeDefined()
  await ui.unmount()
})

/** Drives the main conversation: a turn with its prompt, its requests and tool calls, and its end. */
function mainLoop($: Engine) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start: (turnId: string, text: string) => $.turn.start({ turnId, text } as any),
    step: async (turnId: string, index: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 } as any)
      for await (const _ of s) void _
      await s.result
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (tool: string, input: Record<string, unknown>) => $.tool.call({ tool, tool_use_id: `m${Math.random()}`, ...input } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    complete: (turnId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as any),
  }
}

test("alone, the framed AGENT line shows Claude's own work and leaves with the turn", async ($, on) => {
  const w = await world($, on, () => [], false)
  const m = mainLoop($)
  await m.start('m1', 'Fix the login bug')
  await m.step('m1', 0)
  await m.tool('Grep', { pattern: 'func login' })
  await w.clock.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^AGENT$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Searching {2}func login$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^0:0\d {2}· {2}\d+ tokens$/ })).toBeDefined()
  expect(await ui.find({ key: 'collapse' })).toBeUndefined() // nothing to fold yet
  await ui.press({ key: 'open-main' }) // its own details
  expect(await ui.find({ type: 'Text', text: /^Fix the login bug$/ })).toBeDefined()
  await ui.press({ key: 'open-main' })
  await w.clock.advance(4_000)
  await m.complete('m1')
  // The turn ended: a thin line with its final numbers, no critter
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}Done$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last turn 0:09 {2}· {2}\d+ tokens {2}· {2}1 tool$/ })).toBeDefined()
  await ui.press({ key: 'open-main' })
  expect(await ui.find({ type: 'Text', text: /Grep func login/ })).toBeDefined() // the details open under it
  await $.command.run({ command: 'crew', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 140 } } as never)
  expect(await ui.find({ type: 'Text', text: /AGENT/ })).toBeUndefined()
  await ui.unmount()
})

test('subagents join below the AGENT line, which waits on them and folds them away', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }], false)
  const m = mainLoop($)
  await m.start('m1', 'Investigate')
  await m.step('m1', 0)
  await $.agent.spawn({ prompt: 'p', description: 'Long build', subagentType: 'Explore' })
  await m.step('m1', 1) // thinking, while its subagent works
  await w.clock.advance(3_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^AGENT CREW$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Waiting {2}on 1 agent$/ })).toBeDefined()
  expect(await ui.find({ key: 'open-a1' })).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'open-a1' })).toBeUndefined()
  await ui.press({ key: 'collapse' })
  await m.complete('m1') // the crew keeps the band
  expect(await ui.find({ key: 'open-a1' })).toBeDefined()
  await ui.unmount()
})

test("with Claude's own line turned off, the main conversation draws nothing", { options: { showMain: false } }, async ($, on) => {
  const w = await world($, on, () => [], false)
  const m = mainLoop($)
  await m.start('m1', 'Hello')
  await m.step('m1', 0)
  await w.clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /AGENT/ })).toBeUndefined()
  await ui.unmount()
})

test("learning a run keeps what another session saved meanwhile", async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  // Another open session finished a Plan run after this one loaded the history
  w.saved.history = { 'Plan|sonnet': [{ ms: 40_000, requests: 6 }] }
  await w.step('t1', 0)
  await w.clock.advance(1_000)
  await w.complete('t1')
  const history = w.saved.history as Record<string, { ms: number }[]>
  expect(history['Plan|sonnet']).toHaveLength(1) // not overwritten
  expect(history['Explore|haiku']).toHaveLength(1)
})

test('the ticker stops once nobody runs, and a new agent starts it again', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.clock.advance(2_000)
  expect(w.redraws.count).toBeGreaterThan(0) // running: the clocks are redrawn
  await w.complete('t1')
  await w.clock.advance(2_000) // the next tick sees nobody running and stops
  const stopped = w.redraws.count
  await w.clock.advance(10_000)
  expect(w.redraws.count).toBe(stopped) // no timer left behind

  await $.agent.spawn({ prompt: 'p', description: 'Second job', subagentType: 'Explore' })
  await w.tool('Read', { file_path: '/work/src/a.ts' })
  await w.clock.advance(1_000) // the restarted ticker flushes the tool call
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^Reading$/ })).toBeDefined()
  await ui.unmount()
  const before = w.redraws.count
  await w.clock.advance(3_000)
  expect(w.redraws.count).toBeGreaterThan(before)
})

test('a new crew starts with its rows open, even if the last one was folded away', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'open-a1' })).toBeUndefined()
  await w.complete('t1') // that crew is done
  await $.agent.spawn({ prompt: 'p', description: 'Next job', subagentType: 'Explore' })
  await w.clock.advance(1_000)
  expect(await ui.find({ key: 'open-a1' })).toBeDefined()
  expect(await ui.find({ key: 'collapse' })).toMatchObject({ props: { label: '▾' } })
  await ui.unmount()
})

test('a request that rebuilds the cache leaves the row alone; the details show the cache', async ($, on) => {
  const w = await world($, on, () => [{ id: 'a1', status: 'running' }])
  w.usage.cache_creation_input_tokens = 768_000
  w.usage.cache_read_input_tokens = 2_000
  await w.step('t1', 0)
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await ui.find({ type: 'Text', text: /^15 tok$/ })).toBeDefined() // input and output only
  expect(await ui.find({ type: 'Text', text: /cache/ })).toBeUndefined()
  await ui.press({ key: 'open-a1' })
  expect(await ui.find({ type: 'Text', text: /^768\.0k written · 2\.0k re-read$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cache expires/ })).toBeDefined()
  await ui.unmount()
})
