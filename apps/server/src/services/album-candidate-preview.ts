import { z } from 'zod'
import { nanoid } from 'nanoid'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import {
  AlbumCandidatePreviewSchema,
  type AlbumCandidatePreviewInput,
} from '@repo/schemas/find-match'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import {
  DiscogsRecordSchema,
  LastFmAlbumSchema,
} from '@/lib/album-provider-details'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { parseOptionalDate } from '@/lib/media-utils'
import { readAlbumMatchRejections } from './album-match-rejections'
import { providerOperation } from './manual-add'
import { observeCatalogMedia } from './catalog-discoveries'

function releaseDetails(input: AlbumCandidatePreviewInput, payload: unknown) {
  if (input.provider === 'lastfm') {
    const { album } = z.object({ album: LastFmAlbumSchema }).parse(payload)
    return {
      title: album.name,
      artists: [
        typeof album.artist === 'string' ? album.artist : album.artist.name,
      ],
      date: null,
      masterId: null,
      mainReleaseId: null,
    }
  }
  const record =
    input.referenceType === 'master'
      ? z.object({ master: DiscogsRecordSchema }).parse(payload).master
      : z.object({ release: DiscogsRecordSchema }).parse(payload).release
  return {
    title: record.title,
    artists: record.artists.map((artist) => artist.name),
    date: record.released || (record.year ? String(record.year) : null),
    masterId:
      input.referenceType === 'master'
        ? String(record.id)
        : record.master_id
          ? String(record.master_id)
          : null,
    mainReleaseId: record.main_release ? String(record.main_release) : null,
  }
}

/** Inspect an explicit provider reference without replacing the album's references or snapshots. */
export async function previewAlbumCandidate(input: AlbumCandidatePreviewInput) {
  const album = await db.query.album.findFirst({
    columns: { mediaItemId: true },
    where: (a, op) => op.eq(a.mediaItemId, input.albumId),
  })
  if (!album)
    throw new ServerError({ statusCode: 404, message: 'Album not found.' })
  const isRejected = createAlbumMatchRejectionPredicate(
    input.provider,
    await readAlbumMatchRejections(db, input.albumId),
  )
  const rejected = () =>
    new ServerError({
      statusCode: 409,
      message: 'This candidate resolves to a previously rejected album match.',
    })
  if (isRejected(input)) throw rejected()
  const result = await providerOperation(
    input.provider,
    async (context, plugin) => {
      if (!plugin.scrapeMediaItem)
        throw new ServerError({
          statusCode: 422,
          message: 'This provider cannot preview an album.',
        })
      return PluginResultSchema.parse(
        await plugin.scrapeMediaItem({
          ...context,
          secrets:
            input.provider === 'lastfm'
              ? { apiKey: context.secrets.apiKey ?? '' }
              : context.secrets,
          mediaItemId: input.albumId,
          mediaType: 'album',
          existingReferences: [
            {
              referenceType: input.referenceType,
              externalId: input.externalId,
              isPrimary: true,
              metadata: { sourceProvider: input.provider },
            },
          ],
          log: async () => {},
        }),
      )
    },
    undefined,
    'previewing album candidates',
  )
  const release = releaseDetails(input, result.payload)
  const { provider } = input
  const tracks = result.normalized.tracks.slice(0, 500)
  const key = nanoid()
  const observedTracks = await db.transaction(async (tx) => {
    const albumId = await observeCatalogMedia(
      tx,
      {
        kind: 'album',
        title: release.title,
        provider,
        referenceType: input.referenceType,
        externalId: input.externalId,
        releaseDate: parseOptionalDate(release.date),
        trackCount: result.normalized.tracks.length,
        credits: release.artists.map((name) => ({ name })),
      },
      {
        provider,
        operation: 'album-preview',
        occurrenceKey: key,
        subjectKind: 'album',
        subjectId: input.albumId,
      },
    )
    const ids = []
    for (const track of tracks) {
      ids.push(
        await observeCatalogMedia(
          tx,
          {
            kind: 'track',
            title: track.title,
            provider,
            referenceType: 'track',
            albumId,
            albumName: release.title,
            durationSec: track.durationSec,
            credits: track.artists?.map((name) => ({ name })),
            provisionalKey: JSON.stringify([albumId, track.position]),
          },
          {
            provider,
            operation: 'album-preview',
            occurrenceKey: key,
            subjectKind: 'album',
            subjectId: albumId,
            relationshipRole: 'track_on_edition',
            position: track.position,
          },
        ),
      )
    }
    return ids
  })
  if (
    result.normalized.references.some(isRejected) ||
    result.normalized.links.some((link) =>
      isRejected({ referenceType: 'url', externalId: link.url }),
    )
  )
    throw rejected()
  const link = result.normalized.links.find(
    (link) => link.provider === input.provider,
  )
  if (!link)
    throw new ServerError({
      statusCode: 422,
      message: 'The provider returned no album URL.',
    })
  return AlbumCandidatePreviewSchema.parse({
    ...release,
    url: link.url,
    trackCount: result.normalized.tracks.length,
    tracks: tracks.map(({ title, position, durationSec }, index) => ({
      title,
      position,
      durationSec: durationSec ?? null,
      catalogMediaItemId: observedTracks[index],
    })),
  })
}
