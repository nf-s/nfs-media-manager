import { z } from 'zod'
import {
  COVERAGE_ITEM_ID_LIMIT,
  CoverageGapSchema,
  type CoverageGap,
  type EntryGap,
  type ProviderCoverage,
} from '@repo/schemas/coverage'
import type { PlaylistDetailQuery } from '@repo/schemas/tracks'
import { coverageKey } from './metadata-coverage'

/** The URL parameter of a playlist track list's Missing data filter. */
export const GAP_FILTER_PARAM = 'playlistGaps'

/** Without `provider`, a gap for any provider. */
export type GapFilter = { gap: CoverageGap; provider?: string }

const GapFilterParamSchema = z.object({
  id: z.string(),
  gap: CoverageGapSchema,
  provider: z.string().min(1).max(100).optional(),
})

/** The playlist's gap filter from the URL; `null` shows every entry. */
export function gapFilter(value: string | null, id: string): GapFilter | null {
  try {
    const parsed = GapFilterParamSchema.safeParse(JSON.parse(value ?? 'null'))
    if (parsed.success && parsed.data.id === id)
      return { gap: parsed.data.gap, provider: parsed.data.provider }
  } catch {
    // Malformed URL state shows every entry.
  }
  return null
}

export function gapFilterParam(id: string, filter: GapFilter) {
  return JSON.stringify({ id, gap: filter.gap, provider: filter.provider })
}

type EntryQuery = Pick<
  PlaylistDetailQuery,
  'sortBy' | 'direction' | 'q' | 'kinds'
>

export function coverageEntriesPath(
  id: string,
  page: number,
  size: number,
  query: EntryQuery,
  filter: GapFilter,
) {
  return `/api/v1/playlists/${encodeURIComponent(id)}/coverage/entries?${new URLSearchParams(
    {
      page: String(page),
      size: String(size),
      sortBy: query.sortBy,
      direction: query.direction,
      gap: filter.gap,
      ...(filter.provider ? { provider: filter.provider } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(query.kinds?.length ? { kinds: JSON.stringify(query.kinds) } : {}),
    },
  )}`
}

/** Under the coverage key, so queueing from Coverage reloads the list too. */
export function coverageEntriesKey(
  id: string,
  query: EntryQuery,
  filter: GapFilter,
) {
  return [
    ...coverageKey('playlist', id),
    'entries',
    filter.gap,
    filter.provider ?? '',
    query.sortBy,
    query.direction,
    query.q ?? '',
    query.kinds ?? [],
  ]
}

/** The heading of the gap column and the word in the selection bar. */
export const gapLabels: Record<CoverageGap, string> = {
  missing: 'Missing',
  stale: 'Stale',
}

/** What queueing a gap does. */
export const gapVerbs: Record<CoverageGap, string> = {
  missing: 'Fetch',
  stale: 'Refresh',
}

export function gapActionLabel(gap: CoverageGap, displayName: string) {
  return `${gapVerbs[gap]} from ${displayName}`
}

/** One option per gap a Coverage line can show, plus the current one. */
export function gapFilterOptions(
  providers: readonly ProviderCoverage[],
  current: GapFilter,
) {
  const options = [
    { value: 'missing', label: 'Missing: any provider' },
    { value: 'stale', label: 'Stale: any provider' },
  ]
  for (const gap of CoverageGapSchema.options)
    for (const provider of providers)
      if (
        provider[gap] > 0 ||
        (current.gap === gap && current.provider === provider.provider)
      )
        options.push({
          value: gapFilterValue({ gap, provider: provider.provider }),
          label: `${gapLabels[gap]}: ${provider.displayName}`,
        })
  if (
    current.provider &&
    !providers.some((provider) => provider.provider === current.provider)
  )
    options.push({
      value: gapFilterValue(current),
      label: `${gapLabels[current.gap]}: ${current.provider}`,
    })
  return options
}

export function gapFilterValue(filter: GapFilter) {
  return filter.provider ? `${filter.gap}:${filter.provider}` : filter.gap
}

export function parseGapFilterValue(value: string): GapFilter | null {
  const separator = value.indexOf(':')
  const gap = CoverageGapSchema.safeParse(
    separator < 0 ? value : value.slice(0, separator),
  )
  if (!gap.success) return null
  return separator < 0
    ? { gap: gap.data }
    : { gap: gap.data, provider: value.slice(separator + 1) || undefined }
}

export type SelectionGap = {
  provider: string
  displayName: string
  /** Distinct albums of the selected rows with this provider's gap. */
  albumIds: string[]
}

/**
 * The providers that would fill the selected rows' gaps, the one covering
 * the most albums first. Album IDs are distinct across rows.
 */
export function selectionGaps(
  rows: readonly { gaps?: readonly EntryGap[] }[],
): SelectionGap[] {
  const byProvider = new Map<
    string,
    { displayName: string; albumIds: Set<string> }
  >()
  for (const row of rows)
    for (const gap of row.gaps ?? []) {
      const entry = byProvider.get(gap.provider) ?? {
        displayName: gap.displayName,
        albumIds: new Set<string>(),
      }
      for (const albumId of gap.albumIds) entry.albumIds.add(albumId)
      byProvider.set(gap.provider, entry)
    }
  return [...byProvider]
    .map(([provider, { displayName, albumIds }]) => ({
      provider,
      displayName,
      albumIds: [...albumIds],
    }))
    .sort(
      (left, right) =>
        right.albumIds.length - left.albumIds.length ||
        left.displayName.localeCompare(right.displayName),
    )
}

/** The album IDs one reviewed queue request takes from a selection. */
export function selectionQueueIds(gap: SelectionGap) {
  return gap.albumIds.slice(0, COVERAGE_ITEM_ID_LIMIT)
}
