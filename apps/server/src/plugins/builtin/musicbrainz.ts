import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  type MediaProviderPlugin,
  type MediaPluginScrapeContext,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import { z } from 'zod'
import {
  MusicBrainzGroupIdentitySchema as GroupIdentitySchema,
  MusicBrainzReleaseGroupSchema as ReleaseGroupSchema,
  albumProviderDetailBrowseFields,
  albumProviderDetailsMetadata,
} from '@/lib/album-provider-details'
import {
  AlbumMbidSchema,
  albumBarcode,
  albumNameMatches,
  albumNames,
  albumReference,
  albumSecret,
  requestAlbumJson,
  requireAlbum,
} from './album-provider-helpers'

async function musicBrainzRequest(
  context: MediaPluginTestContext,
  path: string,
  params: Record<string, string>,
) {
  const app = albumSecret(context, 'appName', 'MusicBrainz')
  const version = albumSecret(context, 'appVersion', 'MusicBrainz')
  const contact = albumSecret(context, 'contact', 'MusicBrainz')
  const url = new URL(`https://musicbrainz.org/ws/2/${path}`)
  for (const [key, value] of Object.entries({ ...params, fmt: 'json' }))
    url.searchParams.set(key, value)
  const payload = await requestAlbumJson(context, 'MusicBrainz', url, {
    headers: {
      'User-Agent': `${app}/${version} (${contact})`,
      Accept: 'application/json',
    },
  })
  if ('error' in payload)
    throw new Error('MusicBrainz returned a service error.')
  return payload
}

function groupMatches(
  group: z.infer<typeof GroupIdentitySchema>,
  names: ReturnType<typeof albumNames>,
) {
  return (
    albumNameMatches(group.title, names.title) &&
    group['artist-credit'].some((credit) =>
      albumNameMatches(credit.name ?? credit.artist.name, names.artist),
    )
  )
}

async function resolveReleaseGroup(
  context: MediaPluginScrapeContext,
): Promise<string> {
  const reference = albumReference(context, 'musicbrainz', 'release-group')
  if (reference) return AlbumMbidSchema.parse(reference.externalId)
  const barcode = albumBarcode(context)
  if (barcode) {
    const payload = await musicBrainzRequest(context, 'release/', {
      query: `barcode:${barcode}`,
      limit: '5',
    })
    const result = z
      .object({
        count: z.number().int().nonnegative().optional(),
        releases: z.array(
          GroupIdentitySchema.extend({
            'release-group': z.object({ id: AlbumMbidSchema }).optional(),
          }),
        ),
      })
      .parse(payload)
    const names =
      context.media?.title && context.media.artists.length
        ? albumNames(context)
        : undefined
    const candidates = result.releases.filter(
      (release) => !names || groupMatches(release, names),
    )
    const ids = [
      ...new Set(
        candidates.flatMap((release) =>
          release['release-group'] ? [release['release-group'].id] : [],
        ),
      ),
    ]
    if (
      ids.length === 1 &&
      ids[0] &&
      (result.count === undefined || result.count <= result.releases.length)
    )
      return ids[0]
    if (!names) {
      if (result.releases.length)
        throw new Error(
          'MusicBrainz barcode match is ambiguous. Set a release-group ID.',
        )
      throw new ProviderItemNotFoundError('MusicBrainz found no barcode match.')
    }
  }
  const names = albumNames(context)
  const quote = (value: string) =>
    `"${value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')}"`
  const payload = await musicBrainzRequest(context, 'release-group/', {
    query: `releasegroup:${quote(names.title)} AND artist:${quote(names.artist)}`,
    limit: '5',
  })
  const result = z
    .object({
      count: z.number().int().nonnegative().optional(),
      'release-groups': z.array(GroupIdentitySchema),
    })
    .parse(payload)
  if (
    result.count !== undefined &&
    result.count > result['release-groups'].length
  )
    throw new Error(
      'MusicBrainz search exceeds the bounded matching window. Set a release-group ID.',
    )
  const matches = result['release-groups'].filter((group) =>
    groupMatches(group, names),
  )
  if (matches.length > 1)
    throw new Error('MusicBrainz search is ambiguous. Set a release-group ID.')
  if (!matches[0])
    throw new ProviderItemNotFoundError(
      'MusicBrainz found no matching release group.',
    )
  return matches[0].id
}

export const musicbrainzPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'musicbrainz',
    displayName: 'MusicBrainz',
    description: 'Album release groups, genres and public relationships',
    mediaTypes: ['album'],
    identifierTypes: ['release-group', 'upc'],
    supportsNameLookup: true,
    rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
    browseFields: albumProviderDetailBrowseFields.musicbrainz,
    secrets: [
      {
        key: 'appName',
        label: 'App Name',
        required: true,
        envVars: ['MB_APP_NAME'],
      },
      {
        key: 'appVersion',
        label: 'App Version',
        required: true,
        envVars: ['MB_APP_VERSION'],
      },
      {
        key: 'contact',
        label: 'Contact Email',
        required: true,
        envVars: ['MB_CONTACT'],
      },
    ],
  },
  async scrapeMediaItem(context) {
    requireAlbum(context, 'MusicBrainz')
    const id = await resolveReleaseGroup(context)
    const payload = await musicBrainzRequest(context, `release-group/${id}`, {
      inc: 'artists+tags+genres+url-rels',
    })
    const group = ReleaseGroupSchema.parse(payload)
    // Merged MusicBrainz entities can legitimately resolve to a replacement MBID.
    return PluginResultSchema.parse({
      payload: { releaseGroup: payload },
      normalized: {
        mediaPatch: {
          metadata: albumProviderDetailsMetadata('musicbrainz', {
            releaseGroup: payload,
          }),
        },
        references: [
          {
            referenceType: 'release-group',
            externalId: group.id,
            isPrimary: true,
          },
        ],
        links: [
          {
            provider: 'musicbrainz',
            label: 'MusicBrainz',
            url: `https://musicbrainz.org/release-group/${group.id}`,
          },
        ],
        tags: [
          ...(group.genres ?? []).map((tag) => ({
            name: tag.name,
            kind: 'genre',
            source: 'musicbrainz',
            sourceId: tag.id,
            rawName: tag.name,
          })),
          ...(group.tags ?? []).map((tag) => ({
            name: tag.name,
            kind: 'general',
            source: 'musicbrainz',
            rawName: tag.name,
          })),
        ],
      },
    })
  },
}
