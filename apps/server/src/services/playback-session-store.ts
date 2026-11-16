import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  PlaybackReleaseInput,
  PlaybackSyncInput,
  PlaybackSyncResult,
} from '@repo/schemas/playback'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import {
  EMPTY_PLAYBACK_SESSION,
  releasePlaybackSession,
  syncPlaybackSession,
  type PlaybackReleaseResult,
  type PlaybackSessionRecord,
} from './playback-session'

/** Keeps one shared playback session per signed-in user. */
export interface PlaybackSessions {
  sync(userId: string, input: PlaybackSyncInput): Promise<PlaybackSyncResult>
  release(
    userId: string,
    input: PlaybackReleaseInput,
  ): Promise<PlaybackReleaseResult>
}

/** Sessions held in this process; for the Node runtime and tests. */
export function createMemoryPlaybackSessions(
  now: () => number = Date.now,
): PlaybackSessions {
  const records = new Map<string, PlaybackSessionRecord>()
  return {
    async sync(userId, input) {
      const next = syncPlaybackSession(
        records.get(userId) ?? EMPTY_PLAYBACK_SESSION,
        input,
        now(),
      )
      records.set(userId, next.stored)
      return next.result
    },
    async release(userId, input) {
      const next = releasePlaybackSession(
        records.get(userId) ?? EMPTY_PLAYBACK_SESSION,
        input,
        now(),
      )
      records.set(userId, next.stored)
      return next.result
    },
  }
}

const runtimeSessions = new AsyncLocalStorage<PlaybackSessions>()
const memorySessions = createMemoryPlaybackSessions()

export function withPlaybackSessions<T>(
  sessions: PlaybackSessions,
  execute: () => T,
): T {
  return runtimeSessions.run(sessions, execute)
}

function playbackSessions(): PlaybackSessions {
  const sessions = runtimeSessions.getStore()
  if (sessions) return sessions
  if (env.RUNTIME_KIND === 'cloudflare')
    throw new ServerError({
      statusCode: 503,
      message: 'Playback sessions unavailable',
    })
  return memorySessions
}

export function syncUserPlayback(userId: string, input: PlaybackSyncInput) {
  return playbackSessions().sync(userId, input)
}

export function releaseUserPlayback(
  userId: string,
  input: PlaybackReleaseInput,
) {
  return playbackSessions().release(userId, input)
}
