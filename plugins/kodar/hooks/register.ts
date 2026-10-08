// kodar: reports what this Claude Code session is doing to a kodar hub, so one
// dashboard shows every session across machines and accounts.
//
// Hooks only observe: each one notes what happened on the Reporter and calls
// next(e) unchanged. A timer sends what was noted every couple of seconds, so
// no hook waits on the network, and an empty send once a minute tells the hub
// the session is still alive.
//
// The engine reads `$` statically: it may only be handed to functions declared
// at the top of this file, which is why the Reporter is passed around rather
// than closed over.

import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { accountLabel, atDetail, describeTool, normalizeRemote, parseAccounts, profileEmail, projectName } from './describe'
import { formatSessions, updateNote } from './format'
import {
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  type Detail,
  type IngestBatch,
  type SessionEvent,
  type SessionList,
  type SessionSnapshot,
  type SessionState,
  type WaitReason,
} from './protocol'

/** How often noted events are sent. */
const FLUSH_MS = 2_000
/** Events kept while the hub can't be reached; the oldest go first. */
const MAX_QUEUED = 200
/** The longest pause between retries while the hub can't be reached. */
const MAX_BACKOFF_MS = 60_000
/** How long a session's end may wait for its last send. */
const END_FLUSH_MS = 1_500
/** Anthropic's profile of the session's login, which names its account. */
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
/** How long a send waits for the login to be looked up. */
const LOGIN_WAIT_MS = 5_000
/** How much of the end's END_FLUSH_MS a lookup still under way may take. */
const END_LOGIN_WAIT_MS = 500

/** The marketplace the mod installs from, by the name in its marketplace.json. */
const MARKETPLACE = 'kodar'

const DETAILS: readonly string[] = ['minimal', 'summary', 'full'] satisfies Detail[]

/** Tools that stop the turn until you answer. */
const WAITING_TOOLS: Readonly<Record<string, WaitReason | undefined>> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
}

const NOT_CONFIGURED =
  'kodar is not set up on this machine: run /plugin configure kodar@kodar and enter the hub URL and an ingest token.'

type Config = {
  hubUrl: string
  token: string
  device: string
  account: string
  accounts: ReadonlyMap<string, string>
  detail: Detail
}
type Identity = { device: string; account: string }
type Report = { at: number; isOk: boolean; text: string }

/** What this session has noted and not yet sent, and how sending goes. */
type Reporter = {
  config: Config
  isEnabled: boolean
  state: SessionState
  queue: SessionEvent[]
  /** The snapshot changed with no event to carry it. */
  isDirty: boolean
  isSending: boolean
  failures: number
  retryAt: number
  ticks: number
  branch: string | null
  identity: Identity | undefined
  /** The Accounts label of the session's login; null when it isn't listed or can't be read. */
  loginLabel: string | null
  /** A prompt or the session's start came after the last lookup: /login may have switched accounts since. */
  isLoginStale: boolean
  /** The lookup under way, which sends and /kodar wait for. */
  loginLookup: Promise<void> | undefined
  /** A turn has started; until then a headless session isn't reported. */
  hasPrompt: boolean
  /** The mod's own version; undefined until read, null when it can't be. */
  modVersion: string | null | undefined
  /** Whether Claude Code updates the mod by itself; null when settings don't declare its marketplace. */
  autoUpdate: boolean | null
  lastReport: Report | undefined
}

const option = (options: PluginOptions, key: string): string => {
  const value = options[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readConfig(options: PluginOptions): Config {
  const detail = option(options, 'detail')
  return {
    hubUrl: option(options, 'hub_url').replace(/\/+$/, ''),
    token: option(options, 'token'),
    device: option(options, 'device'),
    account: option(options, 'account'),
    accounts: parseAccounts(option(options, 'accounts')),
    detail: DETAILS.includes(detail) ? (detail as Detail) : 'summary',
  }
}

const asInput = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** An environment variable set to anything but off. */
const isOn = (value: string | undefined): boolean =>
  value !== undefined && !['', '0', 'false'].includes(value.trim().toLowerCase())

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function enqueue(r: Reporter, event: SessionEvent): void {
  if (!r.isEnabled) return
  const last = r.queue.at(-1)
  // Between two sends only the latest activity matters.
  if (event.type === 'activity' && last?.type === 'activity') r.queue[r.queue.length - 1] = event
  else r.queue.push(event)
  if (r.queue.length > MAX_QUEUED) r.queue = r.queue.slice(-MAX_QUEUED)
}

function setState(r: Reporter, state: SessionState): void {
  if (state === r.state) return
  r.state = state
  r.isDirty = true
}

function requeue(r: Reporter, events: SessionEvent[]): void {
  r.queue = [...events, ...r.queue].slice(-MAX_QUEUED)
  r.isDirty = true
}

function fail(r: Reporter, now: number, why: string): void {
  r.failures += 1
  r.retryAt = now + Math.min(MAX_BACKOFF_MS, FLUSH_MS * 2 ** r.failures)
  r.lastReport = { at: now, isOk: false, text: why }
}

function describeReport(last: Report | undefined): string {
  if (last === undefined) return 'nothing sent yet'
  return last.isOk ? `last send ok (${last.text})` : `last send failed (${last.text}), retrying`
}

async function hostname($: EngineInterface): Promise<string> {
  const short = (name: string): string => name.trim().split('.')[0] || name.trim()
  const fromEnv = (await $.env.get('HOSTNAME')) ?? (await $.env.get('COMPUTERNAME'))
  if (fromEnv) return short(fromEnv)
  try {
    const { exitCode, stdout } = await $.process.run(['hostname'], { timeoutMs: 5_000 })
    if (exitCode === 0 && stdout.trim() !== '') return short(stdout)
  } catch {
    // No process runner on this surface: fall through.
  }
  return 'unknown'
}

async function resolveIdentity($: EngineInterface, r: Reporter): Promise<Identity> {
  // KODAR_DEVICE_NAME wins over the configured name: a devcontainer can set it per container,
  // where settings.json may be shared with the host and the hostname is a container id.
  r.identity ??= {
    device: (await $.env.get('KODAR_DEVICE_NAME'))?.trim() || r.config.device || (await hostname($)),
    account: accountLabel(r.config.account, await $.env.get('CLAUDE_CONFIG_DIR')),
  }
  // A listed login wins over the Account label. It isn't kept with the rest: /login can switch it.
  return r.loginLabel === null ? r.identity : { ...r.identity, account: r.loginLabel }
}

/**
 * Asks Anthropic which account the session is logged in to, through the engine, which holds
 * the credential, and keeps the label Accounts gives it. The email itself never leaves here.
 */
async function lookUpLogin($: EngineInterface, r: Reporter): Promise<void> {
  try {
    const login = await $.session.authorize()
    let label: string | null = null
    // Only a subscription login has a profile; an API key, a gateway or no login keeps the Account label.
    if (login?.kind === 'bearer') {
      const response = await $.http.fetch(PROFILE_URL, { auth: login.handle })
      // A failed lookup keeps the label it had, so a network blip doesn't flip the account.
      if (!response.ok) return
      label = r.config.accounts.get(profileEmail(response.text) ?? '') ?? null
    }
    if (label === r.loginLabel) return
    r.loginLabel = label
    r.isDirty = true
  } catch {
    // No network, or nonessential traffic is off: keep the label it had.
  }
}

/** Starts a lookup if the login may have changed; answers the lookup under way, if any. */
function lookUpLoginIfStale($: EngineInterface, r: Reporter): Promise<void> | undefined {
  // Nothing to map a login to: no lookup.
  if (r.config.accounts.size === 0) return undefined
  if (r.isLoginStale && r.loginLookup === undefined) {
    r.isLoginStale = false
    r.loginLookup = lookUpLogin($, r).finally(() => {
      r.loginLookup = undefined
    })
  }
  return r.loginLookup
}

/** Looks the login up if it may have changed, or waits for the lookup under way, for at most `waitMs`. */
async function settleLogin($: EngineInterface, r: Reporter, waitMs = LOGIN_WAIT_MS): Promise<void> {
  const lookup = lookUpLoginIfStale($, r)
  if (lookup !== undefined) await Promise.race([lookup, $.clock.sleep(waitMs)])
}

/** The checked-out branch (one with no commits yet included), `detached@<sha>`, or null outside a repository. */
async function currentBranch($: EngineInterface): Promise<string | null> {
  const init = { cwd: await $.session.cwd(), timeoutMs: 5_000 }
  const named = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], init)
  if (named.exitCode === 0 && named.stdout.trim() !== '') return named.stdout.trim()
  const detached = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], init)
  return detached.exitCode === 0 && detached.stdout.trim() !== '' ? `detached@${detached.stdout.trim()}` : null
}

async function refreshBranch($: EngineInterface, r: Reporter): Promise<void> {
  let branch: string | null = null
  try {
    branch = await currentBranch($)
  } catch {
    // No git, or no process runner on this surface: no branch.
  }
  if (branch === r.branch) return
  r.branch = branch
  r.isDirty = true
}

/** The mod's own version, from the plugin.json it was installed with. */
async function readModVersion($: EngineInterface): Promise<string | null> {
  try {
    const manifest = asInput(JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)))
    return typeof manifest['version'] === 'string' ? manifest['version'] : null
  } catch {
    return null
  }
}

/**
 * Whether Claude Code updates the mod by itself: the marketplace's `autoUpdate` in settings, which
 * /plugin's Enable auto-update writes too, unless the environment turns every update off.
 */
async function readAutoUpdate($: EngineInterface): Promise<boolean | null> {
  const entry = asInput((await $.settings.read())['extraKnownMarketplaces'])[MARKETPLACE]
  if (entry === undefined) return null
  if (asInput(entry)['autoUpdate'] !== true) return false
  if (isOn(await $.env.get('FORCE_AUTOUPDATE_PLUGINS'))) return true
  return !(
    isOn(await $.env.get('DISABLE_AUTOUPDATER')) ||
    isOn(await $.env.get('DISABLE_UPDATES')) ||
    isOn(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
  )
}

/** Reads the mod's version once, and whether it updates itself each time: settings can change mid-session. */
async function refreshInstall($: EngineInterface, r: Reporter): Promise<void> {
  if (r.modVersion === undefined) r.modVersion = await readModVersion($)
  let autoUpdate: boolean | null = null
  try {
    autoUpdate = await readAutoUpdate($)
  } catch {
    // No settings on this surface: can't tell.
  }
  if (autoUpdate === r.autoUpdate) return
  r.autoUpdate = autoUpdate
  r.isDirty = true
}

async function snapshot($: EngineInterface, r: Reporter): Promise<SessionSnapshot> {
  const [id, cwd, repo, model, version, surfaces, usage, who] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.repo(),
    $.session.model(),
    $.session.version(),
    $.session.surfaces(),
    $.session.usage().catch(() => undefined),
    resolveIdentity($, r),
  ])
  const remote = repo?.remote ? normalizeRemote(repo.remote) : null
  return {
    id,
    device: who.device,
    account: who.account,
    cwd,
    project: projectName(remote, repo?.root ?? null, cwd),
    repo: remote,
    branch: r.branch,
    model,
    version: version.version,
    modVersion: r.modVersion ?? null,
    autoUpdate: r.autoUpdate,
    surface: surfaces[0] ?? null,
    state: r.state,
    contextPercent: usage?.context.percent ?? null,
    costUsd: usage?.cost?.usd ?? null,
  }
}

/**
 * Whether the session is worth reporting yet: it has a prompt, or a terminal or app to draw on.
 * VS Code starts short headless sessions of its own when it reloads; they never get a prompt,
 * and would otherwise show up on the dashboard as ended sessions.
 */
async function isWorthReporting($: EngineInterface, r: Reporter): Promise<boolean> {
  return r.hasPrompt || (await $.session.surfaces()).length > 0
}

/** Sends what is noted; with `isForced`, even while backing off. */
async function flush($: EngineInterface, r: Reporter, isForced = false): Promise<void> {
  if (!r.isEnabled || r.isSending || (r.queue.length === 0 && !r.isDirty)) return
  if (!(await isWorthReporting($, r))) return
  const now = await $.clock.now()
  if (!isForced && now < r.retryAt) return
  r.isSending = true
  const events = r.queue
  r.queue = []
  r.isDirty = false
  try {
    const batch: IngestBatch = { v: PROTOCOL_VERSION, session: await snapshot($, r), events }
    const response = await $.http.fetch(`${r.config.hubUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.config.token}` },
      body: JSON.stringify(batch),
    })
    if (response.ok) {
      r.failures = 0
      r.retryAt = 0
      r.lastReport = { at: now, isOk: true, text: `${events.length} event${events.length === 1 ? '' : 's'}` }
      return
    }
    // The hub would refuse a 4xx batch (bad token, bad shape) again: drop it.
    if (response.status === 429 || response.status >= 500) requeue(r, events)
    fail(r, now, `HTTP ${response.status}`)
  } catch (error) {
    requeue(r, events)
    fail(r, now, errorText(error))
  } finally {
    r.isSending = false
  }
}

/** A session's last send, after a moment for a login lookup still under way. */
async function endFlush($: EngineInterface, r: Reporter): Promise<void> {
  if (!(await isWorthReporting($, r))) return
  await settleLogin($, r, END_LOGIN_WAIT_MS)
  await drain($, r)
}

/** Waits out a send in flight, then sends what is left. */
async function drain($: EngineInterface, r: Reporter): Promise<void> {
  for (let i = 0; i < 10 && r.isSending; i++) await $.clock.sleep(100)
  await flush($, r, true)
}

async function tick($: EngineInterface, r: Reporter): Promise<void> {
  r.ticks += 1
  if (r.ticks % (HEARTBEAT_MS / FLUSH_MS) === 0) {
    await refreshBranch($, r)
    await refreshInstall($, r)
    r.isDirty = true
  }
  if (!(await isWorthReporting($, r))) return
  // Sends wait for the lookup, so a session doesn't show under the wrong account first.
  await settleLogin($, r)
  await flush($, r)
}

async function listSessions($: EngineInterface, r: Reporter): Promise<string> {
  if (!r.isEnabled) return NOT_CONFIGURED
  let listing: string
  let latest: string | undefined
  try {
    const response = await $.http.fetch(`${r.config.hubUrl}/api/sessions`, {
      headers: { authorization: `Bearer ${r.config.token}` },
    })
    if (!response.ok) return `${r.config.hubUrl} answered HTTP ${response.status}.`
    // An older hub sends no latestModVersion.
    const { sessions, now, latestModVersion } = JSON.parse(response.text) as Partial<SessionList> & Omit<SessionList, 'latestModVersion'>
    listing = formatSessions(sessions, now, await $.session.id())
    latest = typeof latestModVersion === 'string' ? latestModVersion : undefined
  } catch (error) {
    return `Could not reach ${r.config.hubUrl}: ${errorText(error)}`
  }
  await settleLogin($, r)
  const who = await resolveIdentity($, r)
  const source = r.loginLabel === null ? '' : ' (from its login)'
  const note = updateNote(r.modVersion ?? null, r.autoUpdate, latest)
  return `${listing}\n\nThis session reports as ${who.device}/${who.account}${source} to ${r.config.hubUrl}; ${describeReport(r.lastReport)}.${note === null ? '' : `\n${note}`}`
}

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const r: Reporter = {
    config,
    isEnabled: config.hubUrl !== '' && config.token !== '',
    state: 'idle',
    queue: [],
    isDirty: false,
    isSending: false,
    failures: 0,
    retryAt: 0,
    ticks: 0,
    branch: null,
    identity: undefined,
    loginLabel: null,
    isLoginStale: true,
    loginLookup: undefined,
    hasPrompt: false,
    modVersion: undefined,
    autoUpdate: null,
    lastReport: undefined,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kodar',
      description: 'List every Claude Code session your kodar hub knows about, the ones that need you first',
    })
    const started = await next(e)
    if (r.isEnabled) {
      enqueue(r, { type: 'start', at: await $.clock.now() })
      // Now, not at the first send: a short session can end before that, and its end can't wait long.
      if (await isWorthReporting($, r)) void lookUpLoginIfStale($, r)
      await refreshBranch($, r)
      await refreshInstall($, r)
      $.clock.every(FLUSH_MS, () => void tick($, r))
    }
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (r.isEnabled) {
      r.hasPrompt = true
      // You may have run /login since the last prompt: look again, without waiting here.
      r.isLoginStale = true
      void lookUpLoginIfStale($, r)
      setState(r, 'working')
      enqueue(r, { type: 'prompt', at: await $.clock.now(), text: atDetail(config.detail, e.text) })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!r.isEnabled) return next(e)
    const tool = String(e.tool)
    const at = await $.clock.now()
    const summary = atDetail(config.detail, describeTool(tool, asInput(e), await $.session.cwd()))
    const waitReason = WAITING_TOOLS[tool]
    if (waitReason !== undefined && e.agentId === undefined) {
      setState(r, 'waiting')
      enqueue(r, { type: 'waiting', at, reason: waitReason, summary })
    } else {
      enqueue(r, { type: 'activity', at, tool, summary, isSubagent: e.agentId !== undefined })
    }
    const result = await next(e)
    // Whatever held the call (a question, a plan, a permission prompt) is answered.
    if (r.state === 'waiting') setState(r, 'working')
    return result
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    if (r.isEnabled) {
      setState(r, 'waiting')
      const summary = atDetail(config.detail, describeTool(e.tool_name, asInput(e.tool_input), e.cwd))
      enqueue(r, {
        type: 'waiting',
        at: await $.clock.now(),
        reason: 'permission',
        summary: summary ? `${e.tool_name}: ${summary}` : e.tool_name,
      })
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    // A permission prompt is already reported by PermissionRequest; this catches an MCP server's elicitation.
    if (r.isEnabled && r.state !== 'waiting' && /permission|elicitation/i.test(e.notification_type)) {
      setState(r, 'waiting')
      enqueue(r, {
        type: 'waiting',
        at: await $.clock.now(),
        reason: 'notification',
        summary: atDetail(config.detail, e.message),
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (r.isEnabled && e.agentId === undefined) {
      setState(r, 'idle')
      enqueue(r, {
        type: 'done',
        at: await $.clock.now(),
        answer: atDetail(config.detail, e.answer),
        durationMs: e.durationMs,
        isAborted: e.isAborted,
      })
      await refreshBranch($, r)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (r.isEnabled) {
      setState(r, 'ended')
      enqueue(r, { type: 'end', at: await $.clock.now(), reason: String(e.reason) })
      await Promise.race([endFlush($, r), $.clock.sleep(END_FLUSH_MS)])
    }
    const ended = await next(e)
    if (r.isEnabled && String(e.reason) === 'clear') {
      // /clear goes on under a new session id with no session.start: report it as a new session.
      r.state = 'idle'
      r.isDirty = true
      enqueue(r, { type: 'start', at: await $.clock.now() })
    }
    return ended
  })

  on('command.run', { command: 'kodar' }, async $ => ({ text: await listSessions($, r) }))
}
