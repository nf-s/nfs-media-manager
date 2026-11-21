import {
  ArtistMergePlanSchema,
  type ArtistMergeBlock,
  type ArtistMergeCaution,
  type ArtistMergePlan,
} from '@repo/schemas/artist-merges'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from './api'
import { providerLabel } from './field-provenance'

const base = '/api/v1/library-changes/artist-merges'

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

export type ArtistMergeSelection = {
  artistIds: string[]
  targetId?: string
  /** Also merge the titles scrobbled under the merged names. The server does when it is omitted. */
  follow?: boolean
}

/** What merging the selected artists would do, and any reason to review it. */
export function planArtistMerge(
  apiBaseUrl: string,
  selection: ArtistMergeSelection,
) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/plan`,
    ArtistMergePlanSchema,
    post(selection),
  )
}

export function mergeArtists(
  apiBaseUrl: string,
  request: ArtistMergeSelection & { reviewed: boolean },
) {
  return fetchApiData(apiBaseUrl, base, LibraryChangeSchema, post(request))
}

const quoted = (name: string) => `“${name}”`
const listed = new Intl.ListFormat('en', {
  style: 'long',
  type: 'conjunction',
})

/** One sentence of evidence against an artist merge. */
export function describeArtistMergeCaution(caution: ArtistMergeCaution) {
  switch (caution.code) {
    case 'profiles':
      return `They have different profiles on ${listed.format(caution.providers.map((provider) => providerLabel(provider)))}.`
    case 'together':
      return `They are credited together on ${formatCount(caution.items)} ${caution.items === 1 ? 'track or album' : 'tracks or albums'}, so they are likely different artists.`
    case 'names':
      return `The names are not alike: ${caution.names.map(quoted).join(', ')}.`
    case 'separate':
      return `${listed.format(caution.names.map(quoted))} were kept separate.`
  }
}

/** Why a selected artist cannot be merged, on its row. */
export const artistMergeBlockLabels: Record<ArtistMergeBlock, string> = {
  film: 'Has film credits',
}

/** Why the blocked artists cannot be merged, for the notice above the plan. */
export function describeArtistMergeBlock(
  blocked: readonly ArtistMergePlan['artists'][number][],
) {
  const [only] = blocked
  const who =
    blocked.length === 1 && only
      ? `${quoted(only.name)} has`
      : `${formatCount(blocked.length)} artists have`
  return `${who} film credits and cannot be merged. People in films and music artists share one record.`
}

/**
 * The titles scrobbled under the merged names that move to the matching
 * tracks of the artist to keep.
 */
export function describeArtistMergeFollows(
  also: ArtistMergePlan['also'],
  keptName?: string,
) {
  const names = [...new Set(also.map((title) => title.artistName))]
  return `${formatItemCount(also.length, { one: 'track name', other: 'track names' })} scrobbled under ${listed.format(names.map(quoted))} ${also.length === 1 ? 'moves' : 'move'} to the matching tracks${keptName ? ` of ${quoted(keptName)}` : ''}: ${also.map((title) => quoted(title.trackName)).join(', ')}.`
}
