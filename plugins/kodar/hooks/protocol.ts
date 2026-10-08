// The wire format between the kodar mod and the hub. The hub imports this
// file too, so it holds only types and constants: no imports,
// nothing that needs the mod's runtime.

export const PROTOCOL_VERSION = 1

/** How often a live session reports even when nothing happens: a batch with no events. */
export const HEARTBEAT_MS = 60_000

/** A session not heard from for this long is shown as quiet (asleep, crashed, offline). */
export const STALE_AFTER_MS = 3 * HEARTBEAT_MS

/**
 * - `idle`: the turn is over; the session waits for its next prompt (your move)
 * - `working`: a turn is running
 * - `waiting`: blocked on you mid-turn (a permission prompt, a question, a plan)
 * - `ended`: the session exited or was cleared
 */
export type SessionState = 'idle' | 'working' | 'waiting' | 'ended'

/** How much of the session's text the mod sends; set per machine in the mod's config. */
export type Detail = 'minimal' | 'summary' | 'full'

export type WaitReason = 'permission' | 'question' | 'plan' | 'notification'

export const WAIT_LABELS: Readonly<Record<WaitReason, string>> = {
  permission: 'Permission',
  question: 'Question',
  plan: 'Plan to review',
  notification: 'Needs attention',
}

/** Where a session runs and how it stands, sent whole with every batch. */
export type SessionSnapshot = {
  /** Claude Code's session id. */
  id: string
  device: string
  account: string
  cwd: string
  /** Display name: the repository's name, or the working directory's. */
  project: string
  /** The origin remote as `host/owner/name`, credentials stripped. */
  repo: string | null
  branch: string | null
  model: string | null
  /** Claude Code's version. */
  version: string | null
  /** The kodar mod's version, from its plugin.json; null from mods older than 0.4.0, which don't send it. */
  modVersion: string | null
  /** Whether Claude Code updates the mod on this machine by itself; null when its settings don't declare the kodar marketplace. */
  autoUpdate: boolean | null
  /** `terminal`, `desktop`, `vscode`, `mobile`, or null when headless. */
  surface: string | null
  state: SessionState
  contextPercent: number | null
  costUsd: number | null
}

export type SessionEvent =
  | { type: 'start'; at: number }
  | { type: 'prompt'; at: number; text: string | null }
  | { type: 'activity'; at: number; tool: string; summary: string | null; isSubagent: boolean }
  | { type: 'waiting'; at: number; reason: WaitReason; summary: string | null }
  | { type: 'done'; at: number; answer: string | null; durationMs: number; isAborted: boolean }
  | { type: 'end'; at: number; reason: string }

export type SessionEventType = SessionEvent['type']

/** The body of `POST /api/events`. */
export type IngestBatch = {
  v: typeof PROTOCOL_VERSION
  session: SessionSnapshot
  events: SessionEvent[]
}

/** A session as the hub serves it to the dashboard and to `/kodar`. */
export type SessionView = SessionSnapshot & {
  /** The session's first prompt. */
  title: string | null
  lastPrompt: string | null
  /** What the session did last, as `Tool: summary`. */
  activity: string | null
  /** Why the session waits on you, while `state` is `waiting`. */
  waitReason: WaitReason | null
  /** What it waits on you for, while `state` is `waiting`. */
  waitingFor: string | null
  lastAnswer: string | null
  startedAt: number
  /** When something last happened (heartbeats excluded). */
  updatedAt: number
  /** When the hub last heard from the session (heartbeats included). */
  seenAt: number
  endedAt: number | null
}

/**
 * What `GET /api/sessions` answers. `latestModVersion` is the mod's version in the hub's own build,
 * the one `claude plugin update` would fetch.
 */
export type SessionList = { sessions: SessionView[]; now: number; latestModVersion: string }

/** What the hub pushes to dashboards over `/api/live`. */
export type HubMessage =
  | ({ type: 'sessions' } & SessionList)
  | { type: 'session'; session: SessionView; now: number }
