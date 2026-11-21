import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import {
  TrackDuplicateCountSchema,
  TrackDuplicateLayoutSchema,
  TrackDuplicatesSchema,
  type TrackDuplicateGroup,
  type TrackDuplicateLayoutGroup,
  type TrackDuplicates,
} from '@repo/schemas/track-duplicates'
import { fetchApiData } from './api'

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

/** The group rows of the Possible duplicates view, for the browse identity it draws. */
export const trackDuplicateLayoutKey = (identity: string) => [
  'tracks',
  'duplicates',
  'layout',
  identity,
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

/** The groups among the rows the browse request `params` lists, in its order. */
export function loadTrackDuplicateLayout(
  apiBaseUrl: string,
  params: URLSearchParams,
  signal?: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/duplicates/layout?${params}`,
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

/** The notice on an open track: the other tracks of its group and the evidence. */
export function describeTrackDuplicateNotice(
  group: TrackDuplicates['items'][number],
) {
  const others = group.others.map(
    (track) => `“${track.title}”${track.by ? ` by ${track.by}` : ''}`,
  )
  const evidence = formatTrackDuplicateEvidence(group)
  return `Possible duplicate: ${others.join(', ')}.${evidence ? ` ${evidence}` : ''}`
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
    /** Heights below rows, for `useVirtualBrowse`. */
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

/** Maps of heights below rows as one; heights below the same row add up. */
export function addRowHeights(
  ...maps: (ReadonlyMap<number, number> | undefined)[]
): ReadonlyMap<number, number> | undefined {
  const merged = new Map<number, number>()
  for (const map of maps)
    for (const [row, height] of map ?? [])
      merged.set(row, (merged.get(row) ?? 0) + height)
  return merged.size ? merged : undefined
}
