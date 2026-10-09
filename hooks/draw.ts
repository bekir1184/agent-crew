// Agent Crew's pure logic and pixel-art drawings. No `$` here, so everything is testable.
// Text is not drawn here: the surface's own Text elements draw it, full size and in
// your theme. This file only produces the crew member sprites and the progress bar.

import type { Activity, Agent, AgentStatus, Step, Tokens, TouchedFile } from '../types'

// ── Palette (inside SVGs; colors that read on light and dark themes) ──
const C = {
  body: '#D97757',
  bodyAsleep: '#C9A08F',
  eye: '#2B211C',
  white: '#FFFDF7',
  green: '#2FB67C',
  red: '#E0533F',
  yellow: '#F4C542',
  yellowDark: '#D9A21E',
  blue: '#3E6FE0',
  blueDark: '#2C47A8',
  blueLight: '#9CC4FF',
  pink: '#FF7AC6',
  code: '#4BE08A',
  screen: '#1F2A24',
  screenEdge: '#3A4A40',
  grey: '#8A8F98',
  greyDark: '#5E636C',
  brown: '#6B4F3A',
  paperEdge: '#DCD0B4',
  ink: '#1E1A18',
  track: '#8882', // bar background: translucent, fits either theme
}

/** The accent color of an agent type. */
export function typeColor(type: string): string {
  if (type === 'Explore') return '#4C7DF0'
  if (type === 'Plan') return '#9466F7'
  if (type === 'fork') return '#2FB67C'
  return '#E08A2E'
}

/** The status color: a theme key for text, a raw color for SVGs. */
export function statusColor(a: Agent): { theme: string; raw: string } {
  if (a.status === 'done') return { theme: 'success', raw: C.green }
  if (a.status === 'failed') return { theme: 'error', raw: C.red }
  if (a.status === 'cancelled') return { theme: 'inactive', raw: C.grey }
  return { theme: typeColor(a.type), raw: typeColor(a.type) }
}

/** The short label shown in the type column. */
export function typeLabel(type: string): string {
  if (type === 'general-purpose') return 'GENERAL'
  return type.toUpperCase().slice(0, 8)
}

// ── Text helpers ─────────────────────────────────────────────
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function formatTokens(n: number): string {
  // From 999,950 up, "1000.0k" would show: switch to millions there
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Tokens that are new work: input, output and what was written to the cache.
 * Cache reads are left out: every request re-reads the whole conversation from the
 * cache at about a tenth of the price, so summing them makes small agents look huge.
 */
export const freshTokens = (t: Tokens) => t.input + t.output + t.cacheWrite

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })

export function addUsage(t: Tokens, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Tokens {
  return {
    input: t.input + u.input_tokens,
    output: t.output + u.output_tokens,
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens ?? 0),
  }
}

// ── Cost (optional; off by default) ──────────────────────────
// Anthropic's first-party list prices in USD per million tokens (October 2026). Cache writes are
// priced as 5-minute writes (1.25× input); the API's usage doesn't say which TTL each write used,
// so every figure built on this is an estimate and is shown with "≈".
type Price = { input: number; output: number; cacheRead: number }
const PRICES: [string, Price][] = [
  // Longest names first: "claude-fable-5-1" must win over "claude-fable-5"
  ['fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4', { input: 5, output: 25, cacheRead: 0.5 }],
  ['sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['haiku-4', { input: 1, output: 5, cacheRead: 0.1 }],
]

/** The list price for a model id, or null for a model the table doesn't know. */
export function priceOf(model: string): Price | null {
  const id = model.toLowerCase()
  return PRICES.find(([key]) => id.includes(key))?.[1] ?? null
}

export type Cost = { total: number; input: number; output: number; cacheWrite: number; cacheRead: number }

/** The estimated cost of an agent's tokens in USD, or null when the model's price is unknown. */
export function costOf(model: string, t: Tokens): Cost | null {
  const p = priceOf(model)
  if (!p) return null
  const m = 1_000_000
  const input = (t.input * p.input) / m
  const output = (t.output * p.output) / m
  const cacheWrite = (t.cacheWrite * p.input * 1.25) / m
  const cacheRead = (t.cacheRead * p.cacheRead) / m
  return { total: input + output + cacheWrite + cacheRead, input, output, cacheWrite, cacheRead }
}

export function formatCost(usd: number): string {
  if (usd < 0.005) return '≈$0.00'
  if (usd < 10) return `≈$${usd.toFixed(2)}`
  return `≈$${usd.toFixed(1)}`
}

// ── Secrets ──────────────────────────────────────────────────
// A command or URL an agent runs can carry a key. Targets and descriptions are masked before
// they are stored or drawn, so a token never sits in state or on screen.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,})/g, // Anthropic / OpenAI style keys
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, // GitHub tokens
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g, // Slack tokens
  /\b(AKIA[0-9A-Z]{16})\b/g, // AWS access key ids
  /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g, // JWTs
]
// A key word followed by "=" or ":" (password=…, Authorization: Bearer …), or a bare "Bearer …".
// A key word alone is not a secret: `grep -rn password src/` stays as it is.
const SECRET_ASSIGNMENT = /((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd|authorization)["']?\s*[=:]\s*(?:bearer\s+)?["']?|\bbearer\s+)([^\s"'&;,]{4,})/gi

export function redact(text: string): string {
  let out = text.replace(SECRET_ASSIGNMENT, (_m, lead: string) => `${lead}•••`)
  for (const re of SECRET_PATTERNS) out = out.replace(re, '•••')
  return out
}

const ACTIVITY_LABEL: Record<Activity, string> = {
  starting: 'Getting ready',
  thinking: 'Thinking',
  searching: 'Searching',
  reading: 'Reading',
  writing: 'Writing',
  running: 'Running',
  web: 'Browsing',
}

export function statusLabel(a: Agent): string {
  if (a.status === 'done') return 'Done'
  if (a.status === 'failed') return 'Failed'
  if (a.status === 'cancelled') return 'Cancelled'
  return ACTIVITY_LABEL[a.activity]
}

/** Tools that keep the agent's to-do list or start helpers: they don't change the accessory. */
export const QUIET_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent', 'Task'])

export function activityOf(tool: string): Activity {
  if (tool === 'Grep' || tool === 'Glob' || tool === 'ToolSearch') return 'searching'
  if (tool === 'Read' || tool === 'NotebookRead') return 'reading'
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'writing'
  if (tool === 'WebFetch' || tool === 'WebSearch' || tool.startsWith('mcp__')) return 'web'
  return 'running'
}

/** What a tool call is about: the pattern, the file name, the command, the address. */
export function targetOf(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const file = (p: string) => p.split('/').filter(Boolean).pop() ?? p
  const arg =
    tool === 'Bash' ? str('command')
    : tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' ? file(str('file_path'))
    : tool === 'NotebookEdit' ? file(str('notebook_path'))
    : tool === 'Grep' || tool === 'Glob' ? str('pattern')
    : tool === 'WebFetch' ? str('url').replace(/^https?:\/\/(www\.)?/, '')
    : tool === 'WebSearch' ? str('query')
    : tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool)
    : tool
  // Bounded: a one-line `python -c` can be kilobytes, and this string is stored and redrawn
  return clip(redact(arg.split('\n')[0].trim()), 160)
}

// ── Files ────────────────────────────────────────────────────
/** How many files an agent remembers; past that the oldest go first. */
export const MAX_FILES = 40
const READS = new Set(['Read'])
const CHANGES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The file a tool call read or changed, or null for every other call. */
export function fileOf(tool: string, input: Record<string, unknown>, cwd = ''): TouchedFile | null {
  if (!READS.has(tool) && !CHANGES.has(tool)) return null
  const raw = input[tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']
  if (typeof raw !== 'string' || !raw.trim()) return null
  const path = clip(redact(relativePath(raw.trim(), cwd)), 160)
  return CHANGES.has(tool) ? { path, changed: true } : { path }
}

/** A path under the project, shown from the project folder; anything else, as it is. */
export function relativePath(path: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, '')
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** Adds touched files: one entry per path, moved to the newest place, changed once stays changed. */
export function withFiles(list: readonly TouchedFile[], touched: readonly TouchedFile[]): TouchedFile[] {
  let out = [...list]
  for (const f of touched) {
    const old = out.find(o => o.path === f.path)
    out = out.filter(o => o.path !== f.path)
    out.push(old?.changed || f.changed ? { path: f.path, changed: true } : { path: f.path })
  }
  return out.slice(-MAX_FILES)
}

/** The details panel's file lists, newest first. */
export function filesSummary(files: readonly TouchedFile[]): { changed: string[]; read: string[] } {
  const newest = [...files].reverse()
  return { changed: newest.filter(f => f.changed).map(f => f.path), read: newest.filter(f => !f.changed).map(f => f.path) }
}

// ── Estimates ────────────────────────────────────────────────
// For each (type, model) the last 20 finished runs are kept: duration and request count.
// The median, not the mean: one very long run doesn't skew the estimate.
export type Sample = { ms: number; requests: number }
export type History = Record<string, Sample[]>
const DEFAULT_MS = 60_000

export function modelShort(model: string): string {
  for (const m of ['haiku', 'sonnet', 'opus', 'fable']) if (model.includes(m)) return m
  return model || '?'
}
const historyKey = (a: Pick<Agent, 'type' | 'model'>) => `${a.type}|${modelShort(a.model)}`

function percentile(sorted: number[], p: number): number {
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}

export type Expectation = { ms: number; requests?: number; low?: number; high?: number; learned: boolean; durations?: number[] }

export function expectation(a: Agent, h: History): Expectation {
  if (a.expectedMs) return { ms: a.expectedMs, learned: true }
  // The same type and model first; otherwise every model of the same type
  let samples = h[historyKey(a)] ?? []
  if (samples.length === 0) samples = Object.entries(h).filter(([k]) => k.startsWith(`${a.type}|`)).flatMap(([, v]) => v)
  if (samples.length === 0) return { ms: DEFAULT_MS, learned: false }
  const durations = samples.map(s => s.ms).sort((x, y) => x - y)
  const requests = samples.map(s => s.requests).filter(n => n > 0).sort((x, y) => x - y)
  return {
    ms: percentile(durations, 0.5),
    requests: requests.length ? percentile(requests, 0.5) : undefined,
    low: samples.length >= 3 ? percentile(durations, 0.25) : undefined,
    high: samples.length >= 3 ? percentile(durations, 0.75) : undefined,
    learned: true,
    durations,
  }
}

/** Keeps only well-formed samples from whatever the store held: a bad value never breaks drawing. */
export function sanitizeHistory(raw: unknown): History {
  const out: History = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, samples] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(samples)) continue
    const ok = samples
      .filter((x): x is Sample => !!x && typeof x === 'object' && Number.isFinite((x as Sample).ms) && (x as Sample).ms > 0)
      .map(x => ({ ms: x.ms, requests: Number.isFinite(x.requests) ? x.requests : 0 }))
      .slice(-20)
    if (ok.length) out[key] = ok
  }
  return out
}

export function learn(h: History, a: Agent, sample: Sample): History {
  const k = historyKey(a)
  return { ...h, [k]: [...(h[k] ?? []), sample].slice(-20) }
}

/**
 * How long an agent still needs, and on what that guess rests. All of it is local arithmetic
 * over the clock and the stored history: no model is asked, so it costs no tokens.
 *
 * - steps:   the agent keeps a to-do list, so the time per finished step predicts the rest.
 * - history: past the typical run time, look only at past runs that lasted at least this long
 *            and take their median: "runs that got this far usually finished at…".
 * - stretch: no run in the history lasted this long; extend by a quarter of the time so far.
 * Within the typical time, the model request count refines the time-based guess.
 */
export type Remaining = { ms: number; basis: 'expected' | 'steps' | 'history' | 'stretch'; revised: boolean }

export function remaining(a: Agent, now: number, h: History): Remaining {
  const elapsed = Math.max(0, now - a.startedAt)
  const steps = stepSummary(a)
  if (steps) {
    const doneUnits = steps.done + (steps.current ? 0.5 : 0)
    if (doneUnits > 0) return { ms: Math.max(1000, (elapsed / doneUnits) * (steps.total - doneUnits)), basis: 'steps', revised: false }
  }
  const e = expectation(a, h)
  let timeLeft: number
  let basis: Remaining['basis'] = 'expected'
  if (elapsed <= e.ms) {
    timeLeft = e.ms - elapsed
  } else {
    const longer = (e.durations ?? []).filter(d => d > elapsed)
    if (longer.length) {
      timeLeft = percentile(longer, 0.5) - elapsed
      basis = 'history'
    } else {
      timeLeft = Math.max(10_000, elapsed * 0.25)
      basis = 'stretch'
    }
  }
  // Requests are a second clock: an agent that works fast gets there sooner than the time says
  if (basis === 'expected' && e.requests && a.requests > 0 && a.requests < e.requests) {
    const byRequests = (elapsed * (e.requests - a.requests)) / a.requests
    timeLeft = 0.6 * timeLeft + 0.4 * byRequests
  }
  return { ms: Math.max(1000, timeLeft), basis, revised: basis === 'history' || basis === 'stretch' }
}

/** 0..1 from the time left: elapsed / (elapsed + remaining). Never 100% before done. */
export function progress(a: Agent, now: number, h: History): number {
  if (a.status === 'done') return 1
  const end = a.endedAt ?? now
  const elapsed = Math.max(0, end - a.startedAt)
  const r = remaining(a, end, h)
  return Math.min(0.99, elapsed / (elapsed + r.ms))
}

/**
 * What the bar shows: the progress, but never less than it has already shown. When the time
 * left is revised upwards, the bar holds still until real progress catches up.
 */
export function shownProgress(a: Agent, now: number, h: History): number {
  return Math.max(a.shownShare ?? 0, progress(a, now, h))
}

/** The estimate column: the time left (re-estimated when an agent runs long), or the outcome. */
export function estimateText(a: Agent, now: number, h: History): { main: string; extra: string } {
  const elapsed = (a.endedAt ?? now) - a.startedAt
  if (a.status === 'done') return { main: `took ${formatDuration(elapsed)}`, extra: '' }
  if (a.status === 'failed') return { main: 'failed', extra: '' }
  if (a.status === 'cancelled') return { main: 'cancelled', extra: '' }
  const r = remaining(a, now, h)
  const e = expectation(a, h)
  const extra =
    r.basis === 'steps' ? 'from steps'
    : r.revised ? 're-estimated'
    : !e.learned ? 'first estimate'
    : e.low !== undefined && e.high !== undefined ? `usually ${formatDuration(e.low)}–${formatDuration(e.high)}`
    : ''
  return { main: `~${formatDuration(r.ms)} left`, extra }
}

/** For the header: the longest time left among running agents, and the crew's share of work done. */
export function crewSummary(list: readonly Agent[], now: number, h: History): { leftMs: number; share: number } {
  let total = 0
  let done = 0
  let leftMs = 0
  for (const a of list.filter(x => x.status === 'running' || x.status === 'done')) {
    const elapsed = Math.max(0, (a.endedAt ?? now) - a.startedAt)
    const left = a.status === 'running' ? remaining(a, now, h).ms : 0
    const share = a.status === 'done' ? 1 : shownProgress(a, now, h)
    done += share * (elapsed + left)
    total += elapsed + left
    leftMs = Math.max(leftMs, left)
  }
  return { leftMs, share: total ? done / total : 0 }
}

/** A running agent with no activity for this long is treated as gone (its end was never reported). */
export const STALE_MS = 15 * 60_000

/** Past the cap, finished agents leave the stage first; a running one is never dropped. */
export function capAgents(list: Agent[], max = 12): Agent[] {
  const extra = list.length - max
  if (extra <= 0) return list
  const drop = new Set(list.filter(a => a.status !== 'running').slice(0, extra).map(a => a.id))
  return list.filter(a => !drop.has(a.id))
}

// ── Row layout ───────────────────────────────────────────────
// Column widths come from the surface's real width, so a row never runs past the right edge.
// Fixed columns take their room first; the task and the "doing" text share what is left.
export type Layout = { type: number; task: number; doing: number; pct: number; eta: number; tokens: number; barCells: number; showTokens: boolean }

/** Cells a row spends besides its columns: the sprite, the gaps between columns, the arrow button and its margin. */
export const FIXED_EXTRAS = 6 + 9 + 4 + 1

/**
 * The desktop reports its width in code-font cells but lays boxes out a little wider, so a
 * desktop row plans with 94% of the reported width (bodyColumns already leaves out the
 * engine's marks and a docked pane). The terminal's cells are exact.
 */
const DESKTOP_BUDGET = 0.94

export function layout(columns: number, desktop = true, showCost = false): Layout {
  // The terminal's dot and its space take two cells where the desktop sprite takes six, and its
  // arrow carries a hotkey ("a: ▸"), three cells more
  const budget = Math.floor(columns * (desktop ? DESKTOP_BUDGET : 1)) + (desktop ? 0 : 6 - 2 - 3)
  // With costs on, the token column also holds "≈$0.04"
  const base = { type: 8, pct: 5, eta: 11, tokens: showCost ? 17 : 10 }
  let barCells = 14
  let showTokens = true
  const flexible = () => budget - FIXED_EXTRAS - base.type - base.pct - base.eta - barCells - (showTokens ? base.tokens : 0)
  // Too narrow: first a shorter bar, then shorter text columns; the token column is the last
  // thing to go (it moves into the details panel only on very narrow surfaces)
  if (flexible() < 30) barCells = 8
  if (flexible() < 18) showTokens = false
  const room = Math.max(18, flexible())
  const task = Math.min(36, Math.max(8, Math.round(room * 0.5)))
  const doing = Math.min(46, Math.max(10, room - task))
  return { ...base, task, doing, barCells, showTokens }
}

// ── Step tracking: the agent's own to-do list ─────────────────
type TodoInput = { content?: string; activeForm?: string; status?: string }
const stepStatus = (s: unknown): Step['status'] => (s === 'completed' || s === 'in_progress' ? s : 'pending')

/** TodoWrite sends the whole list: steps are rebuilt from it. */
export const MAX_STEPS = 50
export function stepsFromTodos(todos: unknown): Step[] {
  if (!Array.isArray(todos)) return []
  return (todos as TodoInput[]).slice(0, MAX_STEPS).map((t, i) => ({
    id: `t${i}`,
    label: clip((t.status === 'in_progress' ? t.activeForm : t.content) || t.content || '', 120),
    status: stepStatus(t.status),
  }))
}

export function withStepCreated(steps: readonly Step[], id: string, label: string): Step[] {
  return [...steps.filter(s => s.id !== id), { id, label: clip(label, 120), status: 'pending' as const }].slice(-MAX_STEPS)
}

export function withStepUpdated(steps: readonly Step[], u: { taskId?: unknown; status?: unknown; activeForm?: unknown; subject?: unknown }): Step[] {
  if (u.status === 'deleted') return steps.filter(s => s.id !== u.taskId)
  return steps.map(s =>
    s.id !== u.taskId
      ? s
      : {
          ...s,
          status: u.status !== undefined ? stepStatus(u.status) : s.status,
          label: (u.status === 'in_progress' && typeof u.activeForm === 'string' ? u.activeForm : typeof u.subject === 'string' ? u.subject : s.label) || s.label,
        },
  )
}

/** With a list of at least two steps: total, done and the current step. */
export function stepSummary(a: Agent): { total: number; done: number; current?: string } | null {
  const l = a.steps ?? []
  if (l.length < 2) return null
  return { total: l.length, done: l.filter(s => s.status === 'completed').length, current: l.find(s => s.status === 'in_progress')?.label }
}

// ── Calm transitions ─────────────────────────────────────────
// The short thinking pauses between tools don't flicker the accessory: "thinking" shows
// only once it has lasted 1.5 s.
const CALM_MS = 1500

export function withActivity(a: Agent, activity: Activity, target: string, now: number): Agent {
  if (a.activity === activity && a.target === target) return a
  return { ...a, activity, target, activityAt: now, prevActivity: a.activity, prevTarget: a.target }
}

export function shownActivity(a: Agent, now: number): { activity: Activity; target: string } {
  if (a.activity === 'thinking' && a.prevActivity && a.prevActivity !== 'thinking' && now - a.activityAt < CALM_MS) {
    return { activity: a.prevActivity, target: a.prevTarget ?? '' }
  }
  return { activity: a.activity, target: a.target }
}

/** A tool call running this long gets its time shown next to it. */
export const SLOW_TOOL_MS = 30_000
/** An agent with no event for this long is marked quiet. */
export const QUIET_MS = 120_000

/**
 * The row's "doing" column: an approval the agent waits on comes first; then a step when there
 * is a list, otherwise the activity and its target. A slow tool call shows its time, and a long
 * silence says so: health signals that don't depend on the time estimate.
 * `alert` asks the row to draw the main part in the warning color.
 */
export function doingText(a: Agent, now: number, runningHelpers: number): { main: string; extra: string; alert?: boolean } {
  if (a.status !== 'running') return { main: statusLabel(a), extra: '' }
  if (a.waitingFor) return { main: 'Needs approval', extra: a.waitingFor, alert: true }
  const steps = stepSummary(a)
  const shown = shownActivity(a, now)
  const helpers = runningHelpers > 0 ? `waiting on ${runningHelpers} helper${runningHelpers > 1 ? 's' : ''}` : ''
  const quietFor = now - a.seenAt
  if (!helpers && quietFor > QUIET_MS) return { main: 'Quiet', extra: `no activity for ${formatDuration(quietFor)}`, alert: true }
  const busyFor = now - a.activityAt
  const slow = shown.activity !== 'thinking' && shown.activity !== 'starting' && busyFor > SLOW_TOOL_MS ? `${formatDuration(busyFor)} · ` : ''
  if (steps) return { main: `Step ${Math.min(steps.total, steps.done + 1)}/${steps.total}`, extra: helpers || steps.current || ACTIVITY_LABEL[shown.activity] }
  if (helpers) return { main: 'Waiting', extra: helpers.replace('waiting ', '') }
  return { main: ACTIVITY_LABEL[shown.activity], extra: `${slow}${shown.target}` }
}

/** The header sentence: the crew's state at a glance. */
export function headline(list: readonly Agent[], now: number): string {
  const running = list.filter(a => a.status === 'running')
  const isHelper = (a: Agent) => !!a.parentId && list.some(b => b.id === a.parentId)
  const helpers = running.filter(isHelper).length
  if (running.length === 0) {
    const trouble = list.filter(a => a.status === 'failed' || a.status === 'cancelled').length
    return trouble ? `Finished, ${trouble} didn't complete` : 'All done'
  }
  const top = running.filter(a => !isHelper(a))
  const helperText = helpers ? `, ${helpers} helper${helpers > 1 ? 's' : ''} working` : ''
  const approvals = running.filter(a => a.waitingFor).length
  if (approvals) return `${approvals} agent${approvals > 1 ? 's need' : ' needs'} your approval`
  if (top.length === 1) {
    const a = top[0]
    const d = doingText(a, now, 0)
    return `${a.description}: ${d.main.toLowerCase()}${helperText}`
  }
  return `${top.length} agents working${helperText}`
}

/** The one-line summary for Claude Code's status line, shown while the crew is hidden. */
export function statusText(list: readonly Agent[], now: number, h: History, cost: number | null): string | undefined {
  if (list.length === 0) return undefined
  const running = list.filter(a => a.status === 'running')
  const approvals = running.filter(a => a.waitingFor).length
  const parts = [running.length ? `${running.length} working` : `${list.length} done`]
  if (approvals) parts.push(`${approvals} need${approvals > 1 ? '' : 's'} approval`)
  if (running.length) parts.push(`~${formatDuration(crewSummary(list, now, h).leftMs)} left`)
  if (cost !== null) parts.push(formatCost(cost))
  return `Agent Crew: ${parts.join(' · ')}`
}

/** Deeper helpers are drawn at this depth: the indent stops growing, the rows stay. */
export const MAX_DEPTH = 4

/**
 * Rows in order: each agent directly followed by its helpers, with their depth. Every agent
 * gets exactly one row: a parent cycle or a missing parent makes it a root instead of hiding it.
 */
export function tree(list: readonly Agent[]): { a: Agent; depth: number }[] {
  const ids = new Set(list.map(a => a.id))
  const seen = new Set<string>()
  const out: { a: Agent; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const a of list) {
      if (seen.has(a.id)) continue
      const isRoot = !a.parentId || !ids.has(a.parentId)
      if ((parent === undefined && isRoot) || (parent !== undefined && a.parentId === parent)) {
        seen.add(a.id)
        out.push({ a, depth: Math.min(depth, MAX_DEPTH) })
        walk(a.id, depth + 1)
      }
    }
  }
  walk(undefined, 0)
  // Agents caught in a parent cycle were never reached: show them as roots
  for (const a of list) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push({ a, depth: 0 })
    walk(a.id, 1)
  }
  return out
}

// ── Pixel drawing core ───────────────────────────────────────
const px = (u: number, x: number, y: number, w: number, h: number, fill: string) =>
  `<rect x="${x * u}" y="${y * u}" width="${w * u}" height="${h * u}" fill="${fill}"/>`

/** Pixels from a row map like "..##..": each letter maps to a color. */
function pixels(u: number, ox: number, oy: number, rows: string[], colors: Record<string, string>): string {
  let out = ''
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = colors[row[x]]
      if (c) out += px(u, ox + x, oy + y, 1, 1, c)
    }
  })
  return out
}

// The sources don't depend on time: a crew member in the same state yields the same SVG
// every second, so the surface doesn't reload the image and the animation keeps running.
// Each SVG carries only the animations its own elements use (see styleFor).
const KEYFRAMES: Record<string, string> = {
  hop: '0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}',
  cheer: '0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}',
  on: '0%,49.9%{opacity:1}50%,100%{opacity:0}',
  off: '0%,49.9%{opacity:0}50%,100%{opacity:1}',
  blink: '0%,92%{opacity:1}92.1%,97%{opacity:0}97.1%,100%{opacity:1}',
  blinkShut: '0%,92%{opacity:0}92.1%,97%{opacity:1}97.1%,100%{opacity:0}',
  scan: '0%,100%{transform:translateX(0)}50%{transform:translateX(-4px)}',
  l1: '0%,15%{opacity:0}15.1%,100%{opacity:1}',
  l2: '0%,40%{opacity:0}40.1%,100%{opacity:1}',
  l3: '0%,65%{opacity:0}65.1%,100%{opacity:1}',
  read: '0%{transform:translateY(0)}33%{transform:translateY(4px)}66%{transform:translateY(8px)}100%{transform:translateY(0)}',
  spin: '0%,49.9%{transform:translateX(0)}50%,100%{transform:translateX(2px)}',
  stars: '0%,33%{transform:translateX(0)}33.1%,66%{transform:translateX(6px)}66.1%,100%{transform:translateX(12px)}',
  zzz: '0%{transform:translate(0,0);opacity:0}20%{opacity:1}100%{transform:translate(4px,-6px);opacity:0}',
}
/** class → [keyframes name, animation rule]. */
const CLASSES: Record<string, [string, string]> = {
  hop: ['hop', 'hop .7s steps(1,end) infinite'],
  cheer: ['cheer', 'cheer .6s steps(1,end) infinite'],
  legA: ['on', 'on .5s steps(1,end) infinite'],
  legB: ['off', 'off .5s steps(1,end) infinite'],
  eye: ['blink', 'blink 3.2s steps(1,end) infinite'],
  eyeShut: ['blinkShut', 'blinkShut 3.2s steps(1,end) infinite'],
  scan: ['scan', 'scan 1.2s steps(1,end) infinite'],
  cursor: ['on', 'on .8s steps(1,end) infinite'],
  l1: ['l1', 'l1 2.4s steps(1,end) infinite'],
  l2: ['l2', 'l2 2.4s steps(1,end) infinite'],
  l3: ['l3', 'l3 2.4s steps(1,end) infinite'],
  read: ['read', 'read 1.8s steps(1,end) infinite'],
  sparkA: ['on', 'on 1.4s steps(1,end) infinite'],
  sparkB: ['off', 'off 1.4s steps(1,end) infinite'],
  spin: ['spin', 'spin 1.6s steps(1,end) infinite'],
  stars: ['stars', 'stars 1s steps(1,end) infinite'],
  zzz: ['zzz', 'zzz 2.4s linear infinite'],
  zzz2: ['zzz', 'zzz 2.4s linear 1.2s infinite;opacity:0'],
  waveA: ['on', 'on .7s steps(1,end) infinite'],
  waveB: ['off', 'off .7s steps(1,end) infinite'],
  seg: ['on', 'on .9s steps(1,end) infinite'],
}

/** The <style> for an SVG body: crisp pixels plus exactly the animations its classes use. */
function styleFor(body: string): string {
  const used = new Set<string>()
  for (const m of body.matchAll(/class="(\w+)"/g)) used.add(m[1])
  const frames = new Set<string>()
  let css = 'rect{shape-rendering:crispEdges}'
  for (const c of used) {
    const def = CLASSES[c]
    if (!def) continue
    frames.add(def[0])
    css += `.${c}{animation:${def[1]}}`
  }
  for (const f of frames) css += `@keyframes ${f}{${KEYFRAMES[f]}}`
  return `<style>${css}</style>`
}

/** Small memo for SVG sources: the same state always draws the same string. */
function memo<K>(cache: Map<K, string>, key: K, make: () => string): string {
  let v = cache.get(key)
  if (v === undefined) {
    v = make()
    if (cache.size > 256) cache.clear()
    cache.set(key, v)
  }
  return v
}

// ── Crew member (Clawd) ──────────────────────────────────────
// Stage: 22×18 cells. Body x3..12 (10×7), y5..11; claws on the sides; four thin legs.
// Accessories sit on the right (x14..21) or above the head.
const U = 2

/** How a thinking crew member holds itself in a scene's frame. */
type Pose = { lookUp?: boolean }

function creature(a: Agent, pose: Pose = {}): string {
  const u = U
  const running = a.status === 'running'
  const done = a.status === 'done'
  const body = a.status === 'cancelled' ? C.bodyAsleep : C.body

  let s = px(u, 3, 14, 10, 1, '#00000018')
  const leg = (x: number, h: number) => px(u, x, 12, 1, h, body)
  const still = leg(4, 2) + leg(6, 2) + leg(9, 2) + leg(11, 2)
  const stride = leg(4, 1) + leg(6, 2) + leg(9, 1) + leg(11, 2)
  s += running ? `<g class="legA">${still}</g><g class="legB">${stride}</g>` : still

  // Body and claws; when done, the right claw is up holding the flag
  let torso = px(u, 3, 5, 10, 7, body) + px(u, 2, 7, 1, 2, body)
  if (done) torso += px(u, 13, 3, 1, 3, body)
  else torso += px(u, 13, 7, 1, 2, body)

  let face = ''
  if (done) {
    face = pixels(u, 4, 7, ['.#....#.', '#.#..#.#'], { '#': C.eye })
  } else if (a.status === 'failed') {
    face = pixels(u, 4, 6, ['#.#..#.#', '.#....#.', '#.#..#.#'], { '#': C.eye })
  } else if (a.status === 'cancelled') {
    face = px(u, 4, 8, 2, 1, C.eye) + px(u, 9, 8, 2, 1, C.eye) // asleep: - -
  } else {
    const side = a.activity !== 'thinking' && a.activity !== 'starting' && !a.waitingFor ? 1 : 0
    const ey = a.activity === 'thinking' || a.waitingFor || pose.lookUp ? 6 : 7
    const open = px(u, 5 + side, ey, 1, 2, C.eye) + px(u, 10 + side, ey, 1, 2, C.eye)
    const shut = px(u, 5 + side, ey + 1, 1, 1, C.eye) + px(u, 10 + side, ey + 1, 1, 1, C.eye)
    face = `<g class="eye">${open}</g><g class="eyeShut">${shut}</g>`
  }

  const hat =
    a.activity === 'starting' && running
      ? pixels(u, 3, 2, ['..######..', '.########.', '##########'], { '#': C.yellow }) + px(u, 4, 4, 8, 1, C.yellowDark) + px(u, 5, 2, 1, 1, C.white)
      : ''

  const motion = running ? ' class="hop"' : done ? ' class="cheer"' : ''
  return s + `<g${motion}>${torso}${face}${hat}</g>`
}

// ── Thinking scenes ──────────────────────────────────────────
// Thinking is the most common state, so it isn't always the hourglass: a crew member keeps
// taking turns between the hourglass, a thought cloud and a lightbulb, each three frames long.
export const THINKING_SCENES = ['hourglass', 'cloud', 'idea'] as const
export type ThinkingScene = (typeof THINKING_SCENES)[number]
/** How long one scene plays before the next: one loop of its three frames, so they keep taking turns. */
export const SCENE_MS = 3000

/** One frame of a scene lasts a second. */
export const FRAME_MS = 1000

/**
 * The scene a thinking crew member plays now, and which of its three frames. Each agent starts
 * at its own scene, so a crew isn't in step. The frame comes from the clock, not from a CSS
 * animation: the band redraws every second, and a redraw restarts an SVG's animations, so a
 * three-second CSS sequence would never get past its first frame.
 */
export function thinkingScene(a: Pick<Agent, 'id' | 'activityAt'>, now: number): ThinkingScene {
  return THINKING_SCENES[(seedOf(a.id) + Math.floor(sinceThinking(a, now) / SCENE_MS)) % THINKING_SCENES.length]
}
export function sceneFrame(a: Pick<Agent, 'activityAt'>, now: number): 0 | 1 | 2 {
  return (Math.floor(sinceThinking(a, now) / FRAME_MS) % 3) as 0 | 1 | 2
}
const sinceThinking = (a: Pick<Agent, 'activityAt'>, now: number) => Math.max(0, now - (a.activityAt ?? 0))
function seedOf(id: string | undefined): number {
  let seed = 0
  for (const ch of id ?? '') seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
  return seed
}

const framed = (body: string, transform = '') => (transform ? `<g transform="${transform}">${body}</g>` : body)
const dots = (pts: [number, number][], color: string = C.white) => pts.map(([x, y]) => px(U, x, y, 1, 1, color)).join('')

/** One frame of a scene, the crew member drawn in it. */
function sceneSvg(a: Agent, scene: ThinkingScene, n: 0 | 1 | 2): string {
  const u = U
  switch (scene) {
    case 'cloud': {
      // A thought cloud grows over the head and a question mark appears in it
      const rising = dots([[14, 3], [16, 2]])
      const cloud = pixels(u, 16, -2, ['.####.', '######', '.####.'], { '#': C.white })
      const big = pixels(u, 14, -2, ['..#####..', '.#######.', '#########', '.#######.', '..#####..'], { '#': C.white })
      const mark = pixels(u, 17, -2, ['.##.', '...#', '..#.', '....', '..#.'], { '#': C.yellowDark })
      return [creature(a, { lookUp: true }) + rising, creature(a, { lookUp: true }) + rising + cloud, creature(a, { lookUp: true }) + px(u, 13, 4, 1, 1, C.white) + big + mark][n]
    }
    case 'idea': {
      // A bulb appears over the head, lights up, and the crew member hops
      const outline = pixels(u, 6, -1, ['.##.', '#..#', '#..#', '.##.', '.##.'], { '#': C.white })
      const lit = pixels(u, 6, -1, ['.##.', '####', '####', '.##.'], { '#': C.yellow }) + px(u, 7, 3, 2, 1, C.greyDark)
      const rays = dots([[4, 0], [11, 0], [3, 2], [12, 2]], C.yellow)
      return [creature(a), creature(a, { lookUp: true }) + outline, framed(creature(a, { lookUp: true }) + lit + rays, 'translate(0 -2)')][n]
    }
    default:
      return accessory(a) + creature(a)
  }
}

/** The checkered finish flag, held up by the right claw, waving in two frames. */
function finishFlag(): string {
  const u = U
  const pole = px(u, 13, -2, 1, 6, C.ink)
  const check = (shift: number) =>
    pixels(u, 14, -2 + shift, ['#.#.#.', '.#.#.#', '#.#.#.'], { '#': C.ink, '.': C.white })
  return `<g class="cheer">${pole}<g class="waveA">${check(0)}</g><g class="waveB">${check(1)}</g></g>`
}

function accessory(a: Agent, flipped = false): string {
  const u = U
  if (a.status === 'done') return finishFlag()
  if (a.waitingFor && a.status === 'running') {
    // A yellow question bubble over the head: it waits on the person
    const bubble = pixels(u, 14, 0, ['.#####.', '#######', '###.###', '####.##', '###.###', '#######', '.#####.', '..#....'], { '#': C.yellow, '.': '' })
    const mark = pixels(u, 14, 0, ['.......', '..###..', '.#...#.', '....#..', '...#...', '.......', '...#...'], { '#': C.ink })
    return `<g class="sparkA">${bubble}${mark}</g><g class="sparkB">${bubble}${mark}</g>`
  }
  if (a.status === 'failed') {
    const stars = `<g class="stars">${px(u, 3, 2, 1, 1, C.yellow)}${px(u, 6, 1, 1, 1, C.yellowDark)}</g>`
    return stars + px(u, 16, 3, 5, 6, C.red) + px(u, 18, 4, 1, 2, C.white) + px(u, 18, 7, 1, 1, C.white) + px(u, 18, 9, 1, 3, C.greyDark)
  }
  if (a.status === 'cancelled') {
    const z = (x: number, y: number) => pixels(u, x, y, ['###', '.#.', '###'], { '#': C.grey })
    return `<g class="zzz">${z(14, 2)}</g><g class="zzz2">${z(17, 0)}</g>`
  }
  switch (a.activity) {
    case 'searching':
      return `<g class="scan">${pixels(u, 16, 3, ['.###.', '#ooo#', '#ooo#', '#ooo#', '.###.'], { '#': C.blueDark, o: C.blueLight })}${px(u, 17, 4, 1, 1, C.white)}${px(u, 15, 8, 1, 1, C.brown)}${px(u, 14, 9, 1, 1, C.brown)}</g>`
    case 'reading':
      return px(u, 16, 2, 5, 9, C.white) + px(u, 16, 2, 5, 1, C.paperEdge) + px(u, 20, 2, 1, 9, C.paperEdge) +
        px(u, 17, 4, 3, 1, C.paperEdge) + px(u, 17, 6, 2, 1, C.paperEdge) + px(u, 17, 8, 3, 1, C.paperEdge) +
        `<g class="read">${px(u, 17, 4, 3, 1, C.yellow)}</g>`
    case 'writing':
      return px(u, 15, 1, 7, 10, C.blueDark) + px(u, 15, 1, 7, 1, C.blue) + px(u, 16, 1, 1, 1, C.pink) + px(u, 18, 1, 1, 1, C.pink) +
        `<g class="l1">${px(u, 16, 3, 4, 1, C.code)}</g><g class="l2">${px(u, 17, 5, 4, 1, C.code)}</g><g class="l3">${px(u, 17, 7, 2, 1, C.code)}</g>` +
        `<g class="cursor">${px(u, 20, 7, 1, 1, C.white)}</g>` + px(u, 16, 9, 1, 1, C.code) + px(u, 20, 9, 1, 1, C.code)
    case 'running':
      return px(u, 15, 2, 7, 7, C.screenEdge) + px(u, 16, 3, 5, 5, C.screen) +
        px(u, 16, 4, 1, 1, C.code) + px(u, 17, 5, 1, 1, C.code) + px(u, 16, 6, 1, 1, C.code) +
        `<g class="l2">${px(u, 18, 4, 2, 1, '#2C7A50')}</g><g class="cursor">${px(u, 18, 6, 2, 1, C.code)}</g>` +
        px(u, 14, 9, 9, 1, C.grey) + px(u, 15, 10, 7, 1, C.greyDark)
    case 'web':
      return pixels(u, 16, 3, ['.###.', '#####', '#####', '#####', '.###.'], { '#': C.blue }) +
        `<g class="spin">${px(u, 16, 4, 2, 1, C.code)}${px(u, 17, 5, 1, 2, C.code)}${px(u, 19, 6, 1, 1, C.code)}</g>` +
        px(u, 15, 8, 7, 1, C.blueLight)
    case 'thinking':
      // Turned over every second by the clock (a redraw would restart a CSS flip before it shows)
      return `<g${flipped ? ' transform="rotate(180 37 11)"' : ''}>${pixels(u, 16, 2, ['#####', 'coooc', '.coc.', '..o..', '.c.c.', 'coooc', '#####'], { '#': C.blue, o: C.yellow, c: C.blueLight })}</g>` +
        `<g class="sparkA">${px(u, 15, 1, 1, 1, C.yellow)}${px(u, 21, 5, 1, 1, C.yellow)}</g><g class="sparkB">${px(u, 21, 1, 1, 1, C.yellow)}${px(u, 15, 7, 1, 1, C.yellow)}</g>`
    case 'starting':
      return pixels(u, 16, 3, ['#.#', '###', '.#.', '.#.', '.#.', '.#.'], { '#': C.greyDark })
  }
  return ''
}

/** A row's sprite: the crew member with its accessory, 44×34 px, transparent background. */
export const SPRITE_W = 44
export const SPRITE_H = 34
/** The sprite's width in character cells, rounded up: for indenting text under it. */
export const SPRITE_CELLS = 6

const spriteCache = new Map<string, string>()

/**
 * The sprite follows the calm-transition rule like the text does: a short thinking pause
 * keeps the previous accessory. The source depends on the shown state only, not on time,
 * and is cached per state.
 */
export function spriteSvg(a: Agent, now: number): string {
  const activity = a.status === 'running' ? shownActivity(a, now).activity : a.activity
  const waiting = a.status === 'running' && !!a.waitingFor
  const scene: ThinkingScene = a.status === 'running' && activity === 'thinking' && !waiting ? thinkingScene(a, now) : 'hourglass'
  const thinking = a.status === 'running' && activity === 'thinking' && !waiting
  const n = scene !== 'hourglass' ? sceneFrame(a, now) : thinking ? sceneFrame(a, now) % 2 : 0
  return memo(spriteCache, `${a.status}|${activity}|${waiting}|${scene}|${n}`, () => {
    const shown = { ...a, activity, waitingFor: waiting ? a.waitingFor : undefined }
    const body = scene === 'hourglass' ? accessory(shown, n === 1) + creature(shown) : sceneSvg(shown, scene, n)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SPRITE_W}" height="${SPRITE_H}" viewBox="0 -4 44 34">${styleFor(body)}${body}</svg>`
  })
}

/** The header's small crew member: running or done (with the flag). */
export function headerSvg(done: boolean): string {
  const a = { status: done ? 'done' : 'running', activity: 'thinking' } as Agent
  return spriteSvg(a, 0)
}

const barCache = new Map<string, string>()

/**
 * The segmented pixel progress bar. While running, the next segment blinks, and the bar is
 * never drawn full: the segments round down and stop one short of the end.
 */
export function barSvg(share: number, color: string, running: boolean, width: number, segments = 14, height = 7): string {
  const filled = running ? Math.min(segments - 1, Math.floor(share * segments)) : Math.min(segments, Math.round(share * segments))
  return memo(barCache, `${filled}|${color}|${running}|${width}|${segments}|${height}`, () => {
    const segW = (width - (segments - 1) * 2) / segments
    let body = ''
    for (let i = 0; i < segments; i++) {
      const x = (i * (segW + 2)).toFixed(1)
      const next = running && i === filled
      body += `<rect${next ? ' class="seg"' : ''} x="${x}" y="0" width="${segW.toFixed(1)}" height="${height}" fill="${i < filled || next ? color : C.track}"/>`
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${styleFor(body)}${body}</svg>`
  })
}

// ── Terminal ─────────────────────────────────────────────────
export const textBar = (share: number, width = 16, running = false) =>
  '█'.repeat(running ? Math.min(width - 1, Math.floor(share * width)) : Math.round(share * width)).padEnd(width, '░')
// ── Terminal marker ──────────────────────────────────────────
// The terminal draws no critter: each row starts with a dot whose color carries the state.
export const DOT = '●'

/** The terminal row's dot color: working, waiting on you, done, failed or cancelled. */
export function dotColor(a: Pick<Agent, 'status' | 'waitingFor'>): string {
  if (a.status === 'running') return a.waitingFor ? C.yellow : C.body
  return a.status === 'done' ? C.green : a.status === 'failed' ? C.red : C.grey
}

