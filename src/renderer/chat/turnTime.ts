const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`
}

function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function formatExactTurnDateTime(timestampMs: number): string {
  const date = new Date(timestampMs)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(date)}:${pad2(date.getSeconds())}`
}

export function formatChatTimestamp(timestampMs: number, nowMs = Date.now()): string {
  const date = new Date(timestampMs)
  const now = new Date(nowMs)
  const sameYear = date.getFullYear() === now.getFullYear()
  const sameDay = sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return formatClock(date)
  if (sameYear) return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${formatClock(date)}`
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(date)}`
}

export function formatTurnDuration(durationMs: number | undefined): string | undefined {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 1000) return undefined
  if (durationMs < 10_000) {
    return `${(durationMs / 1000).toFixed(1).replace(/\.0$/, '')}s`
  }
  const totalSec = Math.round(durationMs / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`
}

export interface FormattedTurnTime {
  readonly short: string
  readonly duration?: string
  readonly tooltip: string
  readonly iso: string
}

export function formatTurnTimestamps(
  turn: { readonly startedAt?: string; readonly duration?: number },
  isResponding: boolean,
  nowMs = Date.now(),
): {
  readonly user?: FormattedTurnTime
  readonly assistant?: FormattedTurnTime
} {
  if (!turn.startedAt) return {}
  const startMs = Date.parse(turn.startedAt)
  if (!Number.isFinite(startMs) || startMs < 0) return {}

  const user: FormattedTurnTime = {
    short: formatChatTimestamp(startMs, nowMs),
    tooltip: `Sent ${formatExactTurnDateTime(startMs)}`,
    iso: new Date(startMs).toISOString(),
  }

  if (isResponding) return { user }

  const durationMs = typeof turn.duration === 'number' && Number.isFinite(turn.duration) && turn.duration >= 0
    ? turn.duration
    : 0
  const endMs = startMs + durationMs
  const duration = formatTurnDuration(turn.duration)
  const assistant: FormattedTurnTime = {
    short: formatChatTimestamp(endMs, nowMs),
    ...(duration ? { duration } : {}),
    tooltip: duration
      ? `Completed ${formatExactTurnDateTime(endMs)} · ${duration}`
      : `Completed ${formatExactTurnDateTime(endMs)}`,
    iso: new Date(endMs).toISOString(),
  }

  return { user, assistant }
}
