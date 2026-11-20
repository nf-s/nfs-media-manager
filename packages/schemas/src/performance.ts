import { z } from 'zod'

export const BrowserBrowseTimingSchema = z.strictObject({
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
  durationMs: z.number().int().min(0).max(300_000),
})

export type BrowserBrowseTiming = z.infer<typeof BrowserBrowseTimingSchema>
