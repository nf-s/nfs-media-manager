import {
  AlbumImportCandidateSchema,
  albumCandidateKeys,
  albumCandidateNameKey,
} from '@/lib/album-import-candidates'
import type { db } from '@/lib/db'
import {
  SpotifyAlbumSchema,
  type SpotifySavedPageSchema,
} from '@/lib/spotify-api'
import { parseOptionalDate } from '@/lib/media-utils'
import { sql } from 'drizzle-orm'
import { spotifyReleaseObservation } from '@/lib/music-provider-discoveries'
import { observeMusicDiscovery } from './music-provider-observations'
import type { CatalogOrigin } from './catalog-discoveries'
import type { z } from 'zod'
import { observeSpotifyArtistAlbumPage } from './spotify-artist-album-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Retain permitted media facts from a preview, independent of saved dates and file names. */
export async function observeAlbumImportCandidate(
  tx: Transaction,
  candidate: z.infer<typeof AlbumImportCandidateSchema>,
  origin: CatalogOrigin,
  ordinal: number,
  previewScope: string,
  catalogMediaItemId?: string,
) {
  const { provider, result } = candidate
  const spotify =
    provider === 'spotify'
      ? SpotifyAlbumSchema.safeParse(result.payload).data
      : undefined
  if (spotify) {
    const release = spotifyReleaseObservation(spotify, ordinal, 'preview_album')
    if (catalogMediaItemId) {
      for (const child of release.children ?? [])
        await observeMusicDiscovery(
          tx,
          child,
          { ...origin, position: ordinal },
          {
            kind: 'album',
            id: catalogMediaItemId,
            title: release.title,
          },
        )
      return catalogMediaItemId
    }
    return observeMusicDiscovery(tx, release, origin)
  }

  const { normalized } = result
  const keys = albumCandidateKeys(candidate)
  const spotifyId = keys
    .find((key) => key.startsWith('spotify:'))
    ?.slice('spotify:'.length)
  const upc = normalized.references.find(
    ({ referenceType }) => referenceType === 'upc',
  )?.externalId
  return observeMusicDiscovery(
    tx,
    {
      kind: 'album',
      provider: spotifyId ? 'spotify' : provider,
      referenceType: spotifyId ? 'spotify' : 'file-album',
      externalId: spotifyId,
      provisionalKey: JSON.stringify([
        previewScope,
        albumCandidateNameKey(candidate),
        upc,
      ]),
      title: normalized.mediaPatch?.title ?? 'Untitled album',
      ordinal,
      relationship: 'preview_album',
      url: spotifyId
        ? `https://open.spotify.com/album/${spotifyId}`
        : undefined,
      credits: normalized.credits
        .filter(({ role }) => role === 'artist')
        .map(({ name }) => ({ name })),
      details: upc ? { upc } : undefined,
    },
    origin,
  )
}

/** The scan order is provider evidence. The account's saved times stay in its preview. */
export function observeSpotifySavedAlbumPage(
  database: typeof db,
  page: z.infer<typeof SpotifySavedPageSchema>,
  previewId: string,
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
    return observeSpotifyArtistAlbumPage(
      tx,
      page.items.map(({ album }, index) => {
        const release = spotifyReleaseObservation(
          album,
          page.offset + index + 1,
          'preview_album',
        )
        return {
          externalId: album.id,
          title: release.title,
          spotifyUrl: `https://open.spotify.com/album/${album.id}`,
          artworkUrl: release.artworkUrl,
          releaseDate: parseOptionalDate(release.date) ?? undefined,
          trackCount: release.trackCount,
          credits: (release.credits ?? []).flatMap(({ name, externalId }) =>
            externalId ? [{ name, externalId }] : [],
          ),
          primary: false,
          relationshipRole: release.relationship,
          position: release.ordinal,
        }
      }),
      {
        operation: 'album-import-preview',
        occurrencePrefix: previewId,
        importId: previewId,
        page: Math.floor(page.offset / 50) + 1,
      },
    )
  })
}
