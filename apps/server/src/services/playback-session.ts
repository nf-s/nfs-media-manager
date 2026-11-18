import { z } from 'zod'
import {
  PLAYBACK_LEASE_MS,
  PlaybackClientIdSchema,
  PlaybackClientSchema,
  SavedPlaybackSchema,
  SharedSonosObservationSchema,
  SharedSonosRoomsStateSchema,
  type PlaybackReleaseInput,
  type PlaybackReleaseResultSchema,
  type PlaybackSyncInput,
  type PlaybackSyncResult,
} from '@repo/schemas/playback'

export type PlaybackReleaseResult = z.infer<typeof PlaybackReleaseResultSchema>

export const PlaybackDriverSchema = PlaybackClientSchema.extend({
  expiresAt: z.number().int().nonnegative(),
}).strict()
export type PlaybackDriver = z.infer<typeof PlaybackDriverSchema>

export const PlaybackSessionSonosSchema = z.object({
  managed: z.boolean(),
  clientId: PlaybackClientIdSchema.nullable(),
  observed: z
    .object({
      at: z.number().int().nonnegative(),
      value: SharedSonosObservationSchema,
    })
    .nullable(),
  rooms: SharedSonosRoomsStateSchema,
})
type PlaybackSessionSonos = z.infer<typeof PlaybackSessionSonosSchema>

const EMPTY_SONOS: PlaybackSessionSonos = {
  managed: false,
  clientId: null,
  observed: null,
  rooms: { requested: 0, completed: null },
}

/** The shared session as stored for one signed-in user. */
export const PlaybackSessionRecordSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    state: SavedPlaybackSchema.nullable(),
    driver: PlaybackDriverSchema.nullable(),
    sonos: PlaybackSessionSonosSchema.optional(),
  })
  .strict()
export type PlaybackSessionRecord = z.infer<typeof PlaybackSessionRecordSchema>

export const EMPTY_PLAYBACK_SESSION: PlaybackSessionRecord = {
  revision: 0,
  state: null,
  driver: null,
}

function liveDriver(stored: PlaybackSessionRecord, now: number) {
  return stored.driver && stored.driver.expiresAt > now ? stored.driver : null
}

/** Checks eligibility without taking or renewing the playback lease. */
export function canDispatchSonos(
  stored: PlaybackSessionRecord,
  clientId: string | null,
  now: number,
) {
  return (
    clientId !== null &&
    stored.sonos?.managed === true &&
    stored.sonos.clientId === clientId &&
    liveDriver(stored, now)?.clientId === clientId
  )
}

function syncSonos(
  stored: PlaybackSessionRecord,
  input: PlaybackSyncInput,
  holds: boolean,
  now: number,
): PlaybackSessionSonos | undefined {
  if (!stored.sonos && !input.sonosManaged) return undefined
  const before = stored.sonos ?? EMPTY_SONOS
  const managesSonos = holds && input.sonosManaged === true
  const managed = before.managed || managesSonos
  const clientId = holds
    ? managesSonos
      ? input.clientId
      : null
    : before.clientId
  const canPublish =
    managesSonos && liveDriver(stored, now)?.clientId === input.clientId
  let observed =
    before.observed &&
    before.observed.at + PLAYBACK_LEASE_MS > now &&
    !(holds && !managesSonos)
      ? before.observed
      : null
  if (canPublish) {
    const value =
      input.sonosObservation === undefined
        ? observed?.value
        : input.sonosObservation
    observed = value ? { at: now, value } : null
  }

  let rooms = before.rooms
  const completedId = rooms.completed?.id ?? 0
  const pending = rooms.requested > completedId
  if (pending) {
    const report = input.sonosRoomsReport
    if (canPublish && report?.id === rooms.requested)
      rooms = { ...rooms, completed: report }
  } else if (input.sonosManaged && input.sonosRoomsRequest === completedId) {
    rooms = { ...rooms, requested: rooms.requested + 1 }
  }

  return managed === before.managed &&
    clientId === before.clientId &&
    observed === before.observed &&
    rooms === before.rooms
    ? stored.sonos
    : { managed, clientId, observed, rooms }
}

export function syncPlaybackSession(
  stored: PlaybackSessionRecord,
  input: PlaybackSyncInput,
  now: number,
): { stored: PlaybackSessionRecord; result: PlaybackSyncResult } {
  const live = liveDriver(stored, now)
  const upgrade =
    input.sonosManaged === true && stored.sonos?.clientId !== live?.clientId
  const holds =
    input.claim || !live || live.clientId === input.clientId || upgrade
  const driver: PlaybackDriver =
    !holds && live
      ? live
      : {
          clientId: input.clientId,
          name: input.clientName,
          expiresAt: now + PLAYBACK_LEASE_MS,
        }
  const role: PlaybackSyncResult['role'] = holds ? 'driver' : 'follower'
  const client = { clientId: driver.clientId, name: driver.name }
  const sonos = syncSonos(stored, input, holds, now)
  const rooms = sonos?.rooms ?? EMPTY_SONOS.rooms
  const completion = rooms.completed?.id ?? 0
  const sendRooms =
    input.sonosRoomsSeen !== completion ||
    rooms.requested > completion ||
    input.sonosRoomsRequest !== undefined ||
    input.sonosRoomsReport !== undefined
  const sharedSonos = input.sonosManaged
    ? {
        sonosObservation: sonos?.observed?.value ?? null,
        ...(sendRooms ? { sonosRooms: rooms } : {}),
      }
    : {}
  const baseResult = {
    role,
    driver: client,
    sonosManaged: sonos?.managed ?? false,
    ...sharedSonos,
  }
  const next = { ...stored, driver, ...(sonos ? { sonos } : {}) }

  if (
    holds &&
    input.state !== undefined &&
    input.revision === stored.revision
  ) {
    const revision = stored.revision + 1
    return {
      stored: { ...next, revision, state: input.state },
      result: { ...baseResult, revision, changed: false, state: null },
    }
  }

  const changed = input.revision !== stored.revision
  return {
    stored: next,
    result: {
      ...baseResult,
      revision: stored.revision,
      changed,
      state: changed ? stored.state : null,
    },
  }
}

export function releasePlaybackSession(
  stored: PlaybackSessionRecord,
  input: PlaybackReleaseInput,
  now: number,
): { stored: PlaybackSessionRecord; result: PlaybackReleaseResult } {
  if (liveDriver(stored, now)?.clientId !== input.clientId)
    return {
      stored,
      result: { released: false, revision: stored.revision },
    }
  const released = {
    ...stored,
    driver: null,
    ...(stored.sonos?.clientId === input.clientId
      ? { sonos: { ...stored.sonos, clientId: null } }
      : {}),
  }
  const next: PlaybackSessionRecord =
    input.state !== undefined && input.revision === stored.revision
      ? { ...released, revision: stored.revision + 1, state: input.state }
      : released
  return {
    stored: next,
    result: { released: true, revision: next.revision },
  }
}
