// Pure helpers that turn what the engine hands the mod into short, display-ready text.

import type { Detail } from './protocol'

/** How many characters of free text (prompts, answers, summaries) each detail level sends. */
const TEXT_LIMITS: Record<Detail, number> = { minimal: 0, summary: 160, full: 2000 }

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Free text at the configured detail level; null when the level sends none. */
export function atDetail(detail: Detail, text: string | null | undefined): string | null {
  const max = TEXT_LIMITS[detail]
  if (max === 0 || !text) return null
  const clipped = clip(text, max)
  return clipped === '' ? null : clipped
}

type Input = Record<string, unknown>

const str = (input: Input, key: string): string | undefined => {
  const value = input[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

const relative = (path: string | undefined, cwd: string): string | undefined => {
  if (path === undefined) return undefined
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

const firstLine = (text: string | undefined): string | undefined => text?.split('\n', 1)[0]

const host = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The task a TodoWrite call marks in progress, as its `activeForm` words it. */
const currentTodo = (input: Input): string | undefined => {
  const todos = input['todos']
  if (!Array.isArray(todos)) return undefined
  const active = todos.find(
    (todo): todo is Input => typeof todo === 'object' && todo !== null && (todo as Input)['status'] === 'in_progress',
  )
  return active ? (str(active, 'activeForm') ?? str(active, 'content')) : undefined
}

const firstQuestion = (input: Input): string | undefined => {
  const questions = input['questions']
  if (!Array.isArray(questions)) return undefined
  const first: unknown = questions[0]
  return typeof first === 'object' && first !== null ? str(first as Input, 'question') : undefined
}

/** One line on what a tool call does, from its input; undefined when nothing useful can be said. */
export function describeTool(tool: string, input: Input, cwd: string): string | undefined {
  switch (tool) {
    case 'Bash':
      return str(input, 'description') ?? firstLine(str(input, 'command'))
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return relative(str(input, 'file_path'), cwd)
    case 'NotebookEdit':
      return relative(str(input, 'notebook_path'), cwd)
    case 'Grep':
    case 'Glob':
      return str(input, 'pattern')
    case 'WebFetch':
      return host(str(input, 'url'))
    case 'WebSearch':
      return str(input, 'query')
    case 'Agent':
    case 'Task':
      return str(input, 'description')
    case 'TodoWrite':
      return currentTodo(input)
    case 'Skill':
      return str(input, 'skill')
    case 'AskUserQuestion':
      return firstQuestion(input)
    default:
      return undefined
  }
}

/**
 * The origin remote as `host/owner/name`, never with credentials: an https
 * remote may carry a token in its userinfo.
 */
export function normalizeRemote(remote: string): string {
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(remote)
  if (scp) return `${scp[1]}/${trimRepoPath(scp[2] ?? '')}`
  try {
    const url = new URL(remote)
    if (url.protocol === 'file:') return trimRepoPath(url.pathname)
    return `${url.host}/${trimRepoPath(url.pathname)}`
  } catch {
    return trimRepoPath(remote)
  }
}

const trimRepoPath = (path: string): string =>
  path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').at(-1) || path

/** The name a session is listed under: the repository's, else its folder's. */
export function projectName(repo: string | null, root: string | null, cwd: string): string {
  if (repo) return basename(repo)
  return basename(root ?? cwd)
}

/** The account label to report: the configured one, else the CLAUDE_CONFIG_DIR folder (one per account is common), else `default`. */
export function accountLabel(configured: string, configDir: string | undefined): string {
  if (configured.trim() !== '') return configured.trim()
  if (configDir) {
    const name = basename(configDir).replace(/^\./, '')
    if (name !== '' && name !== 'claude') return name
  }
  return 'default'
}

/** The Accounts setting, `email=label` pairs split by commas or new lines, as labels by lower-cased email. */
export function parseAccounts(text: string): ReadonlyMap<string, string> {
  const accounts = new Map<string, string>()
  for (const pair of text.split(/[,\n]/)) {
    const [email = '', label = ''] = pair.split('=').map(part => part.trim())
    if (email.includes('@') && label !== '') accounts.set(email.toLowerCase(), label)
  }
  return accounts
}

/** The login's email from Anthropic's profile answer, lower-cased; null when it has none. */
export function profileEmail(profile: string): string | null {
  try {
    const email = (JSON.parse(profile) as { account?: { email?: unknown } }).account?.email
    return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null
  } catch {
    return null
  }
}
