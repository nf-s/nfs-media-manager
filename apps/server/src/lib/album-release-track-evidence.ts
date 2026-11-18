import type { AlbumReleaseTrackEvidence } from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { albumNameKey } from './album-import-candidates'
import { SpotifyTrackSchema, SpotifyTracksPageSchema } from './spotify-api'

export const AlbumEvidenceTrackLimit = 500
const TrackTitleSchema = z.string().trim().min(1).max(500)
const TrackNamesSchema = z
  .array(TrackTitleSchema)
  .min(1)
  .max(AlbumEvidenceTrackLimit)
const SpotifyEvidencePageSchema = SpotifyTracksPageSchema.pick({
  offset: true,
  total: true,
  next: true,
}).extend({
  items: z
    .array(
      SpotifyTrackSchema.pick({ disc_number: true, track_number: true }).extend(
        {
          name: TrackTitleSchema,
          artists: z.unknown().optional(),
        },
      ),
    )
    .min(1)
    .max(AlbumEvidenceTrackLimit),
})
const ArtistCreditsSchema = z
  .array(z.object({ name: TrackTitleSchema }))
  .min(1)
  .max(30)
const DiscogsTracklistSchema = z
  .array(
    z.union([
      z.object({ type_: z.enum(['heading', 'index']) }),
      z.object({
        type_: z.literal('track').optional(),
        title: TrackTitleSchema,
      }),
    ]),
  )
  .min(1)
  .max(AlbumEvidenceTrackLimit)

function nameKey(name: string) {
  return albumNameKey(name.normalize('NFC'))
}

export function albumEvidenceTrackNames(titles: unknown): string[] | undefined {
  return TrackNamesSchema.safeParse(titles).data?.map(nameKey)
}

function compareTrackNames(
  library: readonly string[],
  source: readonly string[],
): AlbumReleaseTrackEvidence {
  const sourceNames = new Set(source)
  const matchedTracks = [...new Set(library)].filter((name) =>
    sourceNames.has(name),
  ).length
  return {
    libraryTracks: library.length,
    matchedTracks,
    exactSequence:
      library.length === source.length &&
      library.every((name, index) => name === source[index]),
  }
}

export function spotifyAlbumTrackEvidence(
  library: readonly string[] | undefined,
  tracks: unknown,
  totalTracks: unknown,
): AlbumReleaseTrackEvidence | undefined {
  if (!library) return
  const page = SpotifyEvidencePageSchema.safeParse(tracks).data
  if (
    !page ||
    page.offset !== 0 ||
    page.next !== null ||
    page.items.length !== page.total ||
    (totalTracks !== undefined && totalTracks !== page.total)
  )
    return
  const ordered = page.items.sort(
    (a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number,
  )
  if (
    new Set(
      ordered.map(
        ({ disc_number, track_number }) => `${disc_number}:${track_number}`,
      ),
    ).size !== ordered.length
  )
    return
  const evidence = compareTrackNames(
    library,
    ordered.map(({ name }) => nameKey(name)),
  )
  // Repeated generic titles do not establish an artist's role on an album.
  if (
    !evidence.exactSequence ||
    evidence.matchedTracks < 3 ||
    evidence.matchedTracks / evidence.libraryTracks < 0.8
  )
    return evidence

  const counts = new Map<string, { name: string; tracks: number }>()
  for (const track of ordered) {
    const artists = ArtistCreditsSchema.safeParse(track.artists).data
    if (!artists) return evidence
    const seen = new Set<string>()
    for (const { name } of artists) {
      const key = nameKey(name)
      if (seen.has(key)) continue
      seen.add(key)
      const credit = counts.get(key) ?? { name, tracks: 0 }
      credit.tracks += 1
      counts.set(key, credit)
      if (counts.size > 64) return evidence
    }
  }
  const creditedArtists = [...counts.values()].sort(
    (a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name),
  )
  return { ...evidence, creditedArtists }
}

export function discogsAlbumTrackEvidence(
  library: readonly string[] | undefined,
  tracklist: unknown,
): AlbumReleaseTrackEvidence | undefined {
  if (!library) return
  const rows = DiscogsTracklistSchema.safeParse(tracklist).data
  const titles = rows?.flatMap((row) =>
    'title' in row ? [nameKey(row.title)] : [],
  )
  return titles?.length ? compareTrackNames(library, titles) : undefined
}
