import {
  AlbumImportCandidateSchema,
  albumCandidateKeys,
  albumCandidateNameKey,
} from '@/lib/album-import-candidates'
import type { db } from '@/lib/db'
import type { SpotifySavedPageSchema } from '@/lib/spotify-api'
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
) {
  const { provider, result } = candidate
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
    const releases = page.items.map(({ album }, index) => ({
      externalId: album.id,
      release: spotifyReleaseObservation(
        album,
        page.offset + index + 1,
        'preview_album',
      ),
    }))
    const pageNumber = Math.floor(page.offset / 50) + 1
    const ids = await observeSpotifyArtistAlbumPage(
      tx,
      releases.map(({ externalId, release }) => ({
        externalId,
        title: release.title,
        spotifyUrl: `https://open.spotify.com/album/${externalId}`,
        artworkUrl: release.artworkUrl,
        releaseDate: parseOptionalDate(release.date) ?? undefined,
        trackCount: release.trackCount,
        upc: release.upc,
        details: release.details,
        credits: (release.credits ?? []).flatMap(({ name, externalId }) =>
          externalId ? [{ name, externalId }] : [],
        ),
        primary: false,
        relationshipRole: release.relationship,
        position: release.ordinal,
      })),
      {
        operation: 'album-import-preview',
        occurrencePrefix: previewId,
        importId: previewId,
        page: pageNumber,
      },
    )
    for (const { externalId, release } of releases) {
      const id = ids.get(externalId)
      if (!id) continue
      for (const child of release.children ?? [])
        await observeMusicDiscovery(
          tx,
          child,
          {
            provider: 'spotify',
            operation: 'album-import-preview',
            occurrenceKey: previewId,
            importId: previewId,
            page: pageNumber,
            position: release.ordinal,
          },
          { kind: 'album', id, title: release.title },
        )
    }
    return ids
  })
}
