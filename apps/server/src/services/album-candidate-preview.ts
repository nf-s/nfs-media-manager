import { z } from 'zod'
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
import { readAlbumMatchRejections } from './album-match-rejections'
import { providerOperation } from './manual-add'

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
  const tracks = result.normalized.tracks
  return AlbumCandidatePreviewSchema.parse({
    ...releaseDetails(input, result.payload),
    url: link.url,
    trackCount: tracks.length,
    tracks: tracks.slice(0, 500).map(({ title, position, durationSec }) => ({
      title,
      position,
      durationSec: durationSec ?? null,
    })),
  })
}
