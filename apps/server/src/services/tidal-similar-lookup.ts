import { z } from 'zod'
import {
  TIDAL_SIMILAR_LIMIT,
  TidalCountryCodeSchema,
  TidalIdSchema,
  TidalSimilarKindSchema,
  TidalSuggestionSchema,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import {
  TidalSimilarDocumentSchema,
  includedAlbums,
  includedArtists,
  includedTracks,
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
): TidalSuggestion {
  return TidalSuggestionSchema.parse({
    tidalId: album.id,
    title: album.attributes.title,
    version: null,
    artists: artistNames(album, artists),
    code: album.attributes.barcodeId?.trim() || null,
    durationSec: tidalDurationSec(album.attributes.duration),
    releaseDate: album.attributes.releaseDate?.trim() || null,
    url: tidalUrl('album', album),
  })
}

function trackSuggestion(
  track: TidalTrackResource,
  artists: Map<string, TidalArtistResource>,
): TidalSuggestion {
  return TidalSuggestionSchema.parse({
    tidalId: track.id,
    title: track.attributes.title,
    version: track.attributes.version?.trim() || null,
    artists: artistNames(track, artists),
    code: track.attributes.isrc?.trim() || null,
    durationSec: tidalDurationSec(track.attributes.duration),
    releaseDate: null,
    url: tidalUrl('track', track),
  })
}

/**
 * The first page of TIDAL's similar albums or tracks, in TIDAL's order, with
 * their artists. One request.
 */
export async function lookupTidalSimilar(
  request: TidalRequest,
  token: string,
  input: TidalSimilarLookup,
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
    ),
  )
  const artists = includedArtists(document.included)
  const albums = includedAlbums(document.included)
  const tracks = includedTracks(document.included)
  const seen = new Set<string>([tidalId])
  const suggestions: TidalSuggestion[] = []
  for (const { id } of document.data) {
    if (seen.has(id)) continue
    seen.add(id)
    const album = kind === 'album' ? albums.get(id) : undefined
    const track = kind === 'track' ? tracks.get(id) : undefined
    if (album) suggestions.push(albumSuggestion(album, artists))
    else if (track) suggestions.push(trackSuggestion(track, artists))
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
