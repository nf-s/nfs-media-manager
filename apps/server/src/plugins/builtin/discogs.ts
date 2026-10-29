import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  type MediaProviderPlugin,
  type MediaPluginScrapeContext,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import { z } from 'zod'
import {
  DiscogsRecordSchema,
  albumProviderDetailBrowseFields,
  albumProviderDetailsMetadata,
} from '@/lib/album-provider-details'
import {
  albumBarcode,
  albumNameMatches,
  albumNames,
  albumReference,
  albumSecret,
  requestAlbumJson,
  requireAlbum,
} from './album-provider-helpers'

const IdSchema = z.number().int().positive().safe()
const ReferenceIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)))
const SearchSchema = z.object({
  pagination: z.object({ items: z.number().int().nonnegative() }).optional(),
  results: z.array(
    z.object({
      id: IdSchema,
      type: z.enum(['master', 'release']),
      title: z.string().min(1),
      master_id: z.number().int().nonnegative().optional(),
    }),
  ),
})

async function discogsRequest(
  context: MediaPluginTestContext,
  path: string,
  params: Record<string, string> = {},
) {
  const url = new URL(`https://api.discogs.com/${path}`)
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value)
  const payload = await requestAlbumJson(context, 'Discogs', url, {
    headers: {
      Authorization: `Discogs token=${albumSecret(context, 'token', 'Discogs')}`,
      'User-Agent': 'NfsMediaScraper/0.1',
      Accept: 'application/json',
    },
  })
  if ('message' in payload || 'error' in payload)
    throw new Error('Discogs returned a service error.')
  return payload
}

async function resolveDiscogsReference(
  context: MediaPluginScrapeContext,
): Promise<{ type: 'master' | 'release'; id: string }> {
  const reference = albumReference(context, 'discogs', 'master', 'release')
  if (reference)
    return {
      type: reference.referenceType === 'master' ? 'master' : 'release',
      id: ReferenceIdSchema.parse(reference.externalId),
    }
  const barcode = albumBarcode(context)
  if (barcode) {
    const payload = await discogsRequest(context, 'database/search', {
      type: 'release',
      barcode,
      per_page: '5',
      page: '1',
    })
    const { results, pagination } = SearchSchema.parse(payload)
    if (
      results.length === 1 &&
      results[0]?.type === 'release' &&
      (pagination === undefined || pagination.items === 1)
    )
      return { type: 'release', id: String(results[0].id) }
    if (!context.media?.title || !context.media.artists.length) {
      if (results.length)
        throw new Error(
          'Discogs barcode match is ambiguous. Set a master or release ID.',
        )
      throw new ProviderItemNotFoundError('Discogs found no barcode match.')
    }
  }
  const names = albumNames(context)
  for (const type of ['master', 'release'] satisfies Array<
    'master' | 'release'
  >) {
    const payload = await discogsRequest(context, 'database/search', {
      type,
      artist: names.artist,
      release_title: names.title,
      per_page: '5',
      page: '1',
    })
    const { results, pagination } = SearchSchema.parse(payload)
    if (pagination && pagination.items > results.length)
      throw new Error(
        'Discogs search exceeds the bounded matching window. Set a master or release ID.',
      )
    const matches = results.filter(
      (item) =>
        item.type === type &&
        albumNameMatches(
          item.title.replace(/ \(\d+\)(?= - )/, ''),
          `${names.artist} - ${names.title}`,
        ),
    )
    if (matches.length === 1 && matches[0])
      return { type, id: String(matches[0].id) }
    if (matches.length > 1)
      throw new Error(
        'Discogs search is ambiguous. Set a master or release ID.',
      )
  }
  throw new ProviderItemNotFoundError('Discogs found no matching album.')
}

function durationSeconds(value: string | undefined) {
  if (!value || !/^\d+:[0-5]\d$/.test(value)) return undefined
  const [minutes, seconds] = value.split(':').map(Number)
  return minutes === undefined || seconds === undefined
    ? undefined
    : minutes * 60 + seconds
}

export const discogsPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'discogs',
    displayName: 'Discogs',
    description:
      'Album metadata and single-release community ratings (no versions fanout)',
    mediaTypes: ['album'],
    identifierTypes: ['master', 'release', 'upc'],
    supportsNameLookup: true,
    rateLimit: { maxConcurrent: 1, minTimeMs: 1050 },
    secrets: [
      {
        key: 'token',
        label: 'User Token',
        required: true,
        envVars: ['DISCOGS_TOKEN'],
      },
    ],
    browseFields: [
      ...albumProviderDetailBrowseFields.discogs,
      {
        key: 'plugin.discogs.ratingScope',
        label: 'Discogs rating scope',
        type: 'text',
        filterable: true,
      },
    ],
  },
  async scrapeMediaItem(context) {
    requireAlbum(context, 'Discogs')
    const reference = await resolveDiscogsReference(context)
    const payload = await discogsRequest(
      context,
      `${reference.type === 'master' ? 'masters' : 'releases'}/${reference.id}`,
    )
    const record = DiscogsRecordSchema.parse(payload)
    if (String(record.id) !== reference.id)
      throw new Error('Discogs returned a different identifier.')
    let releasePayload = reference.type === 'release' ? payload : undefined
    if (reference.type === 'master') {
      if (!record.main_release)
        throw new Error('Discogs master is missing its main release.')
      releasePayload = await discogsRequest(
        context,
        `releases/${record.main_release}`,
      )
    }
    const release = DiscogsRecordSchema.parse(releasePayload)
    if (
      reference.type === 'master' &&
      (release.id !== record.main_release ||
        (release.master_id !== undefined && release.master_id !== record.id))
    )
      throw new Error('Discogs returned an unrelated main release.')
    const rating = release.community?.rating
    const have = release.community?.have
    const want = release.community?.want
    const storedPayload =
      reference.type === 'master'
        ? { master: payload, mainRelease: releasePayload }
        : { release: payload }
    const metadata = albumProviderDetailsMetadata('discogs', storedPayload)
    return PluginResultSchema.parse({
      payload: storedPayload,
      normalized: {
        mediaPatch: {
          artworkUrl:
            record.images?.find((image) => image.type === 'primary')?.uri ??
            record.images?.[0]?.uri,
          metadata: {
            ...metadata,
            browse: {
              ...metadata.browse,
              ...(rating
                ? {
                    ratingDiscogsValue: rating.average,
                    ratingDiscogsVotes: rating.count,
                  }
                : {}),
              ...(have === undefined || want === undefined
                ? {}
                : { popularityDiscogs: have + want }),
              'plugin.discogs.ratingScope':
                reference.type === 'master'
                  ? `Main release ${release.id} only`
                  : `Release ${release.id} only`,
            },
          },
        },
        references: [
          {
            referenceType: reference.type,
            externalId: String(record.id),
            isPrimary: true,
          },
        ],
        links: [
          {
            provider: 'discogs',
            label: 'Discogs',
            url: `https://www.discogs.com/${reference.type}/${record.id}`,
          },
        ],
        tags: [
          ...(record.genres ?? []).map((name) => ({
            name,
            kind: 'genre',
            source: 'discogs',
            rawName: name,
          })),
          ...(record.styles ?? []).map((name) => ({
            name,
            kind: 'style',
            source: 'discogs',
            rawName: name,
          })),
        ],
        tracks: (record.tracklist ?? [])
          .filter((track) => track.type_ === 'track')
          .map((track, index) => ({
            title: track.title,
            position: index + 1,
            durationSec: durationSeconds(track.duration),
          })),
      },
    })
  },
}
