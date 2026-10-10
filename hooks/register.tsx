import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Agent, AgentStatus, RecentTool, Step, Tokens, TouchedFile } from '../types'
import {
  QUIET_TOOLS, SPRITE_CELLS, SPRITE_H, SPRITE_W, STALE_MS, activityOf, addUsage, barSvg, capAgents, clip, costOf, formatCost,
  crewSummary, doingText, emptyTokens, statusLabel, fileOf, filesSummary, withFiles, estimateText, formatDuration, formatTokens, workTokens, tokenText, sumTokens, cacheIsNotable, headerSvg, headline, layout,
  learn, modelShort, modelLabel, redact, sanitizeHistory, statusText, shownProgress, spriteSvg, statusColor, stepsFromTodos, targetOf, textBar, DOT, dotColor, labelSvg, LABEL_W, LABEL_H,
  tree, typeColor, typeLabel, withActivity, withStepCreated, withStepUpdated,
} from './draw'
import type { History, Layout } from './draw'

// ── State ────────────────────────────────────────────────────
// Everything a drawing reads lives in $.state: it survives a hot reload, and a write redraws
// whatever read it. The module variables below are caches and buffers; session.start fires
// again after every reload and rebuilds them.
const agents = atom({ plugin: 'agent-crew', key: 'agents' } as const, [])
const main = atom({ plugin: 'agent-crew', key: 'main' } as const, null)
const hidden = atom({ plugin: 'agent-crew', key: 'hidden' } as const, false)
const expanded = atom({ plugin: 'agent-crew', key: 'expanded' } as const, [])
/** The title row's arrow: hides the agent rows below it, leaving the title as the whole view. */
const collapsed = atom({ plugin: 'agent-crew', key: 'collapsed' } as const, false)
/** The title's minimise button: the whole band shrinks to one plain line. Kept across sessions in $.store. */
const minimized = atom({ plugin: 'agent-crew', key: 'minimized' } as const, false)

/** Settings from the /config menu (userConfig); a change there reloads the module. */
let showCost = false
let showMain = true
/** The main conversation's key in the hot-path buffer; it is drawn on the title row, never as a row. */
const MAIN_ID = 'main'
/** The main turn running now, or null between turns: main-loop events count only while it runs. */
let mainTurn: string | null = null
/** What this mod last put on the status line, so it only writes on a change. */
let lastStatus: string | undefined
/** The project folder: files under it are shown relative to it. */
let cwd = ''
/** How many recent tool calls an agent keeps for its details panel. */
const RECENT_TOOLS = 5

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
  /** The tool the agent asked approval for (a string), or null once that was answered. */
  approval?: string | null
  /** Tool calls finished since the last flush, for the details panel. */
  recent?: RecentTool[]
  files?: TouchedFile[]
  /** The model a request named: the main conversation learns its model from its requests. */
  model?: string
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
/**
 * A demo is on stage. Made for a screen recording, so meanwhile the prompt box shows the demo's
 * own English hint instead of Claude Code's guess at your next message.
 */
let demoOnStage = false
const DEMO_HINT = '/crew clear'
/**
 * On the desktop the band's text column is about twice as roomy as its reported width suggests:
 * the task box grows to fill the row, so its text may use twice the planned cells before it is cut.
 */
const DESKTOP_TEXT_ROOM = 2

/**
 * Terminal hotkeys, live once the band has the focus (ctrl+x tab): the title's arrow, then one
 * letter per row in order. Letters only: a digit typed into an empty prompt would also press a
 * band button, so a message starting with "1." would open a row.
 */
const TITLE_KEY = 'h'
/** The terminal's key for the minimise button. */
const MIN_KEY = 'z'
const ROW_KEYS = [...'abcdefgijklm']

/** A desktop row is exactly this many text rows tall, with the 34 px sprite centered in it. */
const ROW_ROWS = 2
/** Silent this long and missing from the engine's agent list: the agent is gone. */
const GONE_MS = 30_000

export const register: Register = (on, options) => {
  showCost = options?.showCost === true
  showMain = options?.showMain !== false

  // Every hook only observes and ends in `.catch(...)`. tool.call and turn.step, which run for
  // every tool call and model request, never read or write state; so an error in this mod
  // never changes what Claude Code does: the event goes on as if the mod were not installed.

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'crew',
      description: 'Agent Crew: show/hide, run a demo, or clear',
      argumentHint: '[demo | clear]',
    })
    cwd = e.cwd ?? ''
    history = sanitizeHistory(await $.store.get('history').catch(() => null))
    const wasMinimized = (await $.store.get('minimized').catch(() => null)) === true
    if (wasMinimized !== (await read($, minimized))) await update($, minimized, () => wasMinimized)
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
    // After a reload the main turn is read back from the state: its turn.complete still comes.
    // A demo's main line died with its timer.
    const m = await read($, main)
    if (m?.demo) await update($, main, () => null)
    mainTurn = m && !m.demo ? (m.turnId ?? null) : null
    if (current.some(a => a.status === 'running') || mainTurn) startTicker($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // 0) The main conversation starts a turn: the title row shows Claude's own work
  on('turn.start', async ($, e, next) => {
    if (!showMain) return next(e)
    // Tracked before any await: the turn's first request may arrive during the next one
    mainTurn = e.turnId
    pending.delete(MAIN_ID)
    const now = await $.clock.now()
    const record: Agent = {
      id: MAIN_ID,
      type: 'main',
      description: clip(redact(e.text.replace(/\s+/g, ' ').trim()), 80),
      model: '',
      status: 'running',
      activity: 'thinking',
      target: '',
      activityAt: now,
      seenAt: now,
      startedAt: now,
      tokens: emptyTokens(),
      tools: 0,
      requests: 0,
      turnId: e.turnId,
    }
    await update($, main, () => record)
    startTicker($)
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
      description: clip(redact((e.description || e.prompt).replace(/\s+/g, ' ').trim()), 80),
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
    // A new crew starts open: the rows show until you fold them away with the title's arrow
    if (!before.some(a => a.status === 'running')) {
      await update($, hidden, () => false)
  await update($, collapsed, () => false)
      const folded = await read($, collapsed)
      if (folded) await update($, collapsed, () => false)
    }
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
    // A main-loop call (no agentId) belongs to the title row while the main turn runs
    const id = e.agentId ?? (mainTurn !== null ? MAIN_ID : undefined)
    if (id === undefined || (id !== MAIN_ID && !known.has(id))) return next(e)
    const input = e as unknown as Record<string, unknown>
    const p = pendingFor(id)
    if (!QUIET_TOOLS.has(e.tool)) {
      const target = targetOf(e.tool, input)
      p.activity = activityOf(e.tool)
      p.target = target
      p.tools += 1
      // Awaited only to see the outcome: no `$` call, so the tool runs exactly as it would
      const result = await next(e)
      const q = pendingFor(id)
      q.approval = null // the call went ahead, so any approval it waited for was answered
      ;(q.recent ??= []).push({ label: clip(`${e.tool} ${target}`.trim(), 80), ...(failed(result) ? { failed: true } : {}) })
      const file = failed(result) ? null : fileOf(e.tool, input, cwd)
      if (file) (q.files ??= []).push(file)
      return result
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
    const isMain = e.agentId === undefined && mainTurn !== null && e.turnId === mainTurn
    const id = isMain ? MAIN_ID : e.agentId
    const tracked = id !== undefined && (isMain || known.has(id))
    if (tracked) {
      const p = pendingFor(id)
      p.requests += 1
      if (isMain) p.model = e.model
      // A subagent resumed with SendMessage runs again under the same id, in a new turn
      p.revive = true
      p.turnId = e.turnId
      if (p.approval) p.approval = null
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

  // A subagent asks the person to approve a tool call: its row says so until the call goes on.
  // Observed only: the decision is the person's and Claude Code's, never this mod's.
  on('classic.PermissionRequest', ($, e, next) => {
    const id = e.agent_id ?? (mainTurn !== null ? MAIN_ID : undefined)
    if (id !== undefined && (id === MAIN_ID || known.has(id))) pendingFor(id).approval = clip(`${e.tool_name} ${targetOf(e.tool_name, (e.tool_input ?? {}) as Record<string, unknown>)}`.trim(), 80)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PermissionDenied', ($, e, next) => {
    const id = e.agent_id ?? (mainTurn !== null ? MAIN_ID : undefined)
    if (id !== undefined && (id === MAIN_ID || known.has(id))) pendingFor(id).approval = null
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear starts a fresh conversation: the finished crew leaves with the old one
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      const m = await read($, main)
      if (m && m.status !== 'running') await update($, main, () => null)
      const list = await read($, agents)
      if (list.some(a => a.status !== 'running')) await update($, agents, l => l.filter(a => a.status === 'running'))
      const kept = await read($, agents)
      known.clear()
      for (const a of kept) known.add(a.id)
      const open = await read($, expanded)
      if (open.length) await update($, expanded, () => [])
      if (!kept.length) setStatus($, undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // 4) A subagent finished: done, failed or cancelled (rare, so written right away)
  on('turn.complete', async ($, e, next) => {
    // The main turn ended: its record keeps the turn's final numbers, which the thin line shows
    if (e.agentId === undefined && mainTurn !== null && e.turnId === mainTurn) {
      mainTurn = null
      const buffered = pending.get(MAIN_ID)
      pending.delete(MAIN_ID)
      const now = await $.clock.now()
      const status: AgentStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'cancelled' : 'failed'
      await update($, main, m => (m && m.status === 'running' ? { ...applyPending(m, buffered, now), status, endedAt: now, waitingFor: undefined } : m))
      return next(e)
    }
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
        finished = { ...caughtUp, status, endedAt: now, retired: undefined, waitingFor: undefined }
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
      demoOnStage = false
      await update($, agents, () => [])
      known.clear()
      pending.clear()
      closedTurn.clear()
      setStatus($, undefined)
    }
    const open = await read($, expanded)
    if (open.length) await update($, expanded, () => [])
    return next(e)
  }).catch(($, e, next) => next(e))

  // While a demo is on stage, Claude Code's own prompt suggestion stays out of the recording;
  // any other time, suggestions pass untouched
  on('prompt.suggest', ($, e, next) => {
    if (demoOnStage && e.origin?.kind === 'suggestion') return { isShown: false }
    return next(e)
  }).catch(($, e, next) => next(e))

  // 6) /crew
  on('command.run', { command: 'crew' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'demo') {
      await startDemo($)
      return { text: 'Demo crew on stage: Claude starts alone, then 3 agents and a helper join, for about 30 seconds.' }
    }
    if (arg === 'clear') {
      await clearStage($)
      return { text: 'Stage cleared.' }
    }
    const wasHidden = await read($, hidden)
    await update($, hidden, () => !wasHidden)
    await refreshStatus($)
    return { text: wasHidden ? 'Agent Crew is visible.' : 'Agent Crew hidden. Run /crew to show it again.' }
  }).catch(() => ({ text: 'Agent Crew ran into an error. Run claude --debug for details.' }))

  // 7) Drawing: one aligned row per agent, helpers indented below their parent
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Cheap checks first: while hidden, the drawing doesn't subscribe to the agent list
    const isHidden = await read($, hidden)
    if (isHidden || e.props.hasSurvey) return next(e)
    const list = shown(await read($, agents))
    const m = await read($, main)
    const working = m?.status === 'running' ? m : null
    if (list.length === 0 && !m) return next(e)
    const open = await read($, expanded)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The terminal's table has an Svg key too, but draws it as an empty box: decide by surface
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const now = await $.clock.now()
    // bodyColumns leaves out the engine's own marks and a docked pane: the room the band really has
    const L = layout(e.props.bodyColumns || e.viewport?.columns || 120, !!Svg, showCost)
    const barPx = L.barCells * 8

    const summary = crewSummary(list, now, history)
    const anyRunning = list.some(a => a.status === 'running')
    const runningHelpers = (id: string) => list.filter(a => a.parentId === id && a.status === 'running').length
    const crewCost = showCost ? sumCost(list) : null
    const hasCrew = list.length > 0
    // Alone, the title is Claude's own line: how long it has worked and what it spent
    const mainCost = m && showCost ? costOf(m.model, m.tokens)?.total ?? null : null
    const right = hasCrew
      ? [
          tokenText(sumTokens([...list.map(a => a.tokens), ...(working ? [working.tokens] : [])]), 'tokens'),
          crewCost !== null ? formatCost(crewCost + (mainCost ?? 0)) : '',
          anyRunning ? `crew ~${formatDuration(summary.leftMs)} left` : '',
          `${Math.round(summary.share * 100)}%`,
        ].filter(Boolean).join('  ·  ')
      : [
          formatDuration((m!.endedAt ?? now) - m!.startedAt),
          tokenText(m!.tokens, 'tokens'),
          mainCost !== null ? formatCost(mainCost) : '',
        ].filter(Boolean).join('  ·  ')
    const isCollapsed = await read($, collapsed)
    const isMinimized = await read($, minimized)
    // What the title says: an approval a subagent waits on first, then Claude's own work, then the crew's state
    const crewAsks = list.some(a => a.status === 'running' && a.waitingFor)
    // Claude waiting on the subagents it started (the Agent tool shows no activity of its own)
    const waitsOn = list.filter(a => !a.parentId && a.status === 'running').length
    const idle = working && (working.activity === 'thinking' || working.activity === 'starting') && !working.waitingFor
    const own = !working || crewAsks ? null : idle && waitsOn ? { main: 'Waiting', extra: `on ${waitsOn} agent${waitsOn > 1 ? 's' : ''}`, alert: false } : doingText(working, now, 0)
    // Claude's own model sits beside the title while it works
    const ownModel = working ? modelLabel(working.model) : ''
    const room = Math.max(12, Math.floor(((e.props.bodyColumns || e.viewport?.columns || 120) - right.length - 26 - ownModel.length) * (Svg ? 0.75 * DESKTOP_TEXT_ROOM : 1)))
    const said = own ? `${own.main}${own.extra ? `  ${oneLine(own.extra)}` : ''}` : headline(list, now)

    const toggleMinimized = () => setMinimized($, !isMinimized)
    if (isMinimized) {
      // One plain line, no frame and no sprite: the title, what it says now, and its numbers
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
          <Text wrap="truncate-end">
            <Text bold color="claude">{hasCrew ? 'AGENT CREW' : 'AGENT'}</Text>
            <Text color={own?.alert ? 'warning' : 'subtle'}>{`  ${clip(working || hasCrew ? said : statusLabel(m!), room)}`}</Text>
          </Text>
          <Box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
            <Text color="subtle">{right}</Text>
            {Svg ? (
              <Button key="minimize" label="▸" onPress={toggleMinimized} />
            ) : (
              <Button key="minimize" label="▸" hotkey={MIN_KEY} plain onPress={toggleMinimized} />
            )}
          </Box>
        </Box>
      )
    }

    // The title row alone is framed, in Claude's own color; hiding and clearing live in /crew
    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" borderStyle="round" borderColor="claude" paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
          {Svg ? (
            <Svg source={working ? spriteSvg(working, now) : headerSvg(!anyRunning)} alt={hasCrew ? 'Agent Crew' : 'Agent'} width={SPRITE_W} height={SPRITE_H} />
          ) : (
            <Text color={dotColor(working ?? { status: anyRunning ? 'running' : 'done' })}>{DOT}</Text>
          )}
          <Box flexShrink={0}>
            <Text bold color="claude">{hasCrew ? 'AGENT CREW' : 'AGENT'}</Text>
          </Box>
          {ownModel ? (
            <Box flexShrink={0}>
              <Text color="subtle">{ownModel}</Text>
            </Box>
          ) : null}
          <Text wrap="truncate-end" color={own?.alert ? 'warning' : undefined}>{clip(said, room)}</Text>
        </Box>
        <Box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
          <Text color="subtle">{right}</Text>
          {Svg ? (
            <Button key="minimize" label="–" onPress={toggleMinimized} />
          ) : (
            <Button key="minimize" label="–" hotkey={MIN_KEY} plain onPress={toggleMinimized} />
          )}
          {/* The title's arrow shows or hides the subagent rows; alone, it opens Claude's own details */}
          {!hasCrew ? (
            Svg ? (
              <Button key="open-main" label={open.includes(MAIN_ID) ? '▾' : '▸'} onPress={() => setOpen($, MAIN_ID, !open.includes(MAIN_ID))} />
            ) : (
              <Button key="open-main" label={open.includes(MAIN_ID) ? '▾' : '▸'} hotkey={TITLE_KEY} plain onPress={() => setOpen($, MAIN_ID, !open.includes(MAIN_ID))} />
            )
          ) : Svg ? (
            <Button key="collapse" label={isCollapsed ? '▸' : '▾'} onPress={() => update($, collapsed, c => !c)} />
          ) : (
            <Button key="collapse" label={isCollapsed ? '▸' : '▾'} hotkey={TITLE_KEY} plain onPress={() => update($, collapsed, c => !c)} />
          )}
        </Box>
      </Box>
    )
    if (isCollapsed) return header
    if (!hasCrew) {
      // Claude alone: the arrow opens the details of its turn under the title
      const isOpen = open.includes(MAIN_ID)
      const details = isOpen ? detailsPanel({ Box, Text }, { a: m!, depth: 0, isOpen, share: 0, est: { main: '', extra: '' }, doing: own ?? doingText(m!, now, 0), color: statusColor(m!) }, now, 2) : null
      if (working) return details ? <Box flexDirection="column">{header}{details}</Box> : header
      return thinLine({ Box, Text, Button }, m!, now, isOpen, () => setOpen($, MAIN_ID, !isOpen), !!Svg, details)
    }

    const rows = tree(list).map(({ a, depth }, index) => {
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
        : terminalRow({ Box, Text, Button }, row, L, toggle, ROW_KEYS[index])
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
  doing: { main: string; extra: string; alert?: boolean }
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
      {/* The type, and under it the model the agent runs on, drawn small */}
      <Box width={L.type} flexShrink={0}>
        <Svg source={labelSvg(a.type, a.model)} alt={[typeLabel(a.type), modelLabel(a.model)].filter(Boolean).join(', ')} width={LABEL_W} height={LABEL_H} />
      </Box>
      <Box width={taskCells} flexGrow={1} flexShrink={0}>
        <Text bold={!helper} dimColor={helper} wrap="truncate-end">{clip(a.description, (taskCells - 1) * DESKTOP_TEXT_ROOM)}</Text>
      </Box>
      <Box width={L.doing} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text bold color={doing.alert ? 'warning' : color.theme}>{mainText}</Text>
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
          <Text color="subtle">{tokenCell(a)}</Text>
        </Box>
      ) : null}
      {/* The disclosure arrow ends the row: a button, so it works by click and by keyboard */}
      <Button key={`open-${a.id}`} label={isOpen ? '▾' : '▸'} onPress={onToggle} />
    </Box>
  )
}

function terminalRow({ Box, Text, Button }: Els, r: RowData, L: Layout, onToggle: () => void, hotkey: string | undefined) {
  const { a, depth, isOpen, share, est, doing, color } = r
  const helper = depth > 0
  const taskCells = Math.max(8, L.task - (helper ? depth * 3 + 1 : 0) - (isOpen ? 2 : 0))
  return (
    <Box key={a.id} flexDirection="row">
      <Text>
        <Text color="subtle">{helper ? `${'   '.repeat(depth - 1)} └ ` : ''}</Text>
        <Text color={dotColor(a)}>{`${DOT} `}</Text>
        <Text bold color={typeColor(a.type)}>{typeLabel(a.type).padEnd(L.type + 1)}</Text>
        <Text color="subtle">{L.model ? (modelLabel(a.model) ? modelShort(a.model) : '').padEnd(L.model) : ''}</Text>
      </Text>
      <Box width={taskCells + 1} flexShrink={0}>
        <Text bold={!helper} dimColor={helper} wrap="truncate-end">{clip(a.description, taskCells - 1)}</Text>
      </Box>
      <Text wrap="truncate-end">
        <Text color={doing.alert ? 'warning' : color.theme}>{clip(`${doing.main}${doing.extra ? ` ${oneLine(doing.extra)}` : ''}`, L.doing - 1).padEnd(L.doing)}</Text>
        <Text color={color.theme}>{textBar(share, L.barCells - 2, a.status === 'running')} </Text>
        <Text bold>{`${Math.round(share * 100)}%`.padEnd(L.pct)}</Text>
        <Text>{est.main.padEnd(L.eta)}</Text>
        <Text color="subtle">{L.showTokens ? tokenCell(a).padEnd(L.tokens) : ''}</Text>
      </Text>
      {hotkey ? (
        <Button key={`open-${a.id}`} label={isOpen ? '▾' : '▸'} hotkey={hotkey} plain onPress={onToggle} />
      ) : (
        <Button key={`open-${a.id}`} label={isOpen ? '▾' : '▸'} plain onPress={onToggle} />
      )}
    </Box>
  )
}

/**
 * Claude's last turn, once it ended and no subagents are on stage: one thin line, no critter and
 * no frame, with the turn's final numbers. Its arrow opens the turn's details.
 */
function thinLine({ Box, Text, Button }: Els, m: Agent, now: number, isOpen: boolean, onToggle: () => void, desktop: boolean, details: unknown) {
  const took = formatDuration((m.endedAt ?? now) - m.startedAt)
  const cost = showCost ? costOf(m.model, m.tokens) : null
  const facts = [modelLabel(m.model), `last turn ${took}`, tokenText(m.tokens, 'tokens'), cost ? formatCost(cost.total) : '', `${m.tools} tool${m.tools === 1 ? '' : 's'}`].filter(Boolean).join('  ·  ')
  const line = (
    <Box key="main-line" flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color="claude">AGENT</Text>
        <Text color={statusColor(m).theme}>{`  ${statusLabel(m)}`}</Text>
        <Text color="subtle">{`  ·  ${facts}`}</Text>
      </Text>
      {desktop ? <Button key="open-main" label={isOpen ? '▾' : '▸'} onPress={onToggle} /> : <Button key="open-main" label={isOpen ? '▾' : '▸'} hotkey={TITLE_KEY} plain onPress={onToggle} />}
    </Box>
  )
  return details ? (
    <Box flexDirection="column" borderStyle="dashed" borderColor="warning">
      {line}
      {details}
    </Box>
  ) : (
    line
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
      {a.recent?.length ? (
        <Text wrap="truncate-end">
          <Text color="subtle">Recent  </Text>
          <Text>{a.recent.map(t => `${t.label}${t.failed ? ' (failed)' : ''}`).join('  ·  ')}</Text>
        </Text>
      ) : null}
      {fileLines({ Text }, a)}
      {showCost ? costLine({ Text }, a) : null}
      <Text>
        <Text color="subtle">Tokens  </Text>
        <Text>{formatTokens(workTokens(t))}</Text>
        <Text color="subtle">{`  (input ${formatTokens(t.input)} · output ${formatTokens(t.output)})`}</Text>
      </Text>
      <Text>
        <Text color="subtle">Cache   </Text>
        <Text>{`${formatTokens(t.cacheWrite)} written · ${formatTokens(t.cacheRead)} re-read`}</Text>
        <Text color="subtle">
          {cacheIsNotable(t)
            ? '  ·  after a pause the cache expires, and the next request writes the conversation to it again'
            : '  ·  the conversation, kept by Claude between requests'}
        </Text>
      </Text>
      <Text>
        <Text color="subtle">Run     </Text>
        <Text>{`${modelShort(a.model)} · ${a.tools} tools · ${a.requests} requests · ${formatDuration(elapsed)} elapsed`}</Text>
        <Text color="subtle">{a.status === 'running' && est.main ? `  ·  ${est.main}${est.extra ? ` (${est.extra})` : ''}` : ''}</Text>
      </Text>
    </Box>
  )
}

/** The files the agent changed and read, newest first; each list cut to the panel's width. */
function fileLines({ Text }: Els, a: Agent) {
  if (!a.files?.length) return null
  const { changed, read: seen } = filesSummary(a.files)
  const line = (key: string, label: string, paths: string[]) =>
    paths.length ? (
      <Text key={`${a.id}-${key}`} wrap="truncate-end">
        <Text color="subtle">{label}</Text>
        <Text>{paths.join('  ·  ')}</Text>
      </Text>
    ) : null
  return [line('changed', `Changed ${changed.length}  `.padEnd(8), changed), line('read', `Read ${seen.length}  `.padEnd(8), seen)]
}

/** The token column: new tokens, plus the ≈ cost when costs are on. */
function tokenCell(a: Agent): string {
  const tokens = tokenText(a.tokens)
  if (!showCost) return tokens
  const cost = costOf(a.model, a.tokens)
  return cost ? `${tokens} ${formatCost(cost.total)}` : tokens
}

/** The details panel's cost breakdown; nothing for a model without a known price. */
function costLine({ Text }: Els, a: Agent) {
  const c = costOf(a.model, a.tokens)
  if (!c) return null
  const part = (usd: number) => formatCost(usd).replace('≈', '')
  return (
    <Text>
      <Text color="subtle">Cost    </Text>
      <Text>{formatCost(c.total)}</Text>
      <Text color="subtle">{`  (input ${part(c.input)} · output ${part(c.output)} · cache write ${part(c.cacheWrite)} · cache read ${part(c.cacheRead)})  ·  list prices, an estimate`}</Text>
    </Text>
  )
}

/** The crew's ≈ cost over the agents whose model price is known; null when none is. */
function sumCost(list: readonly Agent[]): number | null {
  const known = list.map(a => costOf(a.model, a.tokens)).filter((c): c is NonNullable<typeof c> => c !== null)
  return known.length ? known.reduce((t, c) => t + c.total, 0) : null
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
  if (p.model) next = { ...next, model: p.model }
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
  if (p.approval !== undefined) next = { ...next, waitingFor: p.approval ?? undefined }
  if (p.recent?.length) next = { ...next, recent: [...(next.recent ?? []), ...p.recent].slice(-RECENT_TOOLS) }
  if (p.files?.length) next = { ...next, files: withFiles(next.files ?? [], p.files) }
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

/** Writes the status line only when its text changes. */
function setStatus($: EngineInterface, text: string | undefined) {
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** While the crew is hidden, its one-line summary sits on the status line instead. */
async function refreshStatus($: EngineInterface) {
  const isHidden = await read($, hidden)
  const list = shown(await read($, agents))
  const now = await $.clock.now()
  setStatus($, isHidden ? statusText(list, now, history, showCost ? sumCost(list) : null) : undefined)
}

/** The agents the band shows: cancelled ones drop out of view (they stay in the state). */
const shown = (list: readonly Agent[]) => list.filter(a => a.status !== 'cancelled')

/** Minimises or restores the band, and remembers the choice for later sessions. */
async function setMinimized($: EngineInterface, value: boolean) {
  await update($, minimized, () => value)
  await $.store.set('minimized', value).catch(() => undefined)
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
  // The main conversation's events go to the title row's record
  const own = buffered.get(MAIN_ID)
  buffered.delete(MAIN_ID)
  if (own) await update($, main, m => (m && m.status === 'running' ? applyPending(m, own, now) : m))

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
  if (!after.some(a => a.status === 'running') && !reviving() && mainTurn === null) {
    ticker?.cancel()
    ticker = null
    // An agent spawned or resumed between the read and the cancel would otherwise go without a ticker
    const fresh = await read($, agents)
    if (fresh.some(a => a.status === 'running') || reviving() || mainTurn !== null) startTicker($)
  }
  const isHidden = await read($, hidden)
  if (!needsWrite && !own && !isHidden) $.ui.invalidate('ui.render')
  setStatus($, isHidden ? statusText(after, now, history, showCost ? sumCost(after) : null) : undefined)
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
  demoOnStage = false
  pending.clear()
  known.clear()
  closedTurn.clear()
  await update($, agents, () => [])
  await update($, main, m => (m?.demo || m?.status !== 'running' ? null : m))
  await update($, expanded, () => [])
  setStatus($, undefined)
}


// ── Demo ─────────────────────────────────────────────────────
/** A fake crew to see the design without real subagents: it walks every activity and outcome. */
// Timed for a short screen recording (about 30 seconds) and told as a story: Claude starts
// alone, then three agents arrive one by one and a helper joins the last, few enough rows that
// the whole band fits on screen. Every state shows up once, in order, and the crew ends with all
// flags up. Each step gets an equal share of an agent's time after
// its first two seconds. 'approval' is a running step that waits on the person.
type DemoStep = [Activity | 'approval', string]
type DemoAgent = { type: string; description: string; model: string; at: number; ms: number; end: AgentStatus; steps: DemoStep[]; parent?: number; todo?: string[] }
const DEMO: DemoAgent[] = [
  // Claude starts alone on the AGENT line; the crew then arrives one by one
  { type: 'Plan', description: 'Plan the refactor', model: 'claude-opus-5-5', at: 3_000, ms: 18_000, end: 'done', steps: [['thinking', ''], ['thinking', ''], ['approval', 'rm -r build'], ['approval', 'rm -r build'], ['running', 'rm -r build'], ['writing', 'PLAN.md']] },
  { type: 'Explore', description: 'Map the auth flow', model: 'claude-haiku-5-5', at: 6_000, ms: 15_000, end: 'done', steps: [['searching', 'func login('], ['reading', 'AuthService.swift'], ['thinking', ''], ['thinking', ''], ['web', 'developer.apple.com/documentation/security'], ['reading', 'KeychainStore.swift']] },
  { type: 'general-purpose', description: 'Write and run the tests', model: 'claude-sonnet-5-5', at: 9_000, ms: 21_000, end: 'done', todo: ['Review existing tests', 'Prepare fixtures', 'Write login tests', 'Run the tests', 'Fix failures'], steps: [['reading', 'AuthTests.swift'], ['writing', 'AuthTests.swift'], ['thinking', ''], ['thinking', ''], ['running', 'swift test'], ['writing', 'AuthTests.swift'], ['running', 'swift test']] },
  { type: 'Explore', description: 'Find mock data', model: 'claude-haiku-5-5', at: 12_000, ms: 10_000, end: 'done', parent: 2, steps: [['searching', 'MockUser'], ['reading', 'Fixtures.swift'], ['thinking', ''], ['reading', 'Fixtures.swift']] },
]

const DEMO_TOOL: Record<Activity, string> = { starting: '', thinking: '', searching: 'Grep', reading: 'Read', writing: 'Edit', running: 'Bash', web: 'WebFetch' }

async function startDemo($: EngineInterface) {
  const t0 = await $.clock.now()
  const crew: Agent[] = DEMO.map((d, i) => ({
    id: `demo-${i}`, type: d.type, description: d.description, model: d.model, status: 'running', activity: 'starting', target: '',
    activityAt: t0, seenAt: t0, startedAt: t0 + d.at, tokens: emptyTokens(), tools: 0, requests: 0, demo: true, expectedMs: d.ms,
    parentId: d.parent !== undefined ? `demo-${d.parent}` : undefined,
  }))
  // Cancel after the await: two demos started at once must not leave two timers running.
  // Clearing the handle too stops a callback already in flight from the old demo.
  demoTick?.cancel()
  demoTick = null
  await update($, hidden, () => false)
  await update($, agents, list => [...list.filter(a => !a.demo), ...crew.filter((_, i) => DEMO[i].at === 0)])
  // Claude's own line on the title: it reads a file, then waits on its crew. A real turn keeps its own.
  const demoMain: Agent = {
    id: MAIN_ID, type: 'main', description: 'Refactor the login flow', model: 'claude-opus-5-5', status: 'running', activity: 'reading', target: 'LoginView.swift',
    activityAt: t0, seenAt: t0, startedAt: t0, tokens: emptyTokens(), tools: 1, requests: 1, demo: true,
  }
  if (showMain) await update($, main, m => (m && !m.demo ? m : demoMain))
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
          const [step, target] = d.steps[Math.min(d.steps.length - 1, Math.floor(share * d.steps.length))]
          const asking = step === 'approval'
          const activity: Activity = asking ? 'running' : step
          // The demo agent with a to-do list completes its steps in order
          const steps = d.todo?.map((label, i) => {
            const k = Math.floor(share * d.todo!.length)
            return { id: `t${i}`, label, status: (i < k ? 'completed' : i === k ? 'in_progress' : 'pending') as Step['status'] }
          })
          const changed = activity !== a.activity || target !== a.target
          const file = changed && (activity === 'reading' || activity === 'writing') ? [activity === 'writing' ? { path: target, changed: true as const } : { path: target }] : []
          const call = changed && activity !== 'thinking' ? [{ label: clip(`${DEMO_TOOL[activity]} ${target}`.trim(), 80) }] : []
          return {
            ...withActivity(a, activity, target, now),
            waitingFor: asking ? `Bash ${target}` : undefined,
            files: file.length ? withFiles(a.files ?? [], file) : a.files,
            recent: call.length ? [...(a.recent ?? []), ...call].slice(-RECENT_TOOLS) : a.recent,
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
      if (demoTick === timer) {
        await update($, main, m => {
          if (!m?.demo) return m
          if (!more) return null
          const moved = now - m.startedAt > 3000 && m.activity !== 'thinking' ? withActivity(m, 'thinking', '', now) : m
          return { ...moved, seenAt: now, tokens: addUsage(moved.tokens, { input_tokens: 120, output_tokens: 60 }) }
        })
      }
      if (!more && demoTick === timer) {
        timer.cancel()
        demoTick = null
      }
    })()
  })
  demoTick = timer
  // The demo's own hint replaces whatever suggestion the box was showing
  demoOnStage = true
  await $.prompt.suggest({ text: DEMO_HINT }).catch(() => undefined)
}
