import { z } from 'zod'

export const slowTracksChangeMs = 1_000
const durationMs = z.number().int().min(0).max(300_000)
const rowPhases = { commitMs: durationMs, paintMs: durationMs }
const tracksChangePhases = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('cache'), ...rowPhases }),
  z.strictObject({
    source: z.literal('request'),
    waitMs: durationMs,
    loadMs: durationMs,
    ...rowPhases,
  }),
])

export const BrowserBrowseTimingSchema = z
  .strictObject({
    screen: z.enum([
      'tracks',
      'albums',
      'artists',
      'films',
      'playlists',
      'collections',
      'subscriptions',
    ]),
    action: z.enum(['document', 'open', 'change', 'page', 'detail']),
    outcome: z.enum(['rows', 'empty', 'error']),
    durationMs,
    phases: tracksChangePhases.optional(),
  })
  .refine(
    ({ phases, screen, action, outcome, durationMs }) => {
      if (!phases) return true
      const requestMs =
        phases.source === 'request' ? phases.waitMs + phases.loadMs : 0
      return (
        screen === 'tracks' &&
        action === 'change' &&
        outcome === 'rows' &&
        durationMs >= slowTracksChangeMs &&
        requestMs + phases.commitMs + phases.paintMs === durationMs
      )
    },
    {
      path: ['phases'],
      message: 'Phases must account for a slow Tracks filter change',
    },
  )

export type BrowserBrowseTiming = z.infer<typeof BrowserBrowseTimingSchema>
