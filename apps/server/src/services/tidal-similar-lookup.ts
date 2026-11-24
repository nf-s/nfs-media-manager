import { z } from 'zod'
import {
  TIDAL_SIMILAR_LIMIT,
  TidalCountryCodeSchema,
  TidalIdSchema,
  TidalSimilarKindSchema,
  TidalSuggestionSchema,
  normalizeSimilarGenres,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import {
  TidalSimilarDocumentSchema,
  includedAlbums,
  includedArtists,
  includedTracks,
  tidalCatalogCredits,
  tidalDurationSec,
  tidalJson,
  tidalUrl,
  type TidalAlbumResource,
  type TidalArtistResource,
  type TidalRequest,
  type TidalTrackResource,
} from '@/lib/tidal-api'

export const TidalSimilarLookupSchema = z
  .object({
    countryCode: TidalCountryCodeSchema,
    kind: TidalSimilarKindSchema,
    tidalId: TidalIdSchema,
  })
  .strict()
export type TidalSimilarLookup = z.infer<typeof TidalSimilarLookupSchema>

const relationship = (kind: TidalSimilarKind) =>
  kind === 'album' ? 'similarAlbums' : 'similarTracks'

const GenreResourceSchema = z.object({
  id: z.string(),
  type: z.literal('genres'),
  attributes: z.object({ genreName: z.string().max(500) }),
})
const GenreRelationshipSchema = z.object({
  data: z
    .array(z.object({ id: z.string(), type: z.literal('genres') }))
    .max(100),
})

function genreNames(
  resource: TidalAlbumResource | TidalTrackResource,
  genres: ReadonlyMap<string, string>,
) {
  const relationship = GenreRelationshipSchema.safeParse(
    resource.relationships?.['genres'],
  )
  return relationship.success
    ? normalizeSimilarGenres(
        relationship.data.data.flatMap(({ id }) => genres.get(id) ?? []),
      )
    : []
}

function artistNames(
  resource: TidalAlbumResource | TidalTrackResource,
  artists: Map<string, TidalArtistResource>,
) {
  const names = (resource.relationships?.artists?.data ?? []).flatMap(
    ({ id }) => {
      const name = artists.get(id)?.attributes.name
      return name ? [name] : []
    },
  )
  return [...new Set(names)].slice(0, 20)
}

function albumSuggestion(
  album: TidalAlbumResource,
  artists: Map<string, TidalArtistResource>,
  genreResources: ReadonlyMap<string, string>,
): TidalSuggestion {
  const genres = genreNames(album, genreResources)
  const credits = tidalCatalogCredits(album, artists)
  return TidalSuggestionSchema.parse({
    tidalId: album.id,
    title: album.attributes.title,
    version: null,
    artists: artistNames(album, artists),
    ...(credits.length ? { artistCredits: credits } : {}),
    code: album.attributes.barcodeId?.trim() || null,
    durationSec: tidalDurationSec(album.attributes.duration),
    releaseDate: album.attributes.releaseDate?.trim() || null,
    url: tidalUrl('album', album),
    ...(genres.length ? { genres } : {}),
  })
}

function trackSuggestion(
  track: TidalTrackResource,
  artists: Map<string, TidalArtistResource>,
  albums: Map<string, TidalAlbumResource>,
  genreResources: ReadonlyMap<string, string>,
): TidalSuggestion {
  const genres = genreNames(track, genreResources)
  const credits = tidalCatalogCredits(track, artists)
  const linkedAlbums = (track.relationships?.albums?.data ?? [])
    .flatMap(({ id }) => {
      const album = albums.get(id)
      return album
        ? [
            {
              id,
              title: album.attributes.title,
              releaseDate: album.attributes.releaseDate ?? null,
              artistCredits: tidalCatalogCredits(album, artists),
            },
          ]
        : []
    })
    .slice(0, 20)
  return TidalSuggestionSchema.parse({
    tidalId: track.id,
    title: track.attributes.title,
    version: track.attributes.version?.trim() || null,
    artists: artistNames(track, artists),
    ...(credits.length ? { artistCredits: credits } : {}),
    ...(linkedAlbums.length ? { linkedAlbums } : {}),
    code: track.attributes.isrc?.trim() || null,
    durationSec: tidalDurationSec(track.attributes.duration),
    releaseDate: null,
    url: tidalUrl('track', track),
    ...(genres.length ? { genres } : {}),
  })
}

/**
 * The first page of TIDAL's similar albums or tracks, in TIDAL's order, with
 * their artists. One request. With `notFoundOn404`, an ID TIDAL does not
 * know throws `ProviderItemNotFoundError`.
 */
export async function lookupTidalSimilar(
  request: TidalRequest,
  token: string,
  input: TidalSimilarLookup,
  options: { notFoundOn404?: boolean } = {},
): Promise<TidalSuggestion[]> {
  const { countryCode, kind, tidalId } = TidalSimilarLookupSchema.parse(input)
  const name = relationship(kind)
  const document = TidalSimilarDocumentSchema.parse(
    await tidalJson(
      request,
      token,
      `/${kind === 'album' ? 'albums' : 'tracks'}/${tidalId}/relationships/${name}`,
      [
        ['countryCode', countryCode],
        ['include', `${name},${name}.artists`],
      ],
      options,
    ),
  )
  const artists = includedArtists(document.included)
  const albums = includedAlbums(document.included)
  const tracks = includedTracks(document.included)
  // TIDAL's public token cannot request the genres relationship, but the
  // documented resource can be read if the response already includes it.
  const genres = new Map<string, string>()
  for (const resource of document.included) {
    const genre = GenreResourceSchema.safeParse(resource)
    if (genre.success)
      genres.set(genre.data.id, genre.data.attributes.genreName)
  }
  const seen = new Set<string>([tidalId])
  const suggestions: TidalSuggestion[] = []
  for (const [index, { id }] of document.data.entries()) {
    if (seen.has(id)) continue
    seen.add(id)
    const album = kind === 'album' ? albums.get(id) : undefined
    const track = kind === 'track' ? tracks.get(id) : undefined
    const suggestion = album
      ? albumSuggestion(album, artists, genres)
      : track
        ? trackSuggestion(track, artists, albums, genres)
        : null
    if (suggestion)
      suggestions.push({ ...suggestion, catalogPosition: index + 1 })
    if (suggestions.length >= TIDAL_SIMILAR_LIMIT) break
  }
  return suggestions
}

/** Reads a TIDAL similar read again from its recorded response. */
export async function replayTidalSimilar(
  steps: readonly { operation: string; args: unknown }[],
  request: TidalRequest,
): Promise<TidalSuggestion[][]> {
  const [step] = steps
  if (steps.length !== 1 || step?.operation !== 'similar')
    throw new Error('Expected one TIDAL similar step')
  return [
    await lookupTidalSimilar(
      request,
      'offline-tidal-replay',
      TidalSimilarLookupSchema.parse(step.args),
    ),
  ]
}
