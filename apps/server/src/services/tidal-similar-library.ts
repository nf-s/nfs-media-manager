import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { PluginNormalizedResultSchema } from '@repo/media-plugin-sdk'
import {
  TidalSimilarAddParamsSchema,
  TidalSuggestionSchema,
  tidalSuggestionTitle,
  type TidalSimilarItem,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { validIsrc } from '@/lib/isrc'
import {
  createStableId,
  parseOptionalDate,
  slugifyParts,
} from '@/lib/media-utils'
import { UpcSchema } from '@/lib/spotify-api'
import { album, libraryTrack, mediaItem, providerReference } from '@/schemas/db'
import { lockAlbumImportWrites } from './album-imports'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { writeArtistCredits } from './artist-names'
import { promoteCatalogMediaInTransaction } from './catalog-discoveries'
import { applyProviderResultInTransaction } from './provider-state'
import { storeManualTrackInTransaction } from './spotify-track-recordings'
import { findStoredTidalSuggestion } from './tidal-similar'
import { recordTrackIsrcs } from './track-isrcs'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const SOURCE = 'tidal-similar'

function tidalReference(
  kind: TidalSimilarKind,
  item: TidalSuggestion,
  sourceItemId: string,
  addedAt: Date,
) {
  return {
    referenceType: kind,
    externalId: item.tidalId,
    isPrimary: true,
    metadata: {
      source: SOURCE,
      sourceItemId,
      recordedAt: addedAt.toISOString(),
      url: item.url,
      version: item.version,
      durationSec: item.durationSec,
      popularity: null,
    },
  }
}

function credits(artists: string[]) {
  return artists.map((name, billingOrder) => ({
    name,
    billingOrder,
    role: 'artist',
  }))
}

async function addAlbum(
  tx: Transaction,
  item: TidalSimilarItem,
  sourceItemId: string,
  addedAt: Date,
) {
  const id = createStableId('album', `tidal:${item.tidalId}`)
  const spotify = item.spotify
  const title = spotify?.title ?? item.title
  await tx.insert(mediaItem).values({
    id,
    mediaType: 'album',
    slug: slugifyParts(title, id),
    title,
    artworkUrl: spotify?.artworkUrl,
    releaseDate: parseOptionalDate(item.releaseDate),
    sourceLabel: spotify ? 'spotify' : 'tidal',
  })
  await tx.insert(album).values({
    mediaItemId: id,
    dateAdded: addedAt,
    durationSec: item.durationSec,
    trackCount: spotify?.trackCount ?? 0,
  })
  const upc = UpcSchema.safeParse(item.code)
  const { genres, ...suggestion } = item
  await applyProviderResultInTransaction(
    {
      mediaItemId: id,
      mediaType: 'album',
      provider: 'tidal',
      source: SOURCE,
      payload: {
        sourceItemId,
        suggestion: TidalSuggestionSchema.parse(
          item.genreSource === 'tidal' ? { ...suggestion, genres } : suggestion,
        ),
      },
      normalized: PluginNormalizedResultSchema.parse({
        references: [
          tidalReference('album', item, sourceItemId, addedAt),
          ...(upc.success
            ? [{ referenceType: 'upc', externalId: upc.data }]
            : []),
        ],
        links: [{ provider: 'tidal', label: 'TIDAL', url: item.url }],
        credits: spotify?.artists.length ? [] : credits(item.artists),
      }),
    },
    tx,
  )
  if (spotify) {
    const url = `https://open.spotify.com/album/${spotify.spotifyId}`
    await applyProviderResultInTransaction(
      {
        mediaItemId: id,
        mediaType: 'album',
        provider: 'spotify',
        source: SOURCE,
        payload: { sourceItemId, match: spotify },
        normalized: PluginNormalizedResultSchema.parse({
          albumPatch: { spotifyUrl: url },
          references: [
            {
              referenceType: 'album',
              externalId: spotify.spotifyId,
              isPrimary: true,
            },
          ],
          links: [{ provider: 'spotify', label: 'Spotify', url }],
          credits: credits(spotify.artists),
        }),
      },
      tx,
    )
  }
  return id
}

async function addTrack(
  tx: Transaction,
  item: TidalSimilarItem,
  sourceItemId: string,
  addedAt: Date,
) {
  const isrc = validIsrc(item.code)
  const spotify = item.spotify
  let id: string
  if (spotify) {
    const { mediaItemId } = await storeManualTrackInTransaction(tx, {
      spotifyTrackId: spotify.spotifyId,
      spotifyUrl: `https://open.spotify.com/track/${spotify.spotifyId}`,
      title: spotify.title,
      artists: spotify.artists.length ? spotify.artists : item.artists,
      artistCredits: [],
      albumName: spotify.albumName,
      spotifyAlbumId: spotify.spotifyAlbumId,
      durationSec: spotify.durationSec ?? item.durationSec,
      artworkUrl: spotify.artworkUrl,
      isrc,
      releaseDate: item.releaseDate,
    })
    id = mediaItemId
  } else {
    id = createStableId('track', `tidal:${item.tidalId}`)
    const displayTitle = TidalSuggestionSchema.shape.title.safeParse(
      tidalSuggestionTitle(item),
    )
    const title = displayTitle.success ? displayTitle.data : item.title
    await tx.insert(mediaItem).values({
      id,
      mediaType: 'track',
      slug: slugifyParts(title, id),
      title,
      releaseDate: parseOptionalDate(item.releaseDate),
      sourceLabel: 'tidal',
      metadata: { tidalSimilarTrackAddedAt: addedAt.toISOString() },
    })
    await tx.insert(libraryTrack).values({
      mediaItemId: id,
      durationSec: item.durationSec,
      isrc,
      dateAdded: addedAt,
    })
    await writeArtistCredits(
      tx,
      credits(item.artists).map((credit) => ({ ...credit, mediaItemId: id })),
    )
  }
  await tx
    .insert(providerReference)
    .values({
      id: createStableId('pref', `${id}:tidal:track:${item.tidalId}`),
      mediaItemId: id,
      provider: 'tidal',
      ...tidalReference('track', item, sourceItemId, addedAt),
    })
    .onConflictDoNothing()
  await recordTrackIsrcs(
    tx,
    [{ mediaItemId: id, isrc, provider: 'tidal', source: { kind: SOURCE } }],
    addedAt,
  )
  return id
}

export async function addTidalSimilarToLibrary(
  input: z.infer<typeof TidalSimilarAddParamsSchema>,
) {
  const {
    kind: target,
    id: sourceItemId,
    tidalId,
  } = TidalSimilarAddParamsSchema.parse(input)
  const kind = target === 'albums' ? 'album' : 'track'
  return db.transaction(async (tx) => {
    if (kind === 'album') await lockAlbumImportWrites(tx)
    else await lockLibraryTrackWrites(tx)

    const item = await findStoredTidalSuggestion(
      tx,
      kind,
      sourceItemId,
      tidalId,
    )
    if (item === undefined)
      throw new ServerError({
        statusCode: 404,
        message:
          kind === 'album' ? 'Album not found.' : 'Library track not found.',
      })
    if (item === null)
      throw new ServerError({
        statusCode: 404,
        message: 'Similar item not found.',
      })
    if (item.catalogMediaItemId) {
      const { mediaItemId } = await promoteCatalogMediaInTransaction(
        tx,
        item.catalogMediaItemId,
      )
      return { id: mediaItemId }
    }
    if (item.library) return { id: item.library.id }
    // A Sonovault link stays in the removable lookup cache. Only a match
    // returned by Spotify becomes the library item's Spotify identity.
    const verified = {
      ...item,
      spotify: item.spotifySource === 'spotify' ? item.spotify : null,
    }

    const [hidden] = await tx
      .select({ id: mediaItem.id })
      .from(providerReference)
      .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
      .where(
        and(
          eq(mediaItem.mediaType, kind),
          sql`${mediaItem.metadata}->>'legacyHidden' = 'true'`,
          or(
            and(
              eq(providerReference.provider, 'tidal'),
              eq(providerReference.referenceType, kind),
              eq(providerReference.externalId, tidalId),
            ),
            kind === 'album' && verified.spotify
              ? and(
                  eq(providerReference.provider, 'spotify'),
                  inArray(providerReference.referenceType, [
                    'album',
                    'spotify',
                  ]),
                  eq(providerReference.externalId, verified.spotify.spotifyId),
                )
              : undefined,
          ),
        ),
      )
      .limit(1)
    if (hidden)
      throw new ServerError({
        statusCode: 409,
        message: 'The selected item is hidden in the library.',
      })

    const addedAt = new Date()
    const id =
      kind === 'album'
        ? await addAlbum(tx, verified, sourceItemId, addedAt)
        : await addTrack(tx, verified, sourceItemId, addedAt)
    return { id }
  })
}
