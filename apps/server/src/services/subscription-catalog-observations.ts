import { and, desc, eq } from 'drizzle-orm'
import type { db } from '@/lib/db'
import {
  SpotifyEpisodesPageSchema,
  SpotifySavedShowsPageSchema,
  normalizeSpotifyEpisode,
  normalizeSpotifyShow,
} from '@/lib/spotify-api'
import {
  YoutubeChannelPageSchema,
  YoutubeSubscriptionPageSchema,
  YoutubeUploadPageSchema,
  YoutubeVideoListSchema,
  youtubeDurationSeconds,
} from '@/lib/youtube-api'
import type { StationEpisode } from '@/lib/mix-station'
import { RinseSchedulePageSchema } from '@/lib/rinse-api'
import { providerResponse } from '@/schemas/db'
import { MixIdSchema, MixShowIdSchema } from '@repo/schemas/subscriptions'
import {
  observeCatalogMedia,
  observeCatalogOccurrences,
  type CatalogOrigin,
} from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type StoredResponse = Pick<
  typeof providerResponse.$inferSelect,
  'body' | 'id' | 'jobId' | 'provider' | 'receivedAt' | 'requestUrl' | 'status'
>

export async function subscriptionResponseOrigin(
  tx: Transaction,
  origin: CatalogOrigin,
  requestUrl?: string,
): Promise<CatalogOrigin> {
  if (!origin.jobId) return origin
  const [response] = await tx
    .select({
      id: providerResponse.id,
      receivedAt: providerResponse.receivedAt,
    })
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.jobId, origin.jobId),
        eq(providerResponse.provider, origin.provider),
        requestUrl ? eq(providerResponse.requestUrl, requestUrl) : undefined,
      ),
    )
    .orderBy(desc(providerResponse.ordinal))
    .limit(1)
  return {
    ...origin,
    responseId: response?.id,
    observedAt: response?.receivedAt ?? origin.observedAt,
  }
}

export async function observeSubscriptionPage(
  tx: Transaction,
  kind: 'subscription-source' | 'subscription-item',
  ids: string[],
  origin: CatalogOrigin,
) {
  await observeCatalogOccurrences(
    tx,
    ids.map((id, position) => ({
      target: { kind, id },
      origin: { ...origin, position: position + 1 },
    })),
  )
}

export async function observeStationEpisodes(
  tx: Transaction,
  episodes: { show: { id: string }; episode: StationEpisode }[],
  origin: CatalogOrigin,
) {
  await observeCatalogOccurrences(
    tx,
    episodes.map(({ show, episode }, position) => ({
      target: { kind: 'subscription-item', id: episode.id },
      origin: {
        ...origin,
        subjectKind: 'subscription-source',
        subjectId: show.id,
        relationshipRole: 'episode-of',
        position: position + 1,
        details: { publishedAt: episode.publishedAt.toISOString() },
      },
    })),
  )
  for (const { episode } of episodes) {
    await observeCatalogOccurrences(
      tx,
      episode.artists.map((name, position) => ({
        target: {
          kind: 'mix-performer-mention',
          id: `${episode.id}:${position + 1}`,
        },
        origin: {
          ...origin,
          subjectKind: 'subscription-item',
          subjectId: episode.id,
          relationshipRole: 'performer',
          position: position + 1,
          details: { name },
        },
      })),
    )
    for (const track of episode.tracklist ?? [])
      await observeCatalogMedia(
        tx,
        {
          kind: 'track',
          title: track.title,
          provider: origin.provider,
          referenceType: 'mix-track-mention',
          provisionalKey: JSON.stringify([
            episode.id,
            track.position,
            track.artist,
            track.title,
          ]),
          credits: track.artist ? [{ name: track.artist }] : [],
        },
        {
          ...origin,
          subjectKind: 'subscription-item',
          subjectId: episode.id,
          relationshipRole: 'mix-track',
          position: track.position,
          details: { creditedArtist: track.artist },
        },
      )
  }
}

const youtubeApi = 'https://www.googleapis.com/youtube/v3/'
const spotifyApi = 'https://api.spotify.com/v1/'

function collectedSubscriptionRows(
  row: StoredResponse,
  value: unknown,
  origin: CatalogOrigin,
) {
  if (row.requestUrl === `${youtubeApi}subscriptions`) {
    const parsed = YoutubeSubscriptionPageSchema.safeParse(value)
    return parsed.success
      ? parsed.data.items.map((item, position) => ({
          target: {
            kind: 'subscription-source',
            id: item.snippet.resourceId.channelId,
          },
          origin: {
            ...origin,
            operation: 'subscription-catalogue',
            position: position + 1,
          },
        }))
      : []
  }
  if (row.requestUrl === `${youtubeApi}channels`) {
    const parsed = YoutubeChannelPageSchema.safeParse(value)
    return parsed.success
      ? parsed.data.items.map((item, position) => ({
          target: { kind: 'subscription-source', id: item.id },
          origin: {
            ...origin,
            operation: 'channel-details',
            position: position + 1,
            details: {
              uploadsPlaylistId:
                item.contentDetails?.relatedPlaylists.uploads ?? null,
            },
          },
        }))
      : []
  }
  if (row.requestUrl === `${youtubeApi}playlistItems`) {
    const parsed = YoutubeUploadPageSchema.safeParse(value)
    return parsed.success
      ? parsed.data.items.map((item, position) => ({
          target: {
            kind: 'subscription-item',
            id: item.contentDetails.videoId,
          },
          origin: {
            ...origin,
            operation: 'upload-listing',
            position: position + 1,
          },
        }))
      : []
  }
  if (row.requestUrl === `${youtubeApi}videos`) {
    const parsed = YoutubeVideoListSchema.safeParse(value)
    return parsed.success
      ? parsed.data.items.map((item, position) => ({
          target: { kind: 'subscription-item', id: item.id },
          origin: {
            ...origin,
            operation: 'video-details',
            position: position + 1,
            subjectKind: 'subscription-source',
            subjectId: item.snippet.channelId,
            relationshipRole: 'upload',
            details: {
              publishedAt: item.snippet.publishedAt,
              durationSec: youtubeDurationSeconds(item.contentDetails.duration),
              live: item.snippet.liveBroadcastContent,
              viewCount: item.statistics?.viewCount ?? null,
              likeCount: item.statistics?.likeCount ?? null,
              commentCount: item.statistics?.commentCount ?? null,
            },
          },
        }))
      : []
  }
  if (row.requestUrl === `${spotifyApi}me/shows`) {
    const parsed = SpotifySavedShowsPageSchema.safeParse(value)
    return parsed.success
      ? parsed.data.items.flatMap((item, position) => {
          const show = normalizeSpotifyShow(item)
          return show
            ? [
                {
                  target: { kind: 'subscription-source', id: show.id },
                  origin: {
                    ...origin,
                    operation: 'podcast-catalogue',
                    position: parsed.data.offset + position + 1,
                    details: { episodeCount: show.itemTotal },
                  },
                },
              ]
            : []
        })
      : []
  }
  const spotifyShow =
    /^https:\/\/api\.spotify\.com\/v1\/shows\/([A-Za-z0-9]{22})\/episodes$/.exec(
      row.requestUrl ?? '',
    )?.[1]
  if (spotifyShow) {
    const parsed = SpotifyEpisodesPageSchema.safeParse(value)
    return parsed.success
      ? parsed.data.items.flatMap((item, position) => {
          if (!item) return []
          const episode = normalizeSpotifyEpisode(item)
          return [
            {
              target: { kind: 'subscription-item', id: episode.id },
              origin: {
                ...origin,
                operation: 'podcast-episodes',
                position: parsed.data.offset + position + 1,
                subjectKind: 'subscription-source',
                subjectId: spotifyShow,
                relationshipRole: 'episode-of',
                details: {
                  publishedAt: episode.publishedAt.toISOString(),
                  publishedPrecision: episode.publishedPrecision,
                  durationSec: episode.durationSec,
                },
              },
            },
          ]
        })
      : []
  }
  const scheduleDate =
    /^https:\/\/www\.rinse\.fm\/api\/query\/v1\/schedule\/(\d{4}-\d{2}-\d{2})$/.exec(
      row.requestUrl ?? '',
    )?.[1]
  if (scheduleDate) {
    const parsed = RinseSchedulePageSchema.safeParse(value)
    return parsed.success
      ? parsed.data.entries.flatMap((item, position) => {
          const id = MixIdSchema.safeParse(`rinse.${item.id}`)
          const show = MixShowIdSchema.safeParse(
            `rinse.${item.parentShow?.[0]?.id ?? ''}`,
          )
          if (!id.success) return []
          return [
            {
              target: { kind: 'subscription-item', id: id.data },
              origin: {
                ...origin,
                operation: 'station-schedule',
                position: position + 1,
                subjectKind: show.success ? 'subscription-source' : undefined,
                subjectId: show.success ? show.data : undefined,
                relationshipRole: 'scheduled-episode',
                details: {
                  scheduleDate,
                  reportedDate: item.episodeDate ?? null,
                  broadcastTime: item.episodeTime ?? null,
                  rebroadcast: item.isRebroadcast ?? null,
                  recordingListed: Boolean(
                    item.fileUrl || item.youtubeStreamUrl,
                  ),
                },
              },
            },
          ]
        })
      : []
  }
  return []
}

export async function projectSubscriptionResponse(
  tx: Transaction,
  row: StoredResponse,
) {
  if (
    row.status === null ||
    row.status < 200 ||
    row.status >= 300 ||
    row.body.state !== 'captured'
  )
    return 0
  if (
    !row.requestUrl ||
    !(
      (row.provider === 'youtube' && row.requestUrl.startsWith(youtubeApi)) ||
      (row.provider === 'spotify' &&
        (row.requestUrl === `${spotifyApi}me/shows` ||
          row.requestUrl.startsWith(`${spotifyApi}shows/`))) ||
      (row.provider === 'rinse' &&
        row.requestUrl.startsWith(
          'https://www.rinse.fm/api/query/v1/schedule/',
        ))
    )
  )
    return 0
  let value: unknown
  try {
    value = JSON.parse(row.body.text)
  } catch {
    return 0
  }
  const occurrences = collectedSubscriptionRows(row, value, {
    provider: row.provider,
    operation: 'provider-result',
    occurrenceKey: row.id,
    jobId: row.jobId,
    responseId: row.id,
    observedAt: row.receivedAt ?? undefined,
  })
  await observeCatalogOccurrences(tx, occurrences)
  return occurrences.length
}
