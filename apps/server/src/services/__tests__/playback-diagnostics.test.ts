import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PLAYBACK_DIAGNOSTIC_LIMIT,
  type PlaybackDiagnosticInput,
} from '@repo/schemas/playback-diagnostics'
import { PLAYBACK_DIAGNOSTIC_RETENTION_MS } from '@/services/playback-diagnostics'
import { createMemoryPlaybackSessions } from '@/services/playback-session-store'

function recordingAttempt(at: number): PlaybackDiagnosticInput {
  return {
    attemptId: randomUUID(),
    at,
    browser: 'android',
    stage: 'requested',
    source: 'similar-tracks',
  }
}

describe('Playback diagnostics storage', () => {
  it('isolates accounts and retains only the newest events', async () => {
    const now = 5000
    const sessions = createMemoryPlaybackSessions(() => now)
    const inputs = Array.from(
      { length: PLAYBACK_DIAGNOSTIC_LIMIT + 2 },
      (_, index) => recordingAttempt(index),
    )
    const other = recordingAttempt(now)
    await Promise.all([
      ...inputs.map((input) =>
        sessions.appendDiagnostics('first-user', [input]),
      ),
      sessions.appendDiagnostics('other-user', [other]),
    ])
    const history = await sessions.readDiagnostics('first-user')
    expect(history.events).toEqual(
      inputs.slice(2).map((input) => ({ ...input, receivedAt: now })),
    )
    expect(await sessions.readDiagnostics('other-user')).toEqual({
      events: [{ ...other, receivedAt: now }],
    })
    expect(await sessions.readDiagnostics('third-user')).toEqual({ events: [] })
  })

  it('expires events by receipt time regardless of what the browser clock reported', async () => {
    let now = 5000
    const sessions = createMemoryPlaybackSessions(() => now)
    const first = recordingAttempt(now + PLAYBACK_DIAGNOSTIC_RETENTION_MS)
    await sessions.appendDiagnostics('first-user', [first])
    now += PLAYBACK_DIAGNOSTIC_RETENTION_MS - 1
    const second = recordingAttempt(1)
    await sessions.appendDiagnostics('first-user', [second])
    expect((await sessions.readDiagnostics('first-user')).events).toHaveLength(
      2,
    )
    now += 1
    expect((await sessions.readDiagnostics('first-user')).events).toEqual([
      { ...second, receivedAt: now - 1 },
    ])
    now += PLAYBACK_DIAGNOSTIC_RETENTION_MS
    expect(await sessions.readDiagnostics('first-user')).toEqual({ events: [] })
  })
})
