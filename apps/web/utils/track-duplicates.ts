import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import {
  TrackDuplicateCountSchema,
  TrackDuplicateLayoutSchema,
  TrackDuplicatesSchema,
  type TrackDuplicateGroup,
  type TrackDuplicateLayoutGroup,
  type TrackDuplicates,
} from '@repo/schemas/track-duplicates'
import { formatCount } from '@repo/ui/lib/format'
import { fetchApiData } from './api'
import {
  trackMatchDiagnosticsParams,
  type TrackMatchDiagnosticsState,
} from './match-diagnostics'

/*
 * The keys start with `tracks` and `track`, so a merge, Keep separate, Undo
 * and Redo refresh them with the other track queries (`invalidateScrobbleLinks`).
 */

/** The number of groups on the Possible duplicates toggle. */
export const trackDuplicateCountKey = (creatorId?: string) => [
  'tracks',
  'duplicates',
  'count',
  creatorId ?? null,
]

/** The group rows of the Possible duplicates view, for the Matches request it draws. */
export const trackDuplicateLayoutKey = (query: TrackMatchDiagnosticsState) => [
  'tracks',
  'duplicates',
  'layout',
  query,
]

/** The group an open track is in. */
export const trackDuplicatesKey = (trackId: string) => [
  'track',
  trackId,
  'duplicates',
]

export function loadTrackDuplicateCount(
  apiBaseUrl: string,
  creatorId?: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  if (creatorId) params.set('creatorId', creatorId)
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/duplicates/count${params.size ? `?${params}` : ''}`,
    TrackDuplicateCountSchema,
    { signal, priority: 'low' },
  )
}

/** The groups among the rows the Matches request for `query` lists, in its order. */
export function loadTrackDuplicateLayout(
  apiBaseUrl: string,
  query: TrackMatchDiagnosticsState,
  signal?: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/duplicates/layout?${trackMatchDiagnosticsParams(query)}`,
    TrackDuplicateLayoutSchema,
    { signal },
  )
}

export function loadTrackDuplicates(
  apiBaseUrl: string,
  trackId: string,
  signal?: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/${encodeURIComponent(trackId)}/duplicates`,
    TrackDuplicatesSchema,
    { signal },
  )
}

/** Stores that the tracks are different, as a change that can be undone. */
export function keepTracksSeparate(apiBaseUrl: string, trackIds: string[]) {
  return fetchApiData(
    apiBaseUrl,
    '/api/v1/library-changes/track-separations',
    LibraryChangeSchema,
    { method: 'POST', body: JSON.stringify({ trackIds }) },
  )
}

/** What put a group's tracks together, on one line. */
export function formatTrackDuplicateEvidence(
  group: Pick<TrackDuplicateGroup, 'evidence'>,
) {
  return group.evidence.join(' · ')
}

/** What Merge does to a group, in one sentence without a full stop; null when a member can no longer be read. */
export function describeTrackDuplicateMerge(
  group: Pick<TrackDuplicateGroup, 'merge'>,
) {
  const { merge } = group
  if (!merge) return null
  const parts = [
    ...(merge.versions === 1
      ? ['1 other track stays under it as a version']
      : merge.versions > 1
        ? [
            `${formatCount(merge.versions)} other tracks stay under it as versions`,
          ]
        : []),
    ...(merge.removed === 0
      ? []
      : [
          // A removed track with an album position or playlist entry is not a Last.fm record.
          merge.removedRecords === merge.removed
            ? merge.removed === 1
              ? '1 Last.fm record is removed and its plays and names move to it'
              : `${formatCount(merge.removed)} Last.fm records are removed and their plays and names move to it`
            : merge.removed === 1
              ? '1 other track is removed and its plays, names, album positions and playlist entries move to it'
              : `${formatCount(merge.removed)} other tracks are removed and their plays, names, album positions and playlist entries move to it`,
        ]),
  ]
  return `Merge keeps “${merge.keep.title}”${parts.length ? `: ${parts.join('; ')}` : ''}`
}

/** The text of a group row: what Merge does, then the evidence. */
export function describeTrackDuplicateGroup(
  group: Pick<TrackDuplicateGroup, 'evidence' | 'merge'>,
) {
  return [
    describeTrackDuplicateMerge(group),
    formatTrackDuplicateEvidence(group),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The notice on an open track: the other tracks of its group, the evidence and what Merge does. */
export function describeTrackDuplicateNotice(
  group: TrackDuplicates['items'][number],
) {
  const others = group.others.map(
    (track) => `“${track.title}”${track.by ? ` by ${track.by}` : ''}`,
  )
  const evidence = formatTrackDuplicateEvidence(group)
  const merge = describeTrackDuplicateMerge(group)
  return `Possible duplicate: ${others.join(', ')}.${evidence ? ` ${evidence}.` : ''}${merge ? ` ${merge}.` : ''}`
}

/**
 * Where the group rows of the Possible duplicates view go in a virtual table.
 * A group row stands above its first shown member. The row above a group's
 * first member carries the group row's height (`extraRowHeights` adds a
 * height below its row); the group at the first row has none above it, so its
 * height joins the header's (`leading`).
 */
export function trackDuplicateRows(
  groups: readonly TrackDuplicateLayoutGroup[],
  rowHeight: number,
) {
  const sorted = [...groups].sort((left, right) => left.offset - right.offset)
  const offsets = sorted.map((group) => group.offset)
  const byOffset = new Map(sorted.map((group) => [group.offset, group]))
  return {
    /** The group whose row stands above the table row at `index`. */
    above: (index: number) => byOffset.get(index),
    /** The group at the first row, drawn before the rows. */
    leading: byOffset.get(0),
    leadingHeight: byOffset.has(0) ? rowHeight : 0,
    /** Heights below rows, for `useVirtualTable`. */
    heights: new Map(
      offsets
        .filter((offset) => offset > 0)
        .map((offset) => [offset - 1, rowHeight]),
    ),
    /** How many group rows stand above the table row at `index` or above it. */
    through(index: number) {
      let start = 0
      let end = offsets.length
      while (start < end) {
        const middle = (start + end) >> 1
        const offset = offsets[middle]
        if (offset !== undefined && offset <= index) start = middle + 1
        else end = middle
      }
      return start
    },
    count: sorted.length,
  }
}
