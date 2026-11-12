import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaProviderPlugin,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { z } from 'zod'
import {
  LastFmAlbumSchema,
  LastFmSnapshotSchema,
  LastFmUrlSchema,
  albumProviderDetailsMetadata,
  lastFmAlbumTagEvidence,
} from '@/lib/album-provider-details'
import {
  AlbumMbidSchema,
  albumNames,
  albumReference,
  albumSecret,
  requestAlbumJson,
  requireAlbum,
} from './album-provider-helpers'

export function lastFmErrorCode(
  body: unknown,
): ProviderRequestError['code'] | null {
  const parsed = z.object({ error: z.number().int() }).safeParse(body)
  if (!parsed.success) return null
  if (parsed.data.error === 29) return 'rate-limit'
  return [4, 9, 10, 13, 26].includes(parsed.data.error) ? 'access-denied' : null
}

function lastFmLookup(
  context: MediaPluginScrapeContext,
): Record<string, string> {
  const reference = albumReference(context, 'lastfm', 'mbid', 'url')
  if (reference?.referenceType === 'mbid')
    return { mbid: AlbumMbidSchema.parse(reference.externalId) }
  if (reference) {
    const url = new URL(LastFmUrlSchema.parse(reference.externalId))
    const segments = url.pathname.split('/').filter(Boolean)
    const [artist, album] = segments.slice(
      segments[1] === '+noredirect' ? 2 : 1,
    )
    if (!artist || !album) throw new Error('Invalid Last.fm album URL.')
    return {
      artist: decodeURIComponent(artist.replaceAll('+', ' ')),
      album: decodeURIComponent(album.replaceAll('+', ' ')),
    }
  }
  const names = albumNames(context)
  // A MusicBrainz release-group ID is not a Last.fm album/release MBID.
  return { artist: names.artist, album: names.title }
}

async function requestLastFm(
  context: MediaPluginScrapeContext,
  method: 'album.getInfo' | 'album.getTopTags',
  params: Record<string, string>,
) {
  const url = new URL('https://ws.audioscrobbler.com/2.0/')
  url.search = new URLSearchParams({
    method,
    format: 'json',
    api_key: albumSecret(context, 'apiKey', 'Last.fm'),
    autocorrect: '1',
    ...params,
  }).toString()
  const payload = await requestAlbumJson(
    context,
    'Last.fm',
    url,
    undefined,
    lastFmErrorCode,
  )
  if ('error' in payload) {
    const error = z
      .object({ error: z.number().int(), message: z.string() })
      .parse(payload)
    if (
      method === 'album.getInfo' &&
      error.error === 6 &&
      /^album not found\.?$/i.test(error.message.trim())
    )
      throw new ProviderItemNotFoundError('Last.fm album not found.')
    throw new Error('Last.fm returned a service error.')
  }
  return payload
}

export const lastfmPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'lastfm',
    displayName: 'Last.fm',
    description: 'Album listeners, personal scrobbles and tags',
    mediaTypes: ['album'],
    identifierTypes: ['mbid', 'url'],
    supportsNameLookup: true,
    // Last.fm's HTTP 5xx responses are backend faults, not throttling: wait
    // briefly before the next request without opening a provider cooldown.
    // Rate limits and access denials keep their own cooldown and halt.
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: 200,
      errorBackoffMs: 5000,
      failureCooldownMs: 0,
    },
    secrets: [
      {
        key: 'apiKey',
        label: 'API Key',
        required: true,
        envVars: ['LASTFM_API_KEY'],
      },
      {
        key: 'username',
        label: 'Username',
        required: false,
        envVars: ['LASTFM_USERNAME'],
        helpText: 'Optional. Includes your album scrobble count when provided.',
      },
    ],
    browseFields: [
      {
        key: 'plugin.lastfm.playcount',
        label: 'Last.fm global plays',
        type: 'number',
        format: 'number',
        filterable: true,
      },
    ],
  },
  async scrapeMediaItem(context) {
    requireAlbum(context, 'Last.fm')
    const lookup = lastFmLookup(context)
    const username = context.secrets['username']?.trim()
    const info = await requestLastFm(context, 'album.getInfo', {
      ...lookup,
      ...(username ? { username } : {}),
    })
    const { album } = z.object({ album: LastFmAlbumSchema }).parse(info)
    if (
      lookup['mbid'] &&
      album.mbid &&
      lookup['mbid'].toLowerCase() !== album.mbid.toLowerCase()
    )
      throw new Error('Last.fm returned a different MBID.')
    const mbid = album.mbid || lookup['mbid']
    const includeTopTags = context.options?.['includeTopTags'] === true
    const payload = includeTopTags
      ? {
          ...info,
          topTagsResponse: await requestLastFm(context, 'album.getTopTags', {
            artist:
              typeof album.artist === 'string'
                ? album.artist
                : album.artist.name,
            album: album.name,
          }),
        }
      : info
    const snapshot = LastFmSnapshotSchema.parse(payload)
    const echoedMbid = snapshot.topTagsResponse?.toptags['@attr']?.mbid
    if (mbid && echoedMbid && mbid.toLowerCase() !== echoedMbid.toLowerCase())
      throw new Error('Last.fm returned top tags for a different MBID.')
    const tags = lastFmAlbumTagEvidence(snapshot).map((tag) => ({
      name: tag.name,
      kind: 'general',
      source: tag.source,
      rawName: tag.rawName,
    }))
    if (includeTopTags && context.options?.['tagsOnly'] === true)
      return PluginResultSchema.parse({ payload, normalized: { tags } })

    const tracks = (album.tracks?.track ?? []).map((track, index) => ({
      title: track.name,
      position: index + 1,
      durationSec: track.duration,
    }))
    const metadata = albumProviderDetailsMetadata('lastfm', payload)
    return PluginResultSchema.parse({
      payload,
      normalized: {
        mediaPatch: {
          artworkUrl: [...(album.image ?? [])]
            .reverse()
            .find((image) => image['#text'])?.['#text'],
          metadata: {
            ...metadata,
            browse: {
              ...metadata.browse,
              ...(album.listeners === undefined
                ? {}
                : { popularityLastFm: album.listeners }),
              ...(album.userplaycount === undefined
                ? {}
                : { scrobbles: album.userplaycount }),
              ...(album.playcount === undefined
                ? {}
                : { 'plugin.lastfm.playcount': album.playcount }),
            },
          },
        },
        references: [
          ...(album.mbid
            ? [
                {
                  referenceType: 'mbid',
                  externalId: album.mbid,
                  isPrimary: true,
                },
              ]
            : []),
          {
            referenceType: 'url',
            externalId: album.url,
            isPrimary: !album.mbid,
          },
        ],
        links: [{ provider: 'lastfm', label: 'Last.fm', url: album.url }],
        tags,
        tracks,
      },
    })
  },
}
