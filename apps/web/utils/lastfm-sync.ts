import type { z } from 'zod'
import {
  LastfmLinkQuerySchema,
  LastfmLinkReasonSchema,
  type LastfmLinkGroup,
  type LastfmLinkReason,
  type LastfmLinkReport,
  type LastfmLinkStrategy,
  type LastfmSyncSchedule,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'

/** How often the page re-reads status while a sync job is queued or running. */
export const LASTFM_SYNC_POLL_MS = 3000

export const LASTFM_LINKS_PAGE_SIZE = 100

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
  '10m': 'Every 10 minutes',
  '30m': 'Every 30 minutes',
  '1h': 'Every hour',
  '3h': 'Every 3 hours',
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

export type LastfmLinkSort = z.infer<typeof LastfmLinkQuerySchema>['sortBy']
export type LastfmLinkSortDirection = z.infer<
  typeof LastfmLinkQuerySchema
>['sortDirection']

export const lastfmLinkColumns: Array<{
  key: LastfmLinkSort
  label: string
}> = [
  { key: 'artistName', label: 'Scrobbled artist' },
  { key: 'albumName', label: 'Scrobbled album' },
  { key: 'scrobbles', label: 'Scrobbles' },
  { key: 'lastListenedAt', label: 'Last listened' },
  { key: 'reason', label: 'Status' },
  { key: 'libraryAlbum', label: 'Library album' },
  { key: 'spotifySearch', label: 'Spotify search' },
]

export function lastfmLinkSort(value: string | null): LastfmLinkSort {
  const parsed = LastfmLinkQuerySchema.shape.sortBy.safeParse(
    value ?? undefined,
  )
  return parsed.success ? parsed.data : 'scrobbles'
}

export function lastfmLinkSortDirection(
  value: string | null,
): LastfmLinkSortDirection {
  const parsed = LastfmLinkQuerySchema.shape.sortDirection.safeParse(
    value ?? undefined,
  )
  return parsed.success ? parsed.data : 'desc'
}

/** Stable identity across sorting, polling and link changes. */
export function lastfmLinkKey(
  group: Pick<LastfmLinkGroup, 'artistName' | 'albumName'>,
) {
  return JSON.stringify([group.artistName, group.albumName])
}

export function canSearchLastfmGroup(group: LastfmLinkGroup) {
  return (
    group.albumName !== null &&
    group.reason !== 'linked' &&
    group.reason !== 'manual'
  )
}

export function lastfmSpotifySearchLabel(
  search: LastfmLinkGroup['spotifySearch'],
) {
  if (!search) return 'Not searched'
  if (search.status === 'succeeded') {
    if (search.resultCount === null) return 'No stored results'
    const count = search.resultCount
    return count === 1 ? '1 match' : `${count} matches`
  }
  const labels = {
    queued: 'Queued',
    running: 'Searching...',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }
  return labels[search.status]
}

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
  sortBy,
  sortDirection,
}: {
  reason: LastfmLinkFilter | ''
  q: string
  page: number
  size?: number
  sortBy?: LastfmLinkSort
  sortDirection?: LastfmLinkSortDirection
}) {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
  })
  if (reason) params.set('reason', reason)
  if (q) params.set('q', q)
  if (sortBy) params.set('sortBy', sortBy)
  if (sortDirection) params.set('sortDirection', sortDirection)
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
