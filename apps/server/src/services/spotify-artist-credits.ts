import { and, eq, inArray } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { mediaCredit } from '@/schemas/db'
import { writeArtistCredits, type ArtistCreditInput } from './artist-names'
import { observeNamedArtistIdentities } from './catalog-artist-identities'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type SpotifyBilling = { id?: string; name: string }

export function spotifyTrackBilling(track: {
  artists: string[]
  artistBilling?: SpotifyBilling[]
  artistCredits?: SpotifyBilling[]
}): SpotifyBilling[] {
  if (track.artistBilling) return track.artistBilling
  return [...new Set(track.artists)].flatMap((name) => {
    const native = track.artistCredits?.filter((credit) => credit.name === name)
    return native?.length ? native : [{ name }]
  })
}

export async function replaceSpotifyArtistCredits(
  tx: Transaction,
  trackIds: string[],
  credits: (ArtistCreditInput & { spotifyId?: string })[],
) {
  const names = new Map<string, string>()
  for (const { spotifyId, name } of credits)
    if (spotifyId && !names.has(spotifyId)) names.set(spotifyId, name)
  const artists = await observeNamedArtistIdentities(tx, 'spotify', names)
  await tx
    .delete(mediaCredit)
    .where(
      and(
        inArray(mediaCredit.mediaItemId, trackIds),
        eq(mediaCredit.role, 'artist'),
      ),
    )
  await writeArtistCredits(
    tx,
    credits.map(({ spotifyId, ...credit }) => ({
      ...credit,
      artistId: spotifyId ? artists.get(spotifyId) : undefined,
    })),
  )
}
