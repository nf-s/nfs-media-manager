import { z } from 'zod'

export const slowTracksChangeMs = 1_000
export const slowBrowseDocumentMs = 2_500
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
const documentPhases = z.strictObject({
  firstByteMs: durationMs,
  beforePageRequestMs: durationMs,
  pageLoadMs: durationMs,
  ...rowPhases,
  firstContentfulPaintMs: durationMs.optional(),
})

export const BrowserBrowseTimingSchema = z
  .strictObject({
    screen: z.enum([
      'tracks',
      'albums',
      'album-ratings',
      'artists',
      'films',
      'film-ratings',
      'playlists',
      'collections',
      'subscriptions',
    ]),
    action: z.enum(['document', 'open', 'change', 'page', 'detail']),
    outcome: z.enum(['rows', 'empty', 'error']),
    durationMs,
    phases: tracksChangePhases.optional(),
    documentPhases: documentPhases.optional(),
    /** Where the visible page's rows came from: the device store in the browser or the API. */
    rowSource: z.enum(['device', 'api']).optional(),
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
  .refine(
    ({ documentPhases, action, outcome, durationMs }) => {
      if (!documentPhases) return true
      const {
        firstByteMs,
        beforePageRequestMs,
        pageLoadMs,
        commitMs,
        paintMs,
        firstContentfulPaintMs,
      } = documentPhases
      return (
        action === 'document' &&
        outcome === 'rows' &&
        durationMs >= slowBrowseDocumentMs &&
        firstByteMs + beforePageRequestMs + pageLoadMs + commitMs + paintMs ===
          durationMs &&
        (firstContentfulPaintMs === undefined ||
          (firstContentfulPaintMs >= firstByteMs &&
            firstContentfulPaintMs <= durationMs))
      )
    },
    {
      path: ['documentPhases'],
      message:
        'Document phases must account for a slow document load with rows',
    },
  )

export type BrowserBrowseTiming = z.infer<typeof BrowserBrowseTimingSchema>
