import {
  PLAYBACK_DIAGNOSTIC_LIMIT,
  type PlaybackDiagnostic,
  type PlaybackDiagnosticInput,
} from '@repo/schemas/playback-diagnostics'

export const PLAYBACK_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function updatePlaybackDiagnostics(
  previous: PlaybackDiagnostic[],
  now: number,
  input: readonly PlaybackDiagnosticInput[],
) {
  const events = previous.filter(
    (event) => event.receivedAt > now - PLAYBACK_DIAGNOSTIC_RETENTION_MS,
  )
  const retainedCount = events.length
  const eventIds = new Set(events.map((event) => event.eventId))
  for (const event of input) {
    if (event.eventId && eventIds.has(event.eventId)) continue
    events.push({ ...event, receivedAt: now })
    if (event.eventId) eventIds.add(event.eventId)
  }
  return {
    events: events.slice(-PLAYBACK_DIAGNOSTIC_LIMIT),
    changed:
      previous.length !== retainedCount || events.length !== retainedCount,
  }
}
