import { z } from 'zod'
import { spotifyIdPattern } from './playback'

export const PLAYBACK_DIAGNOSTIC_LIMIT = 500

const TimestampSchema = z.number().int().nonnegative()
const CountSchema = z.number().int().min(0).max(1_000_000)

export const PlaybackDiagnosticInputSchema = z
  .object({
    attemptId: z.uuidv4(),
    eventId: z.uuidv4().optional(),
    at: TimestampSchema.optional(),
    browser: z.enum(['android', 'ios', 'desktop', 'other']),
    stage: z.enum([
      'requested',
      'sdk',
      'activation',
      'device',
      'command',
      'started',
      'failed',
      'advance',
      'ended',
    ]),
    action: z
      .enum([
        'play',
        'toggle',
        'next',
        'previous',
        'device',
        'play-queue',
        'play-upcoming',
        'enqueue',
      ])
      .optional(),
    target: z.enum(['local', 'spotify', 'sonos']).optional(),
    source: z
      .enum(['none', 'similar-tracks', 'browse', 'playlist', 'album', 'other'])
      .optional(),
    spotifyTrackId: z.string().regex(spotifyIdPattern).optional(),
    sourceItemId: z
      .uuid()
      .or(z.string().regex(/^(?:library-)?track_[0-9a-f]{20}$/))
      .optional(),
    sourceIndex: CountSchema.optional(),
    queued: CountSchema.optional(),
    upcoming: CountSchema.optional(),
    reason: z
      .enum([
        'manual',
        'automatic',
        'no-device',
        'not-ready',
        'activation-failed',
        'command-failed',
        'start-timeout',
        'restricted',
        'unavailable',
        'superseded',
        'no-next-track',
        'disconnected',
        'unsupported',
        'sdk-error',
        'other',
        'ready',
        'connecting',
        'pending',
        'accepted',
        'ignored',
        'queue',
        'source',
        'observed',
        'autoplay-blocked',
        'authentication-error',
        'account-error',
        'initialization-error',
        'playback-error',
        'load-failed',
        'lease-denied',
        'paused',
      ])
      .optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict()

export const PlaybackDiagnosticSchema = PlaybackDiagnosticInputSchema.extend({
  receivedAt: TimestampSchema,
})

export const PlaybackDiagnosticsAppendSchema = z.union([
  PlaybackDiagnosticInputSchema,
  z
    .object({
      events: z.array(PlaybackDiagnosticInputSchema).min(1).max(32),
    })
    .strict(),
])

export const PlaybackDiagnosticsResultSchema = z
  .object({
    events: z.array(PlaybackDiagnosticSchema).max(PLAYBACK_DIAGNOSTIC_LIMIT),
  })
  .strict()

export type PlaybackDiagnosticInput = z.infer<
  typeof PlaybackDiagnosticInputSchema
>
export type PlaybackDiagnostic = z.infer<typeof PlaybackDiagnosticSchema>
export type PlaybackDiagnosticsAppendInput = z.infer<
  typeof PlaybackDiagnosticsAppendSchema
>
export type PlaybackDiagnosticsResult = z.infer<
  typeof PlaybackDiagnosticsResultSchema
>
