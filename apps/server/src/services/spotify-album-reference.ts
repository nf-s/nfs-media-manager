import { and, eq, sql } from 'drizzle-orm'
import type { SpotifyAlbumReferenceInput } from '@repo/schemas/spotify-album-reference'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import {
  libraryTrack,
  providerCurrentState,
  providerSecret,
} from '@/schemas/db'
import {
  observeCatalogMedia,
  promoteCatalogMediaInTransaction,
} from './catalog-discoveries'
import { createJob } from './jobs'

/** Resolve an exact parent recorded on a track. Opening it never adds membership. */
export async function openSpotifyAlbumReference(
  { trackId, spotifyAlbumId, add }: SpotifyAlbumReferenceInput,
  userId: string,
) {
  const mediaItemId = await db.transaction(async (tx) => {
    // Match the lock used by the writers that can replace a track's provider ID.
    await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
    const [track] = await tx
      .select({ albumName: libraryTrack.albumName })
      .from(libraryTrack)
      .where(
        and(
          eq(libraryTrack.mediaItemId, trackId),
          eq(libraryTrack.spotifyAlbumId, spotifyAlbumId),
        ),
      )
    if (!track)
      throw new ServerError({
        statusCode: 404,
        message: 'This Spotify album reference is no longer on the track.',
      })
    const id = await observeCatalogMedia(
      tx,
      {
        kind: 'album',
        provider: 'spotify',
        referenceType: 'spotify',
        externalId: spotifyAlbumId,
        title: track.albumName?.trim() || 'Spotify release',
        spotifyUrl: `https://open.spotify.com/album/${spotifyAlbumId}`,
      },
      {
        provider: 'spotify',
        operation: 'parent-reference',
        subjectKind: 'track',
        subjectId: trackId,
        relationshipRole: 'album',
        occurrenceKey: spotifyAlbumId,
      },
    )
    if (add) await promoteCatalogMediaInTransaction(tx, id, userId)
    return id
  })
  if (add) return { mediaItemId }
  const stored = await db.query.providerCurrentState.findFirst({
    columns: { latestSnapshotId: true },
    where: and(
      eq(providerCurrentState.mediaItemId, mediaItemId),
      eq(providerCurrentState.provider, 'spotify'),
    ),
  })
  if (stored?.latestSnapshotId) return { mediaItemId }

  const rows = await db.query.providerSecret.findMany({
    where: eq(providerSecret.provider, 'spotify'),
  })
  const secrets = resolveProviderSecrets(
    'spotify',
    rows,
    spotifyPlugin.manifest.secrets,
  )
  if (!secrets.clientId?.trim() || !secrets.clientSecret?.trim())
    return { mediaItemId }
  try {
    const job = await createJob(
      {
        provider: 'spotify',
        scope: { mediaItemIds: [mediaItemId], mediaType: 'album', limit: 1 },
        options: { spotifyAlbumReference: spotifyAlbumId },
        confirmBroadRun: true,
      },
      userId,
      { reuseSpotifyAlbumReferenceAttempt: true, deferUntilReady: true },
    )
    return { mediaItemId, jobId: job.id }
  } catch (error) {
    // The saved parent can be opened while its provider is unavailable.
    if (
      error instanceof ServerError &&
      [422, 429].includes(error.response.statusCode)
    )
      return { mediaItemId }
    throw error
  }
}
