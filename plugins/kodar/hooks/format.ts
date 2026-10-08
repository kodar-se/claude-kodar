// The /kodar command's text: every live session the hub knows, the ones that need you first.

import { STALE_AFTER_MS, WAIT_LABELS, type SessionView } from './protocol'

type Group = { title: string; sessions: SessionView[] }

const isStale = (session: SessionView, now: number): boolean =>
  session.state !== 'ended' && now - session.seenAt > STALE_AFTER_MS

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** What a session is about right now, in the words that matter for its state. */
const what = (session: SessionView): string | null => {
  switch (session.state) {
    case 'waiting': {
      const label = session.waitReason ? WAIT_LABELS[session.waitReason] : null
      return [label, session.waitingFor].filter(Boolean).join(': ') || null
    }
    case 'working':
      return session.activity ?? session.lastPrompt
    default:
      return session.lastAnswer ?? session.lastPrompt ?? session.title
  }
}

const line = (session: SessionView, now: number, selfId: string): string => {
  const where = session.branch ? `${session.project} (${session.branch})` : session.project
  const parts = [where, `${session.device}/${session.account}`, ago(now - session.updatedAt)]
  const about = what(session)
  if (about) parts.push(about)
  return `  ${parts.join(' · ')}${session.id === selfId ? '  ← this session' : ''}`
}

export function formatSessions(sessions: readonly SessionView[], now: number, selfId: string): string {
  const live = sessions.filter(session => session.state !== 'ended')
  const fresh = live.filter(session => !isStale(session, now))
  const groups: Group[] = [
    { title: 'Needs you', sessions: fresh.filter(session => session.state === 'waiting') },
    { title: 'Your move', sessions: fresh.filter(session => session.state === 'idle') },
    { title: 'Working', sessions: fresh.filter(session => session.state === 'working') },
    { title: 'Quiet', sessions: live.filter(session => isStale(session, now)) },
  ]
  const shown = groups.filter(group => group.sessions.length > 0)
  if (shown.length === 0) return 'No live sessions.'
  const counts = shown.map(group => `${group.sessions.length} ${group.title.toLowerCase()}`).join(', ')
  return [
    `${live.length} live session${live.length === 1 ? '' : 's'} (${counts})`,
    ...shown.flatMap(group => [
      '',
      `${group.title}:`,
      ...[...group.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(session => line(session, now, selfId)),
    ]),
  ].join('\n')
}

/** Whether `version` comes before `latest`, by its dotted numbers. */
export function isOlderVersion(version: string, latest: string): boolean {
  const have = version.split('.').map(Number)
  const want = latest.split('.').map(Number)
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const step = (have[i] ?? 0) - (want[i] ?? 0)
    if (step !== 0) return step < 0
  }
  return false
}

const TURN_ON = 'turn on auto-update in /plugin (Marketplaces, kodar, Enable auto-update)'

/** What /kodar says about keeping the mod current on this machine, if anything. */
export function updateNote(modVersion: string | null, autoUpdate: boolean | null, latest: string | undefined): string | null {
  const isBehind = latest !== undefined && modVersion !== null && isOlderVersion(modVersion, latest)
  if (!isBehind) return autoUpdate === false ? `Claude Code doesn't update kodar here by itself: ${TURN_ON}.` : null
  const behind = `kodar ${latest} is out; this session runs ${modVersion}.`
  if (autoUpdate === true) return `${behind} Claude Code fetches it in the background, and new sessions load it.`
  if (autoUpdate === false) return `${behind} Update as the README's Updates says, and ${TURN_ON}.`
  return behind
}
