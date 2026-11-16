import { describe, expect, it } from 'vitest'
import {
  PLAYBACK_LEASE_MS,
  SavedPlaybackSchema,
  type PlaybackSyncInput,
  type SavedPlayback,
} from '@repo/schemas/playback'
import {
  EMPTY_PLAYBACK_SESSION,
  PlaybackSessionRecordSchema,
  releasePlaybackSession,
  syncPlaybackSession,
  type PlaybackSessionRecord,
} from '@/services/playback-session'
import { createMemoryPlaybackSessions } from '@/services/playback-session-store'

const first = 'client-aaaaaaaa'
const second = 'client-bbbbbbbb'

function savedPlayback(title: string): SavedPlayback {
  return SavedPlaybackSchema.parse({
    version: 1,
    savedAt: 1000,
    queue: [],
    sequence: 0,
    current: {
      kind: 'track',
      uri: 'spotify:track:fixture',
      title,
      artist: 'Example Artist',
      albumId: null,
      albumTitle: 'Example Album',
      artworkUrl: null,
      trackCount: null,
    },
    currentFromSource: false,
    session: null,
    snapshot: null,
    shuffle: false,
    target: { kind: 'spotify', device: null, browser: null },
    source: null,
  })
}

function input(
  clientId: string,
  overrides: Partial<PlaybackSyncInput> = {},
): PlaybackSyncInput {
  return {
    clientId,
    clientName: clientId === first ? 'Laptop' : 'Phone',
    revision: 0,
    claim: false,
    ...overrides,
  }
}

function held(clientId: string, expiresAt: number, revision = 3) {
  const state = savedPlayback('Stored')
  return {
    revision,
    state,
    driver: {
      clientId,
      name: clientId === first ? 'Laptop' : 'Phone',
      expiresAt,
    },
  } satisfies PlaybackSessionRecord
}

describe('syncPlaybackSession', () => {
  it('gives a free lease to the first client', () => {
    const { stored, result } = syncPlaybackSession(
      EMPTY_PLAYBACK_SESSION,
      input(first),
      1000,
    )
    expect(result).toEqual({
      revision: 0,
      role: 'driver',
      driver: { clientId: first, name: 'Laptop' },
      changed: false,
      state: null,
    })
    expect(stored.driver).toEqual({
      clientId: first,
      name: 'Laptop',
      expiresAt: 1000 + PLAYBACK_LEASE_MS,
    })
    expect(PlaybackSessionRecordSchema.parse(stored)).toEqual(stored)
  })

  it('renews the lease for the client holding it', () => {
    const { stored, result } = syncPlaybackSession(
      held(first, 5000),
      input(first, { revision: 3, clientName: 'Renamed laptop' }),
      4000,
    )
    expect(result.role).toBe('driver')
    expect(stored.driver).toEqual({
      clientId: first,
      name: 'Renamed laptop',
      expiresAt: 4000 + PLAYBACK_LEASE_MS,
    })
  })

  it('keeps another client as a follower while the lease is live', () => {
    const before = held(first, 5000)
    const { stored, result } = syncPlaybackSession(
      before,
      input(second, { revision: 3, state: savedPlayback('Ignored') }),
      4000,
    )
    expect(result).toEqual({
      revision: 3,
      role: 'follower',
      driver: { clientId: first, name: 'Laptop' },
      changed: false,
      state: null,
    })
    expect(stored).toEqual(before)
  })

  it('returns the stored state to a follower with an older revision', () => {
    const before = held(first, 5000)
    const { result } = syncPlaybackSession(before, input(second), 4000)
    expect(result).toMatchObject({
      role: 'follower',
      revision: 3,
      changed: true,
      state: before.state,
    })
  })

  it('lets a claim take a live lease', () => {
    const { stored, result } = syncPlaybackSession(
      held(first, 5000),
      input(second, { revision: 3, claim: true }),
      4000,
    )
    expect(result.role).toBe('driver')
    expect(result.driver).toEqual({ clientId: second, name: 'Phone' })
    expect(stored.driver?.clientId).toBe(second)
  })

  it('gives an expired lease to another client', () => {
    const { result } = syncPlaybackSession(
      held(first, 5000),
      input(second, { revision: 3 }),
      5000,
    )
    expect(result.role).toBe('driver')
    expect(result.driver).toEqual({ clientId: second, name: 'Phone' })
  })

  it('saves the driver state at the current revision', () => {
    const state = savedPlayback('New')
    const { stored, result } = syncPlaybackSession(
      held(first, 5000),
      input(first, { revision: 3, state }),
      4000,
    )
    expect(stored.revision).toBe(4)
    expect(stored.state).toEqual(state)
    expect(result).toMatchObject({
      revision: 4,
      role: 'driver',
      changed: false,
      state: null,
    })
  })

  it('rejects a stale write and returns the current state', () => {
    const before = held(first, 5000)
    const { stored, result } = syncPlaybackSession(
      before,
      input(first, { revision: 2, state: savedPlayback('Stale') }),
      4000,
    )
    expect(stored.revision).toBe(3)
    expect(stored.state).toEqual(before.state)
    expect(result).toMatchObject({
      revision: 3,
      role: 'driver',
      changed: true,
      state: before.state,
    })
  })

  it('clears the state when the driver saves null', () => {
    const { stored, result } = syncPlaybackSession(
      held(first, 5000),
      input(first, { revision: 3, state: null }),
      4000,
    )
    expect(stored).toMatchObject({ revision: 4, state: null })
    expect(result.revision).toBe(4)
  })
})

describe('releasePlaybackSession', () => {
  it('drops the lease and saves the final state for the holder', () => {
    const state = savedPlayback('Final')
    const { stored, result } = releasePlaybackSession(
      held(first, 5000),
      { clientId: first, revision: 3, state },
      4000,
    )
    expect(result).toEqual({ released: true, revision: 4 })
    expect(stored).toEqual({ revision: 4, state, driver: null })
  })

  it('drops the lease without writing a stale state', () => {
    const before = held(first, 5000)
    const { stored, result } = releasePlaybackSession(
      before,
      { clientId: first, revision: 2, state: savedPlayback('Stale') },
      4000,
    )
    expect(result).toEqual({ released: true, revision: 3 })
    expect(stored).toEqual({ ...before, driver: null })
  })

  it('changes nothing for a client not holding the lease', () => {
    const before = held(first, 5000)
    expect(
      releasePlaybackSession(
        before,
        { clientId: second, revision: 3, state: null },
        4000,
      ),
    ).toEqual({ stored: before, result: { released: false, revision: 3 } })
  })

  it('changes nothing once the lease has expired', () => {
    const before = held(first, 5000)
    expect(
      releasePlaybackSession(before, { clientId: first, revision: 3 }, 5000),
    ).toEqual({ stored: before, result: { released: false, revision: 3 } })
  })
})

describe('createMemoryPlaybackSessions', () => {
  it('keeps one session per user', async () => {
    let now = 1000
    const sessions = createMemoryPlaybackSessions(() => now)
    const state = savedPlayback('Saved')
    expect(
      await sessions.sync('user-1', input(first, { state })),
    ).toMatchObject({ revision: 1, role: 'driver' })
    expect(await sessions.sync('user-2', input(second))).toMatchObject({
      revision: 0,
      role: 'driver',
      changed: false,
    })
    now = 2000
    expect(await sessions.sync('user-1', input(second))).toMatchObject({
      revision: 1,
      role: 'follower',
      changed: true,
      state,
    })
  })
})
