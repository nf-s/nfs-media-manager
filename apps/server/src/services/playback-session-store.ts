import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  PlaybackReleaseInput,
  PlaybackSyncInput,
  PlaybackSyncResult,
} from '@repo/schemas/playback'
import type {
  PlaybackDiagnostic,
  PlaybackDiagnosticInput,
  PlaybackDiagnosticsAppendInput,
  PlaybackDiagnosticsResult,
} from '@repo/schemas/playback-diagnostics'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import { updatePlaybackDiagnostics } from './playback-diagnostics'
import {
  canDispatchSonos,
  EMPTY_PLAYBACK_SESSION,
  releasePlaybackSession,
  syncPlaybackSession,
  type PlaybackReleaseResult,
  type PlaybackSessionRecord,
} from './playback-session'

/** Keeps one shared playback session per signed-in user. */
export interface PlaybackSessions {
  sync(userId: string, input: PlaybackSyncInput): Promise<PlaybackSyncResult>
  canDispatchSonos(userId: string, clientId: string | null): Promise<boolean>
  release(
    userId: string,
    input: PlaybackReleaseInput,
  ): Promise<PlaybackReleaseResult>
  appendDiagnostics(
    userId: string,
    input: PlaybackDiagnosticInput[],
  ): Promise<void>
  readDiagnostics(userId: string): Promise<PlaybackDiagnosticsResult>
}

/** Sessions held in this process; for the Node runtime and tests. */
export function createMemoryPlaybackSessions(
  now: () => number = Date.now,
): PlaybackSessions {
  const records = new Map<string, PlaybackSessionRecord>()
  const diagnostics = new Map<string, PlaybackDiagnostic[]>()
  return {
    async canDispatchSonos(userId, clientId) {
      return canDispatchSonos(
        records.get(userId) ?? EMPTY_PLAYBACK_SESSION,
        clientId,
        now(),
      )
    },
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
    async appendDiagnostics(userId, input) {
      const { events } = updatePlaybackDiagnostics(
        diagnostics.get(userId) ?? [],
        now(),
        input,
      )
      diagnostics.set(userId, events)
    },
    async readDiagnostics(userId) {
      const { events } = updatePlaybackDiagnostics(
        diagnostics.get(userId) ?? [],
        now(),
        [],
      )
      if (events.length) diagnostics.set(userId, events)
      else diagnostics.delete(userId)
      return { events }
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

export function canUserDispatchSonos(userId: string, clientId: string | null) {
  return playbackSessions().canDispatchSonos(userId, clientId)
}

export function releaseUserPlayback(
  userId: string,
  input: PlaybackReleaseInput,
) {
  return playbackSessions().release(userId, input)
}

export function appendUserPlaybackDiagnostics(
  userId: string,
  input: PlaybackDiagnosticsAppendInput,
) {
  return playbackSessions().appendDiagnostics(
    userId,
    'events' in input ? input.events : [input],
  )
}

export function readUserPlaybackDiagnostics(userId: string) {
  return playbackSessions().readDiagnostics(userId)
}
