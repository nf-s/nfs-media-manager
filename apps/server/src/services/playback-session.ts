import { z } from 'zod'
import {
  PLAYBACK_LEASE_MS,
  PlaybackClientSchema,
  SavedPlaybackSchema,
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

/** The shared session as stored for one signed-in user. */
export const PlaybackSessionRecordSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    state: SavedPlaybackSchema.nullable(),
    driver: PlaybackDriverSchema.nullable(),
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

export function syncPlaybackSession(
  stored: PlaybackSessionRecord,
  input: PlaybackSyncInput,
  now: number,
): { stored: PlaybackSessionRecord; result: PlaybackSyncResult } {
  const live = liveDriver(stored, now)
  const holds = input.claim || !live || live.clientId === input.clientId
  const driver: PlaybackDriver =
    !holds && live
      ? live
      : {
          clientId: input.clientId,
          name: input.clientName,
          expiresAt: now + PLAYBACK_LEASE_MS,
        }
  const role = holds ? 'driver' : 'follower'
  const client = { clientId: driver.clientId, name: driver.name }

  if (
    holds &&
    input.state !== undefined &&
    input.revision === stored.revision
  ) {
    const revision = stored.revision + 1
    return {
      stored: { revision, state: input.state, driver },
      result: { revision, role, driver: client, changed: false, state: null },
    }
  }

  const changed = input.revision !== stored.revision
  return {
    stored: { ...stored, driver },
    result: {
      revision: stored.revision,
      role,
      driver: client,
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
  const next: PlaybackSessionRecord =
    input.state !== undefined && input.revision === stored.revision
      ? { revision: stored.revision + 1, state: input.state, driver: null }
      : { ...stored, driver: null }
  return {
    stored: next,
    result: { released: true, revision: next.revision },
  }
}
