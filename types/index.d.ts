export type AgentStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** What an agent is doing right now: picks the accessory its crew member holds. */
export type Activity = 'starting' | 'thinking' | 'searching' | 'reading' | 'writing' | 'running' | 'web'

/** One step of the agent's own to-do list (TodoWrite / TaskCreate). */
export type Step = { id: string; label: string; status: 'pending' | 'in_progress' | 'completed' }

/** Token counts as the API reports them, summed over the agent's requests. */
export type Tokens = { input: number; output: number; cacheWrite: number; cacheRead: number }

/** One recent tool call, for the details panel. */
export type RecentTool = { label: string; failed?: boolean }

/** A file an agent read or changed, for the details panel. */
export type TouchedFile = { path: string; changed?: true }

export type Agent = {
  id: string
  /** The subagent type: Explore, Plan, general-purpose, a plugin's agent. */
  type: string
  description: string
  model: string
  status: AgentStatus
  activity: Activity
  /** What the activity is about: the pattern searched, the file read, the command run. */
  target: string
  /** When the activity last changed, and what it was before: short thinking pauses don't flicker. */
  activityAt: number
  /** The last time any event of this agent arrived: a sign of life for spotting agents that vanished. */
  seenAt: number
  prevActivity?: Activity
  prevTarget?: string
  /** The agent's own to-do list, when it keeps one: real step progress. */
  steps?: Step[]
  startedAt: number
  endedAt?: number
  tokens: Tokens
  tools: number
  /** The tool an agent is waiting on the person's approval for; absent when it isn't waiting. */
  waitingFor?: string
  /** The last few tool calls, newest last: shown in the details panel. */
  recent?: RecentTool[]
  /** The files it read or changed, newest last; a file changed once stays changed. */
  files?: TouchedFile[]
  /** Closed by the mod (the engine reported it ended, or it vanished), not by its own turn.complete. */
  retired?: true
  /** The highest progress shown so far: a revised estimate never moves the bar backwards. */
  shownShare?: number
  /** Model requests made (turn.step): a progress clock independent of time. */
  requests: number
  /** The subagent that started this one; absent for agents started by the main conversation. */
  parentId?: string
  demo?: boolean
  /** Fixed duration for demo agents; real agents learn from history. */
  expectedMs?: number
  /** The main conversation's turn, on the title's own record: its events count only while it runs. */
  turnId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-crew': {
      agents: Agent[]
      /** Claude's own work in the main conversation, drawn on the title row; null between turns. */
      main: Agent | null
      hidden: boolean
      expanded: string[]
      collapsed: boolean
    }
  }
}
