import type { PlaybackListen } from '@repo/schemas/playback'

/**
 * Works out which tracks a Sonos room played, for scrobbling. The room is
 * read every few seconds at best and not at all while no page is open, so a
 * play is credited from how far the room got between two reads. Time is the
 * limit: the tracks credited between two reads never add up to more than the
 * time that passed between them, which keeps a skipped track from counting.
 */

/** Where a room was when it was read: the track, how far into it, and when. */
export type Sighting = {
  uri: string
  /** The track's place among the tracks the room was given. */
  index: number
  positionMs: number
  at: number
}
/** A track that was played, and when it began. */
export type RoomPlay = { uri: string; startedAt: number }
type TrackLength = { uri: string; durationMs: number }

/** Last.fm takes no scrobble of a track this short. */
const MIN_TRACK_MS = 30_000
/** Hearing this much of a track counts, however long the track is. */
const FULL_LISTEN_MS = 4 * 60_000
/** How far a read's clock time may be off from the position it carries. */
const READ_TOLERANCE_MS = 2_000
/** A reported track found this near its start again is being played again. */
const REPLAY_WITHIN_MS = 5_000

/**
 * How much of a track has to be heard for a scrobble: half of it, or four
 * minutes. Null for a track too short to scrobble or of unknown length.
 */
export function listenThreshold(durationMs: number): number | null {
  return durationMs > MIN_TRACK_MS
    ? Math.min(durationMs / 2, FULL_LISTEN_MS)
    : null
}

function heardEnough(heardMs: number, durationMs: number) {
  const threshold = listenThreshold(durationMs)
  return threshold !== null && heardMs >= threshold
}

/** Whether a listen has reached a scrobble that was not reported yet. */
export function listenDue(listen: PlaybackListen): boolean {
  return !listen.reported && heardEnough(listen.heardMs, listen.durationMs)
}

function clamp(value: number, max: number) {
  return Math.max(0, Math.min(value, max))
}

/**
 * Credits the track a room is on with what was heard since the last read.
 * `since` is when the track was asked for, for a room not read before.
 * When the room has moved to another track, `earlier` carries the listen it
 * left and the time not used up by the new track, for `earlierPlays`.
 */
export function hearRoom(
  listen: PlaybackListen | null,
  before: Sighting | null,
  after: Sighting & { durationMs: number },
  since: number,
): {
  listen: PlaybackListen
  earlier: { listen: PlaybackListen | null; budgetMs: number } | null
} {
  const budget =
    Math.max(0, after.at - (before?.at ?? since)) + READ_TOLERANCE_MS
  const sameTrack =
    before !== null && before.uri === after.uri && before.index === after.index
  const progress = before
    ? clamp(after.positionMs - before.positionMs, budget)
    : 0
  const replayed =
    sameTrack &&
    listen?.reported === true &&
    before.positionMs > REPLAY_WITHIN_MS &&
    after.positionMs <= REPLAY_WITHIN_MS
  if (listen && listen.uri === after.uri && (sameTrack || !before) && !replayed)
    return {
      listen: {
        ...listen,
        heardMs: listen.heardMs + progress,
        durationMs: after.durationMs || listen.durationMs,
      },
      earlier: null,
    }
  // The track's start is credited only when the room got there by itself.
  const heardMs = sameTrack
    ? replayed
      ? clamp(after.positionMs, budget)
      : progress
    : clamp(after.positionMs, budget)
  return {
    listen: {
      uri: after.uri,
      startedAt: after.at - after.positionMs,
      heardMs,
      durationMs: after.durationMs,
      reported: false,
    },
    earlier:
      before && !sameTrack
        ? {
            listen: listen?.uri === before.uri ? listen : null,
            budgetMs: budget - heardMs,
          }
        : null,
  }
}

/**
 * The plays a room got through between two reads, before the track it is on
 * now: the track it was on at the earlier read, then the tracks `passed` on
 * the way. The time between the reads is handed out from the latest track
 * back, each track taking no more than its own length.
 */
export function earlierPlays(input: {
  /** The listen of the track at `before`; null when it was not counted. */
  listen: PlaybackListen | null
  before: Sighting
  beforeDurationMs: number
  passed: readonly TrackLength[]
  budgetMs: number
  /** When the track the room is on now began. */
  until: number
}): RoomPlay[] {
  const plays: RoomPlay[] = []
  let budget = Math.max(0, input.budgetMs)
  let startedAt = input.until
  for (const track of [...input.passed].reverse()) {
    const heardMs = Math.min(track.durationMs, budget)
    budget -= heardMs
    startedAt -= track.durationMs
    if (heardEnough(heardMs, track.durationMs))
      plays.unshift({ uri: track.uri, startedAt })
  }
  const { listen, before, beforeDurationMs } = input
  const rest = clamp(beforeDurationMs - before.positionMs, budget)
  if (
    !listen?.reported &&
    heardEnough((listen?.heardMs ?? 0) + rest, beforeDurationMs)
  )
    plays.unshift({
      uri: before.uri,
      startedAt: listen?.startedAt ?? before.at - before.positionMs,
    })
  return plays
}

/**
 * The plays of a room that played everything it was given and stopped: the
 * track it was on when last read, then the `rest` of its tracks. The time
 * since that read is handed out from that track on.
 */
export function finishedPlays(input: {
  listen: PlaybackListen | null
  before: Sighting
  beforeDurationMs: number
  rest: readonly TrackLength[]
  budgetMs: number
}): RoomPlay[] {
  const { listen, before, beforeDurationMs } = input
  const plays: RoomPlay[] = []
  let budget = Math.max(0, input.budgetMs)
  const left = Math.max(0, beforeDurationMs - before.positionMs)
  if (
    !listen?.reported &&
    heardEnough(
      (listen?.heardMs ?? 0) + Math.min(left, budget),
      beforeDurationMs,
    )
  )
    plays.push({
      uri: before.uri,
      startedAt: listen?.startedAt ?? before.at - before.positionMs,
    })
  budget = Math.max(0, budget - left)
  let startedAt = before.at + left
  for (const track of input.rest) {
    if (heardEnough(Math.min(track.durationMs, budget), track.durationMs))
      plays.push({ uri: track.uri, startedAt })
    budget = Math.max(0, budget - track.durationMs)
    startedAt += track.durationMs
  }
  return plays
}
