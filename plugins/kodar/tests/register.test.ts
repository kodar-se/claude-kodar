import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import { accountLabel, atDetail, describeTool, normalizeRemote, parseAccounts, profileEmail } from '../hooks/describe'
import { isOlderVersion, updateNote } from '../hooks/format'
import type { IngestBatch, SessionList, SessionView } from '../hooks/protocol'

const HUB = { hub_url: 'https://hub.test/', token: 'ingest-token', device: 'box', account: 'personal' }
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

/** /kodar as typed at the prompt. */
const KODAR_COMMAND = {
  command: 'kodar',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

type Sent = { url: string; method: string; authorization: string | undefined; auth: string | undefined; body: string }

/** Whose account the session is logged in to; tests change it to play a /login. */
type Login = { email: string | null }

const view = (overrides: Partial<SessionView>): SessionView => ({
  id: 'other',
  device: 'laptop',
  account: 'work',
  cwd: '/src/api',
  project: 'api',
  repo: null,
  branch: 'main',
  model: null,
  version: null,
  modVersion: null,
  autoUpdate: null,
  surface: 'terminal',
  state: 'working',
  contextPercent: null,
  costUsd: null,
  title: null,
  lastPrompt: null,
  activity: null,
  waitReason: null,
  waitingFor: null,
  lastAnswer: null,
  startedAt: 0,
  updatedAt: 990_000,
  seenAt: 995_000,
  endedAt: null,
  ...overrides,
})

/** Stands in for the engine beneath the mod: one session in a repository, and a hub that takes everything. */
type Git = (argv: readonly string[]) => { exitCode: number; stdout: string }

const ON_BRANCH: Git = () => ({ exitCode: 0, stdout: 'feature/login\n' })

function world(
  on: On,
  sent: Sent[],
  {
    listing = { sessions: [], now: 0 },
    git = ON_BRANCH,
    env = {},
    login = { email: null },
    surfaces = ['terminal'],
    settings = {},
  }: {
    /** Without latestModVersion, as from an older hub. */
    listing?: Omit<SessionList, 'latestModVersion'> & { latestModVersion?: string }
    git?: Git
    env?: Record<string, string>
    login?: Login
    /** Empty for a headless session. */
    surfaces?: string[]
    /** The settings merged over every source. */
    settings?: Record<string, unknown>
  } = {},
): MockClock {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.repo', () => ({
    value: { root: '/work/app', remote: 'https://me:ghp_secret@github.com/someone/app.git', internal: false, name: null },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.version', () => ({ value: { version: '2.1.288' } }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 42 }, rateLimits: [], cost: { usd: 1.25 } },
  }))
  on('process.run', ($, e) => ({
    value: { ...git(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.read', ($, e) => {
    if (!e.path.endsWith('/.claude-plugin/plugin.json')) throw new Error(`ENOENT: ${e.path}`)
    return { value: JSON.stringify({ name: 'kodar', version: '0.4.0' }) }
  })
  on('settings.read', () => ({ value: settings }))
  on('session.authorize', () => ({
    value: login.email === null ? null : { handle: `handle-${login.email}`, kind: 'bearer' as const },
  }))
  on('http.fetch', ($, e) => {
    const headers = e.init?.headers ?? {}
    sent.push({
      url: e.url,
      method: e.init?.method ?? 'GET',
      authorization: headers['authorization'],
      auth: e.init?.auth,
      body: e.init?.body ?? '',
    })
    const text = e.url === PROFILE_URL ? JSON.stringify({ account: { email: login.email } }) : JSON.stringify(listing)
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
  on('classic.PermissionRequest', () => ({}))
  return clock
}

const batches = (sent: readonly Sent[]): IngestBatch[] =>
  sent.filter(s => s.url.endsWith('/api/events')).map(s => JSON.parse(s.body) as IngestBatch)

const startSession = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
}

describe('reporting', () => {
  test('a turn reaches the hub with the session around it', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent)
    await startSession($)
    await $.turn.start({ text: 'Fix the login bug', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
    await clock.advance(2_000)

    const [first] = batches(sent)
    expect(sent[0]?.url).toBe('https://hub.test/api/events')
    expect(sent[0]?.authorization).toBe('Bearer ingest-token')
    expect(first?.session).toEqual(
      expect.objectContaining({
        id: 'sess-1',
        device: 'box',
        account: 'personal',
        project: 'app',
        repo: 'github.com/someone/app',
        branch: 'feature/login',
        state: 'working',
        contextPercent: 42,
        costUsd: 1.25,
        modVersion: '0.4.0',
        autoUpdate: null,
      }),
    )
    expect(first?.events.map(event => event.type)).toEqual(['start', 'prompt', 'activity'])
    expect(first?.events[1]).toEqual(expect.objectContaining({ text: 'Fix the login bug' }))
    expect(first?.events[2]).toEqual(expect.objectContaining({ tool: 'Bash', summary: 'Run the tests' }))
    expect(sent[0]?.body.includes('ghp_secret')).toBe(false)

    await $.turn.complete({ answer: 'Fixed it.', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(2_000)
    const second = batches(sent)[1]
    expect(second?.session.state).toBe('idle')
    expect(second?.events).toEqual([expect.objectContaining({ type: 'done', answer: 'Fixed it.', isAborted: false })])
  })

  test('a permission prompt marks the session as waiting on you', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent)
    await startSession($)
    await $.turn.start({ text: 'Ship it', turnId: 't1' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
    await clock.advance(2_000)

    const [first] = batches(sent)
    expect(first?.session.state).toBe('waiting')
    expect(first?.events.at(-1)).toEqual(
      expect.objectContaining({ type: 'waiting', reason: 'permission', summary: 'Bash: git push origin main' }),
    )
  })

  test('nothing is sent between heartbeats when nothing happens', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent)
    await startSession($)
    await clock.advance(2_000)
    expect(batches(sent)).toHaveLength(1)
    await clock.advance(30_000)
    expect(batches(sent)).toHaveLength(1)
    await clock.advance(30_000)
    const beat = batches(sent)[1]
    expect(beat?.events).toEqual([])
  })

  test('minimal detail sends no text', { options: { ...HUB, detail: 'minimal' } }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent)
    await startSession($)
    await $.turn.start({ text: 'Rotate the production keys', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/app/secrets.md' })
    await clock.advance(2_000)

    const [first] = batches(sent)
    expect(first?.events[1]).toEqual(expect.objectContaining({ type: 'prompt', text: null }))
    expect(first?.events[2]).toEqual(expect.objectContaining({ tool: 'Read', summary: null }))
  })

  test('the end of a session is sent before it closes', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    world(on, sent)
    await startSession($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: undefined as never })
    const last = batches(sent).at(-1)
    expect(last?.session.state).toBe('ended')
    expect(last?.events.at(-1)).toEqual(expect.objectContaining({ type: 'end', reason: 'prompt_input_exit' }))
  })

  test('a detached HEAD reads as its commit', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, {
      git: argv => (argv.includes('symbolic-ref') ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: 'abc1234\n' }),
    })
    await startSession($)
    await clock.advance(2_000)
    expect(batches(sent)[0]?.session.branch).toBe('detached@abc1234')
  })

  test('KODAR_DEVICE_NAME names the device over the setting', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, { env: { KODAR_DEVICE_NAME: ' desktop ', HOSTNAME: 'a-container-id' } })
    await startSession($)
    await clock.advance(2_000)
    expect(batches(sent)[0]?.session.device).toBe('desktop')
  })

  // A devcontainer passes on ${localEnv:KODAR_DEVICE_NAME} as empty when the host doesn't set it.
  test('an empty KODAR_DEVICE_NAME leaves the setting in charge', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, { env: { KODAR_DEVICE_NAME: '', HOSTNAME: 'a-container-id' } })
    await startSession($)
    await clock.advance(2_000)
    expect(batches(sent)[0]?.session.device).toBe('box')
  })

  const ACCOUNTS = { ...HUB, accounts: 'Me@Home.example=personal, me@work.example=work' }

  test('a listed login names the account, and a /login switches it', { options: ACCOUNTS }, async ($, on) => {
    const sent: Sent[] = []
    const login: Login = { email: 'me@work.example' }
    const clock = world(on, sent, { login })
    await startSession($)
    await clock.advance(2_000)
    expect(batches(sent)[0]?.session.account).toBe('work')
    expect(sent.find(s => s.url === PROFILE_URL)?.auth).toBe('handle-me@work.example')

    login.email = 'me@home.example'
    await $.turn.start({ text: 'Carry on', turnId: 't1' })
    await clock.advance(2_000)
    expect(batches(sent).at(-1)?.session.account).toBe('personal')
    expect(sent.some(s => s.body.includes('@'))).toBe(false)
  })

  // A headless run can end before the first send, which is then all it ever sends.
  test('a session that ends at once still reports its login', { options: ACCOUNTS }, async ($, on) => {
    const sent: Sent[] = []
    world(on, sent, { login: { email: 'me@work.example' } })
    await startSession($)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: undefined as never })
    expect(batches(sent).at(-1)?.session).toEqual(expect.objectContaining({ account: 'work', state: 'ended' }))
  })

  test('an unlisted login, or none, keeps the Account label', { options: ACCOUNTS }, async ($, on) => {
    const sent: Sent[] = []
    const login: Login = { email: 'someone@else.example' }
    const clock = world(on, sent, { login })
    await startSession($)
    await clock.advance(2_000)
    expect(batches(sent)[0]?.session.account).toBe('personal')

    login.email = null
    await $.turn.start({ text: 'Carry on', turnId: 't1' })
    await clock.advance(2_000)
    expect(batches(sent).at(-1)?.session.account).toBe('personal')
  })

  test('without Accounts the login is never looked up', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, { login: { email: 'me@work.example' } })
    await startSession($)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await clock.advance(2_000)
    expect(sent.some(s => s.url === PROFILE_URL)).toBe(false)
    expect(batches(sent)[0]?.session.account).toBe('personal')
  })

  test("a headless session that never gets a prompt isn't reported", { options: ACCOUNTS }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, { login: { email: 'me@work.example' }, surfaces: [] })
    await startSession($)
    await clock.advance(70_000)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: undefined as never })
    expect(sent).toEqual([])
  })

  test('a headless session reports once it gets a prompt', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, { surfaces: [] })
    await startSession($)
    await clock.advance(2_000)
    expect(batches(sent)).toHaveLength(0)
    await $.turn.start({ text: 'Summarise the diff', turnId: 't1' })
    await clock.advance(2_000)
    const [first] = batches(sent)
    expect(first?.session.surface).toBe(null)
    expect(first?.events.map(event => event.type)).toEqual(['start', 'prompt'])
  })

  test('auto-update follows the marketplace setting', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, { settings: { extraKnownMarketplaces: { kodar: { source: {}, autoUpdate: true } } } })
    await startSession($)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await clock.advance(2_000)
    expect(batches(sent)[0]?.session.autoUpdate).toBe(true)
  })

  test('DISABLE_AUTOUPDATER turns auto-update off whatever the setting says', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent, {
      settings: { extraKnownMarketplaces: { kodar: { source: {}, autoUpdate: true } } },
      env: { DISABLE_AUTOUPDATER: '1' },
    })
    await startSession($)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await clock.advance(2_000)
    expect(batches(sent)[0]?.session.autoUpdate).toBe(false)
  })

  test('an unconfigured mod sends nothing and /kodar says how to set it up', async ($, on) => {
    const sent: Sent[] = []
    const clock = world(on, sent)
    await startSession($)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await clock.advance(10_000)
    expect(sent).toHaveLength(0)
    const answer = await $.command.run(KODAR_COMMAND)
    expect(answer.text).toContain('/plugin configure kodar@kodar')
  })
})

describe('/kodar', () => {
  test('lists the sessions that need you first', { options: HUB }, async ($, on) => {
    const sent: Sent[] = []
    const listing = {
      now: 1_000_000,
      sessions: [
        view({ id: 'a', project: 'api', state: 'working', activity: 'Bash: npm test' }),
        view({ id: 'b', project: 'web', state: 'waiting', waitReason: 'permission', waitingFor: 'Bash: git push' }),
        view({ id: 'sess-1', project: 'app', state: 'idle', lastAnswer: 'Done.' }),
      ],
    }
    world(on, sent, { listing })
    await startSession($)
    const answer = await $.command.run(KODAR_COMMAND)
    const text = answer.text ?? ''
    expect(text).toContain('3 live sessions')
    expect(text.indexOf('Needs you:')).toBeLessThan(text.indexOf('Your move:'))
    expect(text.indexOf('Your move:')).toBeLessThan(text.indexOf('Working:'))
    expect(text).toContain('web (main) · laptop/work · 10s · Permission: Bash: git push')
    expect(text).toContain('← this session')
    expect(sent.find(s => s.url === 'https://hub.test/api/sessions')?.authorization).toBe('Bearer ingest-token')
  })

  test('says when the account comes from the login', { options: { ...HUB, accounts: 'me@work.example=work' } }, async ($, on) => {
    world(on, [], { login: { email: 'me@work.example' } })
    await startSession($)
    const answer = await $.command.run(KODAR_COMMAND)
    expect(answer.text).toContain('This session reports as box/work (from its login)')
  })

  test('says when a newer mod is out', { options: HUB }, async ($, on) => {
    world(on, [], {
      listing: { sessions: [], now: 0, latestModVersion: '0.10.0' },
      settings: { extraKnownMarketplaces: { kodar: { source: {} } } },
    })
    await startSession($)
    const answer = await $.command.run(KODAR_COMMAND)
    expect(answer.text).toContain('kodar 0.10.0 is out; this session runs 0.4.0.')
    expect(answer.text).toContain('Enable auto-update')
  })

  test('says nothing about updates when the mod is current', { options: HUB }, async ($, on) => {
    world(on, [], { listing: { sessions: [], now: 0, latestModVersion: '0.4.0' } })
    await startSession($)
    const answer = await $.command.run(KODAR_COMMAND)
    expect(answer.text).not.toContain('kodar 0.4.0')
    expect(answer.text).not.toContain('auto-update')
  })
})

describe('versions', () => {
  test('compare by their numbers, not as text', () => {
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true)
    expect(isOlderVersion('0.4.0', '0.4')).toBe(false)
    expect(isOlderVersion('1.0.0', '0.10.0')).toBe(false)
  })

  test('the update note says what to do', () => {
    expect(updateNote('0.4.0', true, '0.4.0')).toBe(null)
    expect(updateNote('0.4.0', null, undefined)).toBe(null)
    expect(updateNote('0.4.0', true, '0.5.0')).toContain('fetches it in the background')
    expect(updateNote('0.4.0', false, '0.4.0')).toContain('Enable auto-update')
  })
})

describe('describe', () => {
  test('remotes lose their credentials and .git', () => {
    expect(normalizeRemote('https://me:ghp_x@github.com/someone/repo.git')).toBe('github.com/someone/repo')
    expect(normalizeRemote('git@github.com:someone/repo.git')).toBe('github.com/someone/repo')
    expect(normalizeRemote('ssh://git@gitlab.com/group/sub/repo.git')).toBe('gitlab.com/group/sub/repo')
  })

  test('tool calls read as one line', () => {
    expect(describeTool('Edit', { file_path: '/work/app/src/a.ts' }, '/work/app')).toBe('src/a.ts')
    expect(describeTool('Bash', { command: 'npm test\nnpm run lint' }, '/')).toBe('npm test')
    expect(
      describeTool('TodoWrite', { todos: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b', activeForm: 'Writing b' }] }, '/'),
    ).toBe('Writing b')
    expect(describeTool('Mystery', {}, '/')).toBe(undefined)
  })

  test('text is clipped to the detail level', () => {
    expect(atDetail('summary', 'x'.repeat(500))?.length).toBe(160)
    expect(atDetail('minimal', 'anything')).toBe(null)
    expect(atDetail('full', '  spaced\n\nout  ')).toBe('spaced out')
  })

  test('the account falls back to the config folder', () => {
    expect(accountLabel('work', '/home/me/.claude-personal')).toBe('work')
    expect(accountLabel('', '/home/me/.claude-personal')).toBe('claude-personal')
    expect(accountLabel('', '/home/me/.claude')).toBe('default')
    expect(accountLabel('', undefined)).toBe('default')
  })

  test('Accounts maps lower-cased emails to labels', () => {
    const accounts = parseAccounts(' Me@Home.example = personal ,me@work.example=work\nbroken, no-at=x, x@y.example=')
    expect([...accounts]).toEqual([
      ['me@home.example', 'personal'],
      ['me@work.example', 'work'],
    ])
    expect(profileEmail(JSON.stringify({ account: { email: ' Me@Work.example ' } }))).toBe('me@work.example')
    expect(profileEmail('{"account":{}}')).toBe(null)
    expect(profileEmail('not json')).toBe(null)
  })
})
