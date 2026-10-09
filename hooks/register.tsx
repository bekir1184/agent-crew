import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Agent, AgentStatus, Step, Tokens } from '../types'
import {
  QUIET_TOOLS, SPRITE_CELLS, SPRITE_H, SPRITE_W, STALE_MS, activityOf, addUsage, barSvg, capAgents, clip,
  crewSummary, doingText, emptyTokens, estimateText, formatDuration, formatTokens, freshTokens, headerSvg, headline, layout,
  learn, modelShort, sanitizeHistory, shownProgress, spriteSvg, statusColor, stepsFromTodos, targetOf, textBar, textFace,
  tree, typeColor, typeLabel, withActivity, withStepCreated, withStepUpdated,
} from './draw'
import type { History, Layout } from './draw'

// ── State ────────────────────────────────────────────────────
// Everything a drawing reads lives in $.state: it survives a hot reload, and a write redraws
// whatever read it. The module variables below are caches and buffers; session.start fires
// again after every reload and rebuilds them.
const agents = atom({ plugin: 'agent-crew', key: 'agents' } as const, [])
const hidden = atom({ plugin: 'agent-crew', key: 'hidden' } as const, false)
const expanded = atom({ plugin: 'agent-crew', key: 'expanded' } as const, [])

/** Past run durations per (type, model), mirrored from $.store. */
let history: History = {}

/** Ids of the agents on stage. Engine-internal loops (compaction, forks) are never touched. */
const known = new Set<string>()

/**
 * Hot-path buffer. tool.call and turn.step run for every tool and model request of every
 * subagent, so they never read or write state: they note what happened here, and the ticker
 * writes it to $.state once a second. Their only `$` call is a synchronous $.clock.every that
 * restarts a stopped ticker. A subagent's work is never held up by this mod.
 */
type StepOp = { kind: 'create'; id: string; label: string } | { kind: 'update'; change: Record<string, unknown> }
type Pending = {
  tokens?: Tokens
  requests: number
  tools: number
  activity?: Activity
  target?: string
  /** A whole new to-do list (TodoWrite), and task changes queued after it (TaskCreate / TaskUpdate). */
  steps?: Step[]
  stepOps?: StepOp[]
  /** Set by a model request: the agent is running (again, if it was resumed). */
  revive?: boolean
  turnId?: string
}
const pending = new Map<string, Pending>()
const pendingFor = (id: string): Pending => {
  let p = pending.get(id)
  if (!p) pending.set(id, (p = { requests: 0, tools: 0 }))
  return p
}

/** The last turn each agent finished: its buffered events can't bring it back to life. */
const closedTurn = new Map<string, string>()
/** Whether $.agent.list() answers here. While it does, silence alone never retires an agent. */
let listWorks = false

let ticker: { cancel: () => void } | null = null
let tickBusy = false
let ticks = 0
/**
 * Model requests since the last tick. A clock period another plugin refuses ends the interval
 * without telling us; this many requests with no tick means the ticker died and is rebuilt.
 */
let stepsSinceTick = 0
const DEAD_TICKER_STEPS = 30
let demoTick: { cancel: () => void } | null = null

/** A desktop row is exactly this many text rows tall, with the 34 px sprite centered in it. */
const ROW_ROWS = 2
/** Silent this long and missing from the engine's agent list: the agent is gone. */
const GONE_MS = 30_000

export const register: Register = on => {
  // Every hook only observes and ends in `.catch(...)`. tool.call and turn.step, which run for
  // every tool call and model request, never read or write state; so an error in this mod
  // never changes what Claude Code does: the event goes on as if the mod were not installed.

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'crew',
      description: 'Agent Crew: show/hide, run a demo, or clear',
      argumentHint: '[demo | clear]',
    })
    history = sanitizeHistory(await $.store.get('history').catch(() => null))
    const now = await $.clock.now()
    const listed = await listAgents($)
    // A demo's timer died with the previous module; an agent that ended unreported is closed
    await update($, agents, list =>
      list.map(a => {
        if (a.status !== 'running') return a
        const ended = a.demo ? 'cancelled' : verdict(a, now, listed)
        return ended ? { ...a, status: ended, endedAt: now, retired: true as const } : a
      }),
    )
    const current = await read($, agents)
    known.clear()
    for (const a of current) known.add(a.id)
    if (current.some(a => a.status === 'running')) startTicker($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // 1) A subagent started
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId === undefined) return result
    // Tracked before any await: the subagent's first request may arrive during the next one
    known.add(result.agentId)
    const now = await $.clock.now()
    const agent: Agent = {
      id: result.agentId,
      type: e.subagentType,
      description: clip((e.description || e.prompt).replace(/\s+/g, ' ').trim(), 80),
      model: result.model,
      status: 'running',
      activity: 'starting',
      target: '',
      activityAt: now,
      seenAt: now,
      startedAt: now,
      tokens: emptyTokens(),
      tools: 0,
      requests: 0,
      parentId: e.parentAgentId,
    }
    const before = await read($, agents)
    // "Hide" hides this crew: when a new crew starts with nobody running, the stage comes back
    if (!before.some(a => a.status === 'running')) await update($, hidden, () => false)
    await update($, agents, list => capAgents([...list.filter(a => a.id !== agent.id), agent]))
    // Agents the cap removed are no longer tracked
    const kept = await read($, agents)
    known.clear()
    for (const a of kept) known.add(a.id)
    for (const id of closedTurn.keys()) if (!known.has(id)) closedTurn.delete(id)
    startTicker($)
    return result
  }).catch(($, e, next) => next(e))

  // 2) A subagent's tool call: buffered, never awaited
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined || !known.has(id)) return next(e)
    const input = e as unknown as Record<string, unknown>
    const p = pendingFor(id)
    if (!QUIET_TOOLS.has(e.tool)) {
      p.activity = activityOf(e.tool)
      p.target = targetOf(e.tool, input)
      p.tools += 1
      return next(e)
    }
    // The agent's own to-do list: a whole list replaces what came before; task changes are
    // queued and applied by the ticker on top of the latest list
    if (e.tool === 'TodoWrite') {
      p.steps = stepsFromTodos(input.todos)
      p.stepOps = []
    }
    const result = await next(e)
    // The ticker may have flushed the buffer meanwhile: take it again
    const q = pendingFor(id)
    if (e.tool === 'TaskCreate') {
      const task = (result as { result?: { task?: { id?: string; subject?: string } } }).result?.task
      if (task?.id) (q.stepOps ??= []).push({ kind: 'create', id: task.id, label: task.subject ?? String(input.subject ?? '') })
    } else if (e.tool === 'TaskUpdate' && !failed(result)) {
      const { taskId, status, activeForm, subject } = input
      ;(q.stepOps ??= []).push({ kind: 'update', change: { taskId, status, activeForm, subject } })
    }
    return result
  }).catch(($, e, next) => next(e))

  // 3) A subagent's model request: counted in memory. No `$` call, so nothing here can delay
  // or break the request itself.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const tracked = id !== undefined && known.has(id)
    if (tracked) {
      const p = pendingFor(id)
      p.requests += 1
      // A subagent resumed with SendMessage runs again under the same id, in a new turn
      p.revive = true
      p.turnId = e.turnId
      if (e.index > 0) {
        p.activity = 'thinking'
        p.target = ''
      }
      // Everyone had finished, so the ticker stopped: this agent is back, so it starts again.
      // A ticker whose interval was ended by a refused period is rebuilt the same way.
      if (++stepsSinceTick > DEAD_TICKER_STEPS) {
        ticker?.cancel()
        ticker = null
      }
      if (!ticker) startTicker($)
    }
    const answer = yield* next(e)
    const usage = answer.usage
    if (tracked && usage) {
      const p = pendingFor(id)
      p.tokens = addUsage(p.tokens ?? emptyTokens(), usage)
    }
    return answer
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // 4) A subagent finished: done, failed or cancelled (rare, so written right away)
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined || !known.has(id)) return next(e)
    const now = await $.clock.now()
    const status: AgentStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'cancelled' : 'failed'
    const buffered = pending.get(id)
    pending.delete(id)
    let finished: Agent | undefined
    await update($, agents, list => {
      finished = undefined // update() may run this again on a version miss
      return list.map(a => {
        if (a.id !== id) return a
        const caughtUp = applyPending(a, buffered, now)
        // A running agent ends here; so does one the mod had closed, which now gets its real outcome
        if (caughtUp.status !== 'running' && !caughtUp.retired) return caughtUp
        finished = { ...caughtUp, status, endedAt: now, retired: undefined }
        return finished
      })
    })
    // Closed only now: this turn's own buffer (above) may revive a resumed agent, while
    // events of this turn that arrive later must not
    closedTurn.set(id, e.turnId)
    if (finished && status === 'done' && !finished.demo) await remember($, finished, now - finished.startedAt)
    return next(e)
  }).catch(($, e, next) => next(e))

  // 5) A new message: the finished crew leaves the stage
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const list = await read($, agents)
    if (list.length && !list.some(a => a.status === 'running')) {
      await update($, agents, () => [])
      known.clear()
      pending.clear()
      closedTurn.clear()
    }
    const open = await read($, expanded)
    if (open.length) await update($, expanded, () => [])
    return next(e)
  }).catch(($, e, next) => next(e))

  // 6) /crew
  on('command.run', { command: 'crew' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'demo') {
      await startDemo($)
      return { text: 'Demo crew on stage: 4 agents and 2 helpers for about 35 seconds.' }
    }
    if (arg === 'clear') {
      await clearStage($)
      return { text: 'Stage cleared.' }
    }
    const wasHidden = await read($, hidden)
    await update($, hidden, () => !wasHidden)
    return { text: wasHidden ? 'Agent Crew is visible.' : 'Agent Crew hidden. Run /crew to show it again.' }
  }).catch(() => ({ text: 'Agent Crew ran into an error. Run claude --debug for details.' }))

  // 7) Drawing: one aligned row per agent, helpers indented below their parent
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Cheap checks first: while hidden, the drawing doesn't subscribe to the agent list
    const isHidden = await read($, hidden)
    if (isHidden || e.props.hasSurvey) return next(e)
    const list = await read($, agents)
    if (list.length === 0) return next(e)
    const open = await read($, expanded)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The terminal's table has an Svg key too, but draws it as an empty box: decide by surface
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const now = await $.clock.now()
    // bodyColumns leaves out the engine's own marks and a docked pane: the room the band really has
    const L = layout(e.props.bodyColumns || e.viewport?.columns || 120, !!Svg)
    const barPx = L.barCells * 8

    const summary = crewSummary(list, now, history)
    const anyRunning = list.some(a => a.status === 'running')
    const totalFresh = list.reduce((t, a) => t + freshTokens(a.tokens), 0)
    const runningHelpers = (id: string) => list.filter(a => a.parentId === id && a.status === 'running').length
    const right = `${formatTokens(totalFresh)} tokens${anyRunning ? `  ·  crew ~${formatDuration(summary.leftMs)} left` : ''}  ·  ${Math.round(summary.share * 100)}%`

    // The title row alone is framed, in Claude's own color; hiding and clearing live in /crew
    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" borderStyle="round" borderColor="claude" paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
          {Svg ? <Svg source={headerSvg(!anyRunning)} alt="Agent Crew" width={SPRITE_W} height={SPRITE_H} /> : null}
          <Text bold color="claude">AGENT CREW</Text>
          <Text wrap="truncate-end">{headline(list, now)}</Text>
        </Box>
        <Text color="subtle">{right}</Text>
      </Box>
    )

    const rows = tree(list).map(({ a, depth }) => {
      const isOpen = open.includes(a.id)
      const row: RowData = {
        a,
        depth,
        isOpen,
        share: shownProgress(a, now, history),
        est: estimateText(a, now, history),
        doing: doingText(a, now, runningHelpers(a.id)),
        color: statusColor(a),
      }
      const toggle = () => setOpen($, a.id, !isOpen)
      const line = Svg
        ? desktopRow({ Box, Text, Svg, Button }, row, L, barPx, now, toggle)
        : terminalRow({ Box, Text, Button }, row, L, toggle)
      // Every row lives in the same wrapper, open or not, so a toggle never rebuilds the row.
      // Open, the wrapper frames the row and its details in dashed yellow.
      return (
        <Box key={`${a.id}-wrap`} flexDirection="column" borderStyle={isOpen ? 'dashed' : undefined} borderColor={isOpen ? 'warning' : undefined}>
          {line}
          {isOpen ? detailsPanel({ Box, Text }, row, now, depth * 3 + (Svg ? SPRITE_CELLS : 6) + 1) : null}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={Svg ? 1 : 0}>
        {header}
        <Box flexDirection="column">{rows}</Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}

// ── Rows ─────────────────────────────────────────────────────
// The element constructors come from $.ui.resolve(e). Each surface's table is its own type and
// these helpers serve two of them, so they take the constructors loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Els = Record<string, any>
type RowData = {
  a: Agent
  depth: number
  isOpen: boolean
  share: number
  est: { main: string; extra: string }
  doing: { main: string; extra: string }
  color: { theme: string; raw: string }
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ')

function desktopRow({ Box, Text, Svg, Button }: Els, r: RowData, L: Layout, barPx: number, now: number, onToggle: () => void) {
  const { a, depth, isOpen, share, est, doing, color } = r
  const helper = depth > 0
  const indent = depth * 3
  // An open row sits inside a dashed frame, which takes a cell on each side
  const taskCells = Math.max(8, L.task - (helper ? indent + 1 : 0) - (isOpen ? 2 : 0))
  // The desktop's proportional (and bold) font runs wider than its cells: the "doing" text plans with
  // 75% of the column, so it never wraps to a second line. The bold part comes first; the target only
  // shows when at least four characters of it fit.
  const doingChars = Math.floor(L.doing * 0.75)
  const mainText = clip(doing.main, doingChars)
  const extraRoom = doingChars - mainText.length - 2
  const extraText = doing.extra && extraRoom >= 4 ? `  ${clip(oneLine(doing.extra), extraRoom)}` : ''
  const running = a.status === 'running'
  return (
    <Box key={a.id} flexDirection="row" gap={1} alignItems="center" height={ROW_ROWS} paddingRight={1}>
      {helper ? (
        <Box width={indent} justifyContent="flex-end" flexShrink={0}>
          <Text color="subtle">└</Text>
        </Box>
      ) : null}
      <Svg source={spriteSvg(a, now)} alt={`${typeLabel(a.type)}: ${doing.main}`} width={SPRITE_W} height={SPRITE_H} />
      <Box width={L.type} flexShrink={0}>
        <Text bold color={typeColor(a.type)}>{typeLabel(a.type)}</Text>
      </Box>
      <Box width={taskCells} flexGrow={1} flexShrink={0}>
        <Text bold={!helper} dimColor={helper} wrap="truncate-end">{clip(a.description, taskCells - 1)}</Text>
      </Box>
      <Box width={L.doing} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text bold color={color.theme}>{mainText}</Text>
          <Text color="subtle">{extraText}</Text>
        </Text>
      </Box>
      <Svg source={barSvg(share, color.raw, running, barPx, L.barCells, 7)} alt={`${Math.round(share * 100)} percent`} width={barPx} height={7} />
      <Box width={L.pct} flexShrink={0}>
        <Text bold>{Math.round(share * 100)}%</Text>
      </Box>
      <Box width={L.eta} flexShrink={0}>
        <Text bold={running} color={running ? 'text' : 'subtle'}>{est.main}</Text>
      </Box>
      {L.showTokens ? (
        <Box width={L.tokens} flexShrink={0}>
          <Text color="subtle">{formatTokens(freshTokens(a.tokens))} tok</Text>
        </Box>
      ) : null}
      {/* The disclosure arrow ends the row: a button, so it works by click and by keyboard */}
      <Button key={`open-${a.id}`} label={isOpen ? '▾' : '▸'} onPress={onToggle} />
    </Box>
  )
}

function terminalRow({ Box, Text, Button }: Els, r: RowData, L: Layout, onToggle: () => void) {
  const { a, depth, isOpen, share, est, doing, color } = r
  const helper = depth > 0
  const taskCells = Math.max(8, L.task - (helper ? depth * 3 + 1 : 0) - (isOpen ? 2 : 0))
  return (
    <Box key={a.id} flexDirection="row">
      <Text>
        <Text color="subtle">{helper ? `${'   '.repeat(depth - 1)} └ ` : ''}</Text>
        <Text color={color.theme}>{textFace(a.status)} </Text>
        <Text bold color={typeColor(a.type)}>{typeLabel(a.type).padEnd(L.type + 1)}</Text>
      </Text>
      <Box width={taskCells + 1} flexShrink={0}>
        <Text bold={!helper} dimColor={helper} wrap="truncate-end">{clip(a.description, taskCells - 1)}</Text>
      </Box>
      <Text wrap="truncate-end">
        <Text color={color.theme}>{clip(`${doing.main}${doing.extra ? ` ${oneLine(doing.extra)}` : ''}`, L.doing - 1).padEnd(L.doing)}</Text>
        <Text color={color.theme}>{textBar(share, L.barCells - 2, a.status === 'running')} </Text>
        <Text bold>{`${Math.round(share * 100)}%`.padEnd(L.pct)}</Text>
        <Text>{est.main.padEnd(L.eta)}</Text>
        <Text color="subtle">{L.showTokens ? `${formatTokens(freshTokens(a.tokens))} tok`.padEnd(L.tokens) : ''}</Text>
      </Text>
      <Button key={`open-${a.id}`} label={isOpen ? '▾' : '▸'} plain onPress={onToggle} />
    </Box>
  )
}

/** The panel under an open row: everything the row had to cut. */
function detailsPanel({ Box, Text }: Els, r: RowData, now: number, indent: number) {
  const { a, est, doing } = r
  const t = a.tokens
  const elapsed = (a.endedAt ?? now) - a.startedAt
  return (
    <Box key={`${a.id}-details`} flexDirection="column" paddingLeft={indent}>
      <Text>
        <Text color="subtle">Task    </Text>
        <Text>{a.description}</Text>
      </Text>
      {a.status === 'running' && a.target ? (
        <Text>
          <Text color="subtle">Now     </Text>
          <Text>{`${doing.main}: ${a.target}`}</Text>
        </Text>
      ) : null}
      {(a.steps ?? []).map(s => (
        <Text key={`${a.id}-${s.id}`}>
          <Text color="subtle">{s.status === 'completed' ? '  [x] ' : s.status === 'in_progress' ? '  [>] ' : '  [ ] '}</Text>
          <Text bold={s.status === 'in_progress'} dimColor={s.status === 'completed'}>{s.label}</Text>
        </Text>
      ))}
      <Text>
        <Text color="subtle">Tokens  </Text>
        <Text>{`${formatTokens(freshTokens(t))} new`}</Text>
        <Text color="subtle">{`  (input ${formatTokens(t.input)} · output ${formatTokens(t.output)} · cache write ${formatTokens(t.cacheWrite)})  ·  ${formatTokens(t.cacheRead)} re-read from cache`}</Text>
      </Text>
      <Text>
        <Text color="subtle">Run     </Text>
        <Text>{`${modelShort(a.model)} · ${a.tools} tools · ${a.requests} requests · ${formatDuration(elapsed)} elapsed`}</Text>
        <Text color="subtle">{a.status === 'running' ? `  ·  ${est.main}${est.extra ? ` (${est.extra})` : ''}` : ''}</Text>
      </Text>
    </Box>
  )
}

// ── Pure helpers ─────────────────────────────────────────────
/** Whether a tool call failed: an error result, or a task update that reports no success. */
function failed(result: unknown): boolean {
  const r = result as { isError?: boolean; deny?: string; result?: { success?: boolean } }
  return r.isError === true || r.deny !== undefined || r.result?.success === false
}

/** Folds an agent's buffered events into it; any event also counts as a sign of life. */
function applyPending(a: Agent, p: Pending | undefined, now: number): Agent {
  if (!p) return a
  let next: Agent = { ...a, seenAt: now, requests: a.requests + p.requests, tools: a.tools + p.tools }
  // A model request means the agent runs: resumed after it finished, unless that request
  // belongs to the very turn that already ended (its events arrived after the end)
  const lateEvents = p.turnId !== undefined && p.turnId === closedTurn.get(a.id)
  if (p.revive && !lateEvents && a.status !== 'running') next = { ...next, status: 'running', endedAt: undefined, shownShare: 0, retired: undefined }
  if (p.tokens) {
    const t = p.tokens
    next = { ...next, tokens: addUsage(next.tokens, { input_tokens: t.input, output_tokens: t.output, cache_creation_input_tokens: t.cacheWrite, cache_read_input_tokens: t.cacheRead }) }
  }
  if (p.steps || p.stepOps?.length) {
    let steps = p.steps ?? next.steps ?? []
    for (const op of p.stepOps ?? []) steps = op.kind === 'create' ? withStepCreated(steps, op.id, op.label) : withStepUpdated(steps, op.change)
    next = { ...next, steps }
  }
  if (p.activity !== undefined && next.status === 'running') next = withActivity(next, p.activity, p.target ?? '', now)
  return next
}

/**
 * How a running agent ended when its turn.complete never came, or null while it still runs.
 * The engine's agent list decides: an agent it reports ended is closed with that outcome, one it
 * no longer lists is closed after GONE_MS of silence, and one it lists as running is left alone
 * however long it is quiet (a 20-minute build is not a dead agent). Only without that list does
 * silence alone (STALE_MS) retire an agent.
 */
function verdict(a: Agent, now: number, listed: Map<string, string> | null): AgentStatus | null {
  if (a.demo) return null
  if (listed) {
    const status = listed.get(a.id)
    if (status === undefined) return now - a.seenAt > GONE_MS ? 'cancelled' : null
    if (status === 'completed') return 'done'
    if (status === 'failed') return 'failed'
    if (status === 'killed') return 'cancelled'
    return null
  }
  if (listWorks) return null
  return now - a.seenAt > STALE_MS ? 'cancelled' : null
}

// ── Helpers that use $ (they must stay in the hooks file) ────
/** The engine's agents by id and status, or null where the list isn't available. */
async function listAgents($: EngineInterface): Promise<Map<string, string> | null> {
  const listed = await $.agent.list().catch(() => null)
  if (!listed) return null
  listWorks = true
  return new Map(listed.map(x => [x.id, x.status]))
}

/** One row open at a time: opening a row closes the others. Writes only on a real change. */
async function setOpen($: EngineInterface, id: string, open: boolean) {
  const ids = await read($, expanded)
  const already = open ? ids.length === 1 && ids[0] === id : !ids.includes(id)
  if (already) return
  await update($, expanded, current => (open ? [id] : current.filter(x => x !== id)))
}

/**
 * The once-a-second heartbeat: flushes the hot-path buffer, records each bar's high-water
 * mark, retires agents whose end was never reported, and redraws the clocks. At most one
 * write and one redraw per tick, and ticks never overlap.
 */
function startTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    if (tickBusy) return
    tickBusy = true
    void tick($)
      .catch(() => undefined)
      .finally(() => {
        tickBusy = false
      })
  })
}

async function tick($: EngineInterface) {
  stepsSinceTick = 0
  const now = await $.clock.now()
  ticks += 1
  // Every 10 s, ask the engine where each agent stands: a missing turn.complete would
  // otherwise leave an agent "running" forever
  const listed = ticks % 10 === 0 ? await listAgents($) : null
  const buffered = new Map(pending)
  pending.clear()

  const before = await read($, agents)
  // A just-spawned agent may not be in the state yet: its buffer waits for the next tick
  for (const [id, p] of buffered) {
    if (!before.some(a => a.id === id) && known.has(id)) {
      pending.set(id, p)
      buffered.delete(id)
    }
  }
  const needsWrite =
    buffered.size > 0 ||
    before.some(a => {
      if (a.status !== 'running') return false
      if (verdict(a, now, listed)) return true
      // The bar's high-water mark, written when it reaches a new segment (1/14 of the bar)
      return Math.floor(shownProgress(a, now, history) * 14) > Math.floor((a.shownShare ?? 0) * 14)
    })
  if (needsWrite) {
    await update($, agents, list =>
      list.map(a => {
        let next = applyPending(a, buffered.get(a.id), now)
        if (next.status !== 'running') return next
        const ended = verdict(next, now, listed)
        if (ended) return { ...next, status: ended, endedAt: now, retired: true as const }
        const share = shownProgress(next, now, history)
        if (share > (next.shownShare ?? 0)) next = { ...next, shownShare: share }
        return next
      }),
    )
  }
  const after = needsWrite ? await read($, agents) : before
  // A resumed agent's events may still sit in the buffer: it counts as running
  const reviving = () => [...pending.values()].some(p => p.revive)
  if (!after.some(a => a.status === 'running') && !reviving()) {
    ticker?.cancel()
    ticker = null
    // An agent spawned or resumed between the read and the cancel would otherwise go without a ticker
    const fresh = await read($, agents)
    if (fresh.some(a => a.status === 'running') || reviving()) startTicker($)
  }
  const isHidden = await read($, hidden)
  if (!needsWrite && !isHidden) $.ui.invalidate('ui.render')
}

/** Learns a finished run. Re-reads the store first, so two open sessions don't overwrite each other. */
async function remember($: EngineInterface, agent: Agent, ms: number) {
  const stored = sanitizeHistory(await $.store.get('history').catch(() => null))
  history = learn(stored, agent, { ms, requests: agent.requests })
  await $.store.set('history', history).catch(() => undefined)
}

/** Clears the stage: the agents, any open details, and a running demo. */
async function clearStage($: EngineInterface) {
  demoTick?.cancel()
  demoTick = null
  pending.clear()
  known.clear()
  closedTurn.clear()
  await update($, agents, () => [])
  await update($, expanded, () => [])
}

// ── Demo ─────────────────────────────────────────────────────
/** A fake crew to see the design without real subagents: it walks every activity and outcome. */
type DemoStep = [Activity, string]
type DemoAgent = { type: string; description: string; at: number; ms: number; end: AgentStatus; steps: DemoStep[]; parent?: number; todo?: string[] }
const DEMO: DemoAgent[] = [
  { type: 'Explore', description: 'Map the auth flow', at: 0, ms: 16_000, end: 'done', steps: [['searching', 'func login('], ['reading', 'AuthService.swift'], ['searching', '**/*Token*'], ['reading', 'KeychainStore.swift'], ['thinking', '']] },
  { type: 'general-purpose', description: 'Write and run the tests', at: 0, ms: 36_000, end: 'done', todo: ['Review existing tests', 'Prepare fixtures', 'Write login tests', 'Run the tests', 'Fix failures'], steps: [['thinking', ''], ['reading', 'AuthTests.swift'], ['writing', 'AuthTests.swift'], ['running', 'xcodebuild test -scheme App'], ['writing', 'AuthTests.swift'], ['running', 'xcodebuild test -scheme App']] },
  { type: 'Plan', description: 'Plan the refactor', at: 0, ms: 24_000, end: 'failed', steps: [['reading', 'Package.swift'], ['thinking', ''], ['searching', 'protocol .*Service'], ['thinking', '']] },
  { type: 'general-purpose', description: 'Check the API docs', at: 0, ms: 20_000, end: 'cancelled', steps: [['web', 'developer.apple.com/documentation/foundation/urlsession'], ['reading', 'URLSession+Async.swift'], ['web', 'swift.org/documentation']] },
  { type: 'Explore', description: 'Find mock data', at: 8_000, ms: 12_000, end: 'done', parent: 1, steps: [['searching', 'MockUser'], ['reading', 'Fixtures.swift']] },
  { type: 'general-purpose', description: 'Write fixtures', at: 9_000, ms: 15_000, end: 'done', parent: 1, steps: [['writing', 'UserFixture.swift'], ['running', 'swift build']] },
]

async function startDemo($: EngineInterface) {
  const t0 = await $.clock.now()
  const crew: Agent[] = DEMO.map((d, i) => ({
    id: `demo-${i}`, type: d.type, description: d.description, model: 'demo', status: 'running', activity: 'starting', target: '',
    activityAt: t0, seenAt: t0, startedAt: t0 + d.at, tokens: emptyTokens(), tools: 0, requests: 0, demo: true, expectedMs: d.ms,
    parentId: d.parent !== undefined ? `demo-${d.parent}` : undefined,
  }))
  // Cancel after the await: two demos started at once must not leave two timers running.
  // Clearing the handle too stops a callback already in flight from the old demo.
  demoTick?.cancel()
  demoTick = null
  await update($, hidden, () => false)
  await update($, agents, list => [...list.filter(a => !a.demo), ...crew.filter((_, i) => DEMO[i].at === 0)])
  for (const a of crew) known.add(a.id)
  startTicker($)

  const timer = $.clock.every(900, () => {
    void (async () => {
      const now = await $.clock.now()
      let more = false
      await update($, agents, list => {
        // A tick already in flight when the demo was cleared or restarted changes nothing
        if (demoTick !== timer) return list
        const arriving = crew.filter((a, i) => DEMO[i].at > 0 && now >= a.startedAt && !list.some(b => b.id === a.id))
        if (crew.some((a, i) => DEMO[i].at > 0 && now < a.startedAt)) more = true
        return [...list, ...arriving].map(a => {
          if (!a.demo || a.status !== 'running') return a
          const d = DEMO[Number(a.id.slice(5))]
          const elapsed = now - a.startedAt
          if (elapsed >= d.ms) return { ...a, status: d.end, endedAt: now }
          more = true
          if (elapsed < 2000) return { ...a, seenAt: now, tokens: addUsage(a.tokens, { input_tokens: 300, output_tokens: 40 }) }
          const share = (elapsed - 2000) / (d.ms - 2000)
          const [activity, target] = d.steps[Math.min(d.steps.length - 1, Math.floor(share * d.steps.length))]
          // The demo agent with a to-do list completes its steps in order
          const steps = d.todo?.map((label, i) => {
            const k = Math.floor(share * d.todo!.length)
            return { id: `t${i}`, label, status: (i < k ? 'completed' : i === k ? 'in_progress' : 'pending') as Step['status'] }
          })
          const changed = activity !== a.activity || target !== a.target
          return {
            ...withActivity(a, activity, target, now),
            seenAt: now,
            steps,
            tools: a.tools + (changed && activity !== 'thinking' ? 1 : 0),
            requests: a.requests + (changed ? 1 : 0),
            tokens: addUsage(a.tokens, {
              input_tokens: 200 + Math.round(Math.random() * 400),
              output_tokens: 150 + Math.round(Math.random() * 500),
              cache_creation_input_tokens: Math.round(Math.random() * 900),
              cache_read_input_tokens: 8000 + Math.round(Math.random() * 6000),
            }),
          }
        })
      })
      if (!more && demoTick === timer) {
        timer.cancel()
        demoTick = null
      }
    })()
  })
  demoTick = timer
}
