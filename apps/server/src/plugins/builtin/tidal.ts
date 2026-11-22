import {
  ProviderItemAmbiguousError,
  ProviderItemNotFoundError,
  type MediaPluginScrapeContext,
  type MediaProviderPlugin,
  type PluginTrack,
} from '@repo/media-plugin-sdk'
import { JsonValueSchema } from '@repo/schemas/common'
import { TidalIdSchema } from '@repo/schemas/tidal'
import { UpcSchema } from '@/lib/spotify-api'
import {
  TIDAL_ALBUM_TRACK_LIMIT,
  TidalAlbumItemsDocumentSchema,
  TidalAlbumsDocumentSchema,
  includedTracks,
  nextPageCursor,
  tidalCountry,
  tidalDurationSec,
  tidalJson,
  tidalToken,
  tidalTrackData,
  tidalUrl,
  type TidalAlbumResource,
  type TidalTrackResource,
} from '@/lib/tidal-api'

const sameBarcode = (left: string, right: string) =>
  left.padStart(14, '0') === right.padStart(14, '0')

/** The album's own TIDAL ID, or the UPC its Spotify album reported. */
function albumLookup(context: MediaPluginScrapeContext) {
  const owned = context.existingReferences.find(
    (ref) =>
      ref.referenceType === 'album' &&
      ref.metadata?.['sourceProvider'] === 'tidal' &&
      !context.isRejectedMatch?.(ref),
  )
  if (owned) {
    const id = TidalIdSchema.safeParse(owned.externalId.trim())
    if (!id.success) throw new Error('Invalid TIDAL album identifier')
    return { kind: 'id' as const, value: id.data }
  }
  const upc = context.existingReferences.find(
    (ref) =>
      ref.referenceType === 'upc' &&
      ref.metadata?.['sourceProvider'] === 'spotify',
  )?.externalId
  if (!upc) throw new Error('TIDAL needs the album UPC from Spotify')
  return { kind: 'upc' as const, value: UpcSchema.parse(upc.trim()) }
}

type AlbumItem = { id: string; volumeNumber: number; trackNumber: number }

/** The album's items in volume and track order, with every track resource. */
async function albumTracks(
  context: MediaPluginScrapeContext,
  token: string,
  countryCode: string,
  album: TidalAlbumResource,
  firstIncluded: Map<string, TidalTrackResource>,
  pages: unknown[],
) {
  const relationship = album.relationships?.items
  const items: AlbumItem[] = []
  const tracks = new Map(firstIncluded)
  const addItems = (
    data: NonNullable<typeof relationship>['data'] = [],
  ): void => {
    for (const item of data) {
      if (item.type !== 'tracks') continue
      if (!item.meta) throw new Error('TIDAL album item has no position')
      items.push({ id: item.id, ...item.meta })
    }
  }
  addItems(relationship?.data)
  let cursor = nextPageCursor(relationship?.links)
  const expected = album.attributes.numberOfItems
  if (expected !== undefined && expected > TIDAL_ALBUM_TRACK_LIMIT)
    throw new Error(
      `TIDAL album exceeds the ${TIDAL_ALBUM_TRACK_LIMIT}-track safety limit`,
    )
  const seenCursors = new Set<string>()
  while (cursor) {
    if (seenCursors.has(cursor) || items.length >= TIDAL_ALBUM_TRACK_LIMIT)
      throw new Error('Invalid TIDAL track pagination')
    seenCursors.add(cursor)
    const raw = await tidalJson(
      context.request,
      token,
      `/albums/${album.id}/relationships/items`,
      [
        ['countryCode', countryCode],
        ['include', 'items'],
        ['page[cursor]', cursor],
      ],
    )
    pages.push(JsonValueSchema.parse(raw))
    const page = TidalAlbumItemsDocumentSchema.parse(raw)
    if (!page.data.length)
      throw new Error('TIDAL album changed during pagination; retry')
    addItems(page.data)
    for (const [id, track] of includedTracks(page.included))
      tracks.set(id, track)
    cursor = nextPageCursor(page.links)
  }
  items.sort(
    (left, right) =>
      left.volumeNumber - right.volumeNumber ||
      left.trackNumber - right.trackNumber,
  )
  if (
    new Set(items.map((item) => `${item.volumeNumber}:${item.trackNumber}`))
      .size !== items.length
  )
    throw new Error('Duplicate TIDAL track positions')
  if (!items.length) throw new Error('TIDAL album has no tracks')
  return items.map((item) => {
    const track = tracks.get(item.id)
    if (!track) throw new Error('Incomplete TIDAL track listing')
    return { item, track }
  })
}

function normalizedTrack(
  album: TidalAlbumResource,
  { item, track }: { item: AlbumItem; track: TidalTrackResource },
  index: number,
): PluginTrack {
  const data = tidalTrackData(track)
  const durationSec = tidalDurationSec(track.attributes.duration)
  return {
    externalId: track.id,
    title: data.version
      ? `${track.attributes.title} (${data.version})`
      : track.attributes.title,
    position: index + 1,
    ...(durationSec === null ? {} : { durationSec }),
    ...(data.version ? { version: data.version } : {}),
    ...(track.attributes.isrc ? { isrc: track.attributes.isrc } : {}),
    references: [
      {
        referenceType: 'track',
        externalId: track.id,
        isPrimary: true,
        metadata: {
          ...data,
          tidalAlbumId: album.id,
          volumeNumber: item.volumeNumber,
          trackNumber: item.trackNumber,
        },
      },
    ],
  }
}

export const tidalPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'tidal',
    displayName: 'TIDAL',
    description:
      'Album and track matching by UPC and ISRC; catalogue data only, no playback',
    siteUrl: 'https://tidal.com',
    mediaTypes: ['album'],
    identifierTypes: ['album', 'upc'],
    requireExplicitSelection: true,
    maxItemsPerJob: 1,
    runsInRequest: true,
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: 1500,
      requestTimeoutMs: 30000,
      rateLimitCooldownMs: 300000,
    },
    secrets: [
      {
        key: 'clientId',
        label: 'Client ID',
        required: true,
        envVars: ['TIDAL_CLIENT_ID'],
      },
      {
        key: 'clientSecret',
        label: 'Client secret',
        required: true,
        envVars: ['TIDAL_CLIENT_SECRET'],
      },
      {
        key: 'countryCode',
        label: 'Country',
        required: false,
        helpText: 'Two-letter country code for catalogue lookups. Default AU.',
      },
    ],
  },
  async testConnection({ secrets, request }) {
    await tidalToken(secrets, request)
  },
  async scrapeMediaItem(context) {
    if (context.mediaType !== 'album')
      throw new Error('TIDAL supports albums only')
    const lookup = albumLookup(context)
    const countryCode = tidalCountry(context.secrets)
    const token = await tidalToken(context.secrets, context.request)
    const raw = await tidalJson(context.request, token, '/albums', [
      ['countryCode', countryCode],
      [lookup.kind === 'id' ? 'filter[id]' : 'filter[barcodeId]', lookup.value],
      ['include', 'items'],
    ])
    const document = TidalAlbumsDocumentSchema.parse(raw)
    const found = document.data.filter((album) =>
      lookup.kind === 'id'
        ? album.id === lookup.value
        : album.attributes.barcodeId
          ? sameBarcode(album.attributes.barcodeId, lookup.value)
          : false,
    )
    if (!found.length)
      throw new ProviderItemNotFoundError(
        lookup.kind === 'id'
          ? 'TIDAL has no album with this ID'
          : 'TIDAL has no album with this UPC',
      )
    const candidates = found.filter(
      (album) =>
        !context.isRejectedMatch?.({
          referenceType: 'album',
          externalId: album.id,
        }),
    )
    if (!candidates.length)
      throw new ProviderItemNotFoundError(
        'The TIDAL album for this UPC was rejected',
      )
    if (candidates.length > 1)
      throw new ProviderItemAmbiguousError(
        'Several TIDAL albums have this UPC; set the TIDAL album ID',
      )
    const [album] = candidates
    if (!album) throw new ProviderItemNotFoundError('No TIDAL album match')
    const pages: unknown[] = []
    const tracks = await albumTracks(
      context,
      token,
      countryCode,
      album,
      includedTracks(document.included),
      pages,
    )
    const url = tidalUrl('album', album)
    return {
      payload: JsonValueSchema.parse({
        album: raw,
        ...(pages.length ? { itemPages: pages } : {}),
      }),
      normalized: {
        references: [
          {
            referenceType: 'album',
            externalId: album.id,
            isPrimary: true,
            metadata: {
              url,
              matchedBy: lookup.kind,
              ...(album.attributes.barcodeId
                ? { barcodeId: album.attributes.barcodeId }
                : {}),
            },
          },
        ],
        links: [{ provider: 'tidal', label: 'TIDAL', url }],
        tags: [],
        credits: [],
        tracks: tracks.map((entry, index) =>
          normalizedTrack(album, entry, index),
        ),
        playlists: [],
      },
    }
  },
}
