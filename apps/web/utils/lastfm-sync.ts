import type { z } from 'zod'
import {
  LastfmLinkQuerySchema,
  LastfmLinkReasonSchema,
  type LastfmLinkReason,
  type LastfmLinkReport,
  type LastfmLinkStrategy,
  type LastfmSyncSchedule,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'

/** How often the page re-reads status while a sync job is queued or running. */
export const LASTFM_SYNC_POLL_MS = 3000

export const LASTFM_LINKS_PAGE_SIZE = 50

export const lastfmSyncStateLabels: Record<LastfmSyncStatus['state'], string> =
  {
    never: 'Not synced',
    running: 'Running',
    stopped: 'Stopped',
    failed: 'Failed',
    complete: 'Complete',
  }

export const lastfmScheduleLabels: Record<LastfmSyncSchedule, string> = {
  off: 'Off',
  '6h': 'Every 6 hours',
  daily: 'Daily',
  weekly: 'Weekly',
}

export const lastfmLinkReasonLabels: Record<LastfmLinkReason, string> = {
  linked: 'Linked',
  manual: 'Linked manually',
  ambiguous: 'Several albums match',
  unmatched: 'No matching album',
  excluded: 'Kept unlinked',
  'no-album': 'Scrobbled without an album',
}

export const lastfmLinkStrategyLabels: Record<LastfmLinkStrategy, string> = {
  exact: 'Same title and artist',
  normalized: 'Same title and artist, ignoring punctuation',
  edition: 'Another edition or artist credit',
  'title-tracks': 'Same title and shared tracks',
  'title-prefix': 'Similar title and shared tracks',
  tracks: 'Same artist and shared tracks',
}

export type LastfmLinkFilter = NonNullable<
  z.infer<typeof LastfmLinkQuerySchema>['reason']
>

export const lastfmLinkFilters: Array<{
  value: LastfmLinkFilter | ''
  label: string
}> = [
  { value: '', label: 'All' },
  { value: 'unlinked', label: 'Unlinked' },
  ...LastfmLinkReasonSchema.options.map((reason) => ({
    value: reason,
    label: lastfmLinkReasonLabels[reason],
  })),
]

/** Reads the `reason` search parameter, ignoring unknown values. */
export function lastfmLinkFilter(value: string | null): LastfmLinkFilter | '' {
  const parsed = LastfmLinkQuerySchema.shape.reason.safeParse(
    value ?? undefined,
  )
  return parsed.success && parsed.data ? parsed.data : ''
}

export function lastfmLinksPath({
  reason,
  q,
  page,
  size = LASTFM_LINKS_PAGE_SIZE,
}: {
  reason: LastfmLinkFilter | ''
  q: string
  page: number
  size?: number
}) {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
  })
  if (reason) params.set('reason', reason)
  if (q) params.set('q', q)
  return `/api/v1/lastfm/links?${params}`
}

/** Library albums whose title or artist matches the search. */
export function albumPickerPath(q: string, size: number) {
  return `/api/v1/albums?${new URLSearchParams({ q, size: String(size) })}`
}

/** Every reason in display order, with zero totals for reasons the server omitted. */
export function lastfmLinkSummaryRows(summary: LastfmLinkReport['summary']) {
  return LastfmLinkReasonSchema.options.map(
    (reason) =>
      summary.find((row) => row.reason === reason) ?? {
        reason,
        groups: 0,
        scrobbles: 0,
      },
  )
}

export function lastfmSyncPollInterval(
  state: LastfmSyncStatus['state'] | null,
) {
  return state === 'running' ? LASTFM_SYNC_POLL_MS : false
}
