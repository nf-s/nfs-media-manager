import type { BrowseField, BrowseValues } from '@repo/schemas/browse'
import { ExternalLinkSchema } from '@repo/schemas/common'
import type { AlbumListItem } from '@repo/schemas/media'
import { youtubeTrailerUrl } from '@repo/schemas/trailer'

export interface ProviderRating {
  key: string
  label: string
  display: NonNullable<BrowseField['rating']>
  score: number | undefined
  votes: number | undefined
  href?: string
  homepageLink?: boolean
}

type ProviderLink = AlbumListItem['links'][number]

export function providerIconUrl(
  provider: string,
  iconUrl?: string,
): string | undefined {
  const publicIcons: Record<string, string> = {
    imdb: '/icons/ratings/imdb.svg',
    tmdb: '/icons/ratings/tmdb.svg',
    rottentomatoes: '/icons/ratings/rottentomatoes.svg',
    discogs: '/icons/ratings/discogs.png',
    rym: '/icons/ratings/sonemic.png',
    metacritic: '/icons/ratings/metacritic.svg',
    metacriticuser: '/icons/ratings/metacritic.svg',
    trakt: '/icons/ratings/trakt.svg',
    letterboxd: '/icons/ratings/letterboxd.svg',
    'rottentomatoes-audience': '/icons/ratings/popcorn.svg',
    youtube: '/icons/ratings/youtube.svg',
  }
  // Runtime plugin icons must not initiate remote requests while browsing.
  return (
    publicIcons[provider] ??
    (iconUrl &&
    /^data:image\/(?:png|webp|gif|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      iconUrl,
    )
      ? iconUrl
      : undefined)
  )
}

export function isCompactRating(
  rating: Pick<ProviderRating, 'display'>,
): boolean {
  return (
    ['imdb', 'metacritic', 'letterboxd', 'rym', 'discogs'].includes(
      rating.display.provider,
    ) || rating.display.compact === true
  )
}

export function compactRatingStripWidth(fields: BrowseField[]): number {
  const count = fields.filter(
    (field) => field.rating && isCompactRating({ display: field.rating }),
  ).length
  return Math.max(110, count * 46 + 12)
}

export function safeRatingHref(value: string | undefined): string | undefined {
  if (!value) return undefined
  const result = ExternalLinkSchema.shape.url.safeParse(value)
  if (!result.success) return undefined
  const url = new URL(result.data)
  return (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.username &&
    !url.password
    ? result.data
    : undefined
}

function linkProvider(link: ProviderLink): string {
  const host = new URL(link.url).hostname.toLowerCase()
  const sites: Record<string, string[]> = {
    imdb: ['imdb.com'],
    tmdb: ['themoviedb.org'],
    metacritic: ['metacritic.com'],
    rottentomatoes: ['rottentomatoes.com'],
    rym: ['rateyourmusic.com', 'sonemic.com'],
    discogs: ['discogs.com'],
    spotify: ['spotify.com'],
    trakt: ['trakt.tv'],
    letterboxd: ['letterboxd.com'],
  }
  for (const [provider, domains] of Object.entries(sites)) {
    if (
      domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
    )
      return provider
  }
  return link.provider
}

export function getDetailProviderLinks(
  fields: BrowseField[],
  values: BrowseValues,
  links: ProviderLink[],
  spotifyUrl?: string | null,
  references: AlbumListItem['providerReferences'] = [],
): { ratings: ProviderRating[]; links: ProviderLink[]; trailerUrl?: string } {
  const trailerUrl = links.flatMap((link) => {
    if (link.provider !== 'youtube-trailer') return []
    const url = youtubeTrailerUrl(link.url)
    return url ? [url] : []
  })[0]
  const candidates = [
    ...(spotifyUrl
      ? [{ provider: 'spotify', label: 'Spotify', url: spotifyUrl }]
      : []),
    ...links.filter((link) => link.provider !== 'youtube-trailer'),
    ...references.flatMap((ref) => {
      const url = referenceRatingHref(ref)
      return url
        ? [{ provider: ref.referenceType, label: ref.referenceType, url }]
        : []
    }),
  ].filter((link) => safeRatingHref(link.url) !== undefined)
  const uniqueLinks = [
    ...new Map(
      candidates.map((link) => [link.url.replace(/\/$/, ''), link]),
    ).values(),
  ]
  const ratings = fields.flatMap((field) => {
    if (!field.rating) return []
    const provider = ratingSite(field.rating.provider)
    const link = uniqueLinks.find(
      (item) => ratingSite(linkProvider(item)) === provider,
    )
    const scored = getProviderRating(field, values)
    const known =
      link ||
      references.some(
        (ref) => ref.provider === provider || ref.referenceType === provider,
      )
    if (!scored && !known) return []
    const rating: ProviderRating = scored ?? {
      key: field.key,
      label: field.label,
      display: field.rating,
      score: undefined,
      votes: undefined,
    }
    if (link) return [{ ...rating, href: link.url }]
    // Aggregated scores may lack a film URL. Do not invent a title slug.
    const homepages: Record<string, string> = {
      metacritic: 'https://www.metacritic.com/',
      rottentomatoes: 'https://www.rottentomatoes.com/',
      trakt: 'https://trakt.tv/',
      letterboxd: 'https://letterboxd.com/',
    }
    const homepage = homepages[provider]
    return [
      homepage ? { ...rating, href: homepage, homepageLink: true } : rating,
    ]
  })
  const linkedProviders = new Set(
    ratings
      .filter((rating) => rating.href)
      .map((rating) => ratingSite(rating.display.provider)),
  )
  const fallbackProviders = new Set<string>()
  return {
    ratings,
    trailerUrl,
    links: uniqueLinks.filter((link) => {
      const provider = ratingSite(linkProvider(link))
      if (linkedProviders.has(provider) || fallbackProviders.has(provider))
        return false
      fallbackProviders.add(provider)
      return true
    }),
  }
}

function ratingSite(provider: string): string {
  if (provider === 'metacriticuser') return 'metacritic'
  if (provider === 'rottentomatoes-audience') return 'rottentomatoes'
  return provider
}

function referenceRatingHref(
  ref: AlbumListItem['providerReferences'][number],
): string | undefined {
  const { referenceType, externalId } = ref
  if (referenceType === 'imdb' && /^tt\d+$/.test(externalId))
    return `https://www.imdb.com/title/${externalId}/`
  if (referenceType === 'tmdb' && /^[1-9]\d*$/.test(externalId))
    return `https://www.themoviedb.org/movie/${externalId}`
  if (referenceType === 'trakt' && /^[1-9]\d*$/.test(externalId))
    return `https://trakt.tv/movies/${externalId}`
  return undefined
}

export function getProviderRating(
  field: BrowseField,
  values: BrowseValues,
): ProviderRating | undefined {
  const score = values[field.key]
  if (
    !field.rating ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > field.rating.scale
  )
    return undefined
  const votes = field.rating.votesKey
    ? values[field.rating.votesKey]
    : undefined
  return {
    key: field.key,
    label: field.label,
    display: field.rating,
    score,
    votes:
      typeof votes === 'number' && Number.isSafeInteger(votes) && votes >= 0
        ? votes
        : undefined,
  }
}

export function getProviderRatings(
  fields: BrowseField[],
  values: BrowseValues,
): ProviderRating[] {
  return fields.flatMap((field) => {
    const rating = getProviderRating(field, values)
    return rating ? [rating] : []
  })
}

export function metascoreTone(
  score: number,
): 'positive' | 'mixed' | 'negative' {
  return score >= 61 ? 'positive' : score >= 40 ? 'mixed' : 'negative'
}

export function ratingScore(rating: ProviderRating): string {
  if (rating.score === undefined) return ''
  return new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(
    rating.score,
  )
}

export function ratingDescription(rating: ProviderRating): string {
  if (rating.score === undefined) return `${rating.label}: No rating available.`
  const count = rating.votes?.toLocaleString('en')
  const votes =
    rating.display.provider === 'metacritic'
      ? count === undefined
        ? 'Review count unavailable'
        : `${count} critic reviews`
      : count === undefined
        ? 'Vote count unavailable'
        : `${count} votes`
  return `${rating.label}: ${ratingScore(rating)} out of ${rating.display.scale}. ${votes}.`
}
