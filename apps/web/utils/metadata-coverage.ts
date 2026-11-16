import {
  COVERAGE_ITEM_ID_LIMIT,
  type CoverageGap,
  type CoverageUnavailableReason,
  type ProviderCoverage,
} from '@repo/schemas/coverage'
import { QueueAlbumSelectionSchema } from '@repo/schemas/album-selection'

export type MetadataCoverageKind = 'playlist' | 'artist'
export type { CoverageGap }

/** Above this many jobs the album queue needs `confirmBroadRun`. */
export const BROAD_RUN_JOBS = 5

const resources: Record<MetadataCoverageKind, string> = {
  playlist: 'playlists',
  artist: 'artists',
}

export function coveragePath(kind: MetadataCoverageKind, id: string) {
  return `/api/v1/${resources[kind]}/${encodeURIComponent(id)}/coverage`
}

/** Starts with the item's own key, like its other detail queries. */
export function coverageKey(kind: MetadataCoverageKind, id: string) {
  return [kind, id, 'coverage']
}

export const coverageUnavailableLabels: Record<
  CoverageUnavailableReason,
  string
> = {
  'credentials-missing': 'Credentials required',
  halted: 'Provider halted',
}

/** The album IDs one queue request sends for a gap, at most 100. */
export function coverageGapIds(provider: ProviderCoverage, gap: CoverageGap) {
  return (
    gap === 'missing' ? provider.missingItemIds : provider.staleItemIds
  ).slice(0, COVERAGE_ITEM_ID_LIMIT)
}

/**
 * The reviewed album queue request for one provider's gap. Missing albums
 * are those never scraped; stale ones were scraped before `olderThanDays`.
 * The queue rechecks freshness, so albums fetched since are skipped.
 */
export function coverageQueueRequest({
  provider,
  gap,
  ids,
  olderThanDays,
  confirmed,
  batchId,
}: {
  provider: string
  gap: CoverageGap
  ids: readonly string[]
  olderThanDays: number
  confirmed: boolean
  batchId: string
}) {
  const mediaItemIds = ids.slice(0, COVERAGE_ITEM_ID_LIMIT)
  return QueueAlbumSelectionSchema.parse({
    providers: [provider],
    mediaItemIds,
    freshness: [
      gap === 'missing'
        ? { provider, mode: 'unscraped' }
        : { provider, mode: 'older', olderThanDays },
    ],
    confirmBroadRun: confirmed && mediaItemIds.length > BROAD_RUN_JOBS,
    batchId,
  })
}
