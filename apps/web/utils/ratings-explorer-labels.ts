import { albumBrowseFields, filmBrowseFields } from '@repo/schemas/browse'
import type {
  RatingsRankingRequest,
  RatingsSource,
} from '@repo/schemas/ratings-explorer'
import { ratingSource } from './provider-ratings'

/** Use the Browse column label for a known source, including a plugin's own abbreviation. */
export function shortSource(
  source: RatingsSource,
  library: RatingsRankingRequest['library'],
) {
  if (source.shortLabel) return source.shortLabel
  if (source.group === 'personal') return 'Mine'
  const fields = library === 'film' ? filmBrowseFields : albumBrowseFields
  const display = fields.find(({ key }) => key === source.key)?.rating
  return display ? ratingSource(display, source.label) : source.label
}
