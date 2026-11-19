import { and, eq, isNotNull, or, sql } from 'drizzle-orm'
import {
  PluginNormalizedResultSchema,
  type JsonValue,
} from '@repo/media-plugin-sdk'
import type { ProviderSummary } from '@repo/schemas/provider'
import {
  albumProviderDetailBrowseFields,
  readAlbumProviderDetails,
} from '@/lib/album-provider-details'
import { db } from '@/lib/db'
import { parseOptionalDate } from '@/lib/media-utils'
import { isJsonRecord } from '@/lib/provider-normalizers'
import { rymRatingSourceUrl } from '@/lib/rym-rating-links'
import { SpotifyAlbumSchema } from '@/lib/spotify-api'
import {
  album,
  mediaItem,
  mediaItemTag,
  providerCurrentState,
  tagOccurrence,
} from '@/schemas/db'

type Metadata = Record<string, JsonValue> | null | undefined
type SourceFields = Array<[provider: string, fields: string[]]>
type AlbumInventory = {
  hasData: boolean
  providers: Set<string>
  scrapedAt: Map<string, Date>
}

const sourceFields = {
  spotify: ['popularitySpotify'],
  discogs: [
    'ratingDiscogsValue',
    'ratingDiscogsVotes',
    'popularityDiscogs',
    ...albumProviderDetailBrowseFields.discogs.map(({ key }) => key),
  ],
  lastfm: ['popularityLastFm', 'plugin.lastfm.playcount'],
  musicbrainz: albumProviderDetailBrowseFields.musicbrainz.map(
    ({ key }) => key,
  ),
  metacritic: ['ratingMetacriticValue', 'ratingMetacriticVotes'],
}

const albumFields = [
  'country',
  'genre',
  'albumTag',
  'ratingRymValue',
  'ratingRymVotes',
]

const genericImports = new Set([
  'album-csv',
  'upc-csv',
  'legacy-browser',
  'legacy-record',
])
const nativePayloadProviders = new Set([
  'spotify',
  'musicbrainz',
  'discogs',
  'lastfm',
])

const hasText = (value: string | null | undefined) => Boolean(value?.trim())

function hasValue(value: JsonValue | undefined): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return hasText(value)
  return Array.isArray(value) && value.some(hasValue)
}

function addMetadata(
  inventory: AlbumInventory,
  metadata: Metadata,
  fieldsBySource: SourceFields,
) {
  if (!metadata) return
  const browse = isJsonRecord(metadata.browse) ? metadata.browse : {}
  for (const [provider, fields] of fieldsBySource)
    if (fields.some((field) => hasValue(browse[field]))) {
      inventory.hasData = true
      inventory.providers.add(provider)
    }
  if (albumFields.some((field) => hasValue(browse[field])))
    inventory.hasData = true
  if (rymRatingSourceUrl(metadata)) inventory.providers.add('serply')
}

function addProviderState(
  inventory: AlbumInventory,
  row: { provider: string; normalized: unknown },
  fieldsBySource: SourceFields,
) {
  const parsed = PluginNormalizedResultSchema.safeParse(
    row.normalized ?? undefined,
  )
  if (parsed.success) {
    const { mediaPatch, albumPatch, tracks, tags, credits } = parsed.data
    addMetadata(inventory, mediaPatch?.metadata, fieldsBySource)
    addMetadata(inventory, albumPatch?.metadata, fieldsBySource)
    for (const tag of tags) {
      // A local import may supply an explicit tag source.
      if (tag.source) inventory.providers.add(tag.source)
    }
    if (
      hasText(mediaPatch?.summary) ||
      hasText(mediaPatch?.originalTitle) ||
      hasText(mediaPatch?.artworkUrl) ||
      parseOptionalDate(mediaPatch?.releaseDate) ||
      (albumPatch?.durationSec ?? 0) > 0 ||
      tracks.length > 0 ||
      tags.length > 0 ||
      credits.some(({ role }) => role !== 'artist') ||
      (!genericImports.has(row.provider) &&
        hasText(mediaPatch?.title) &&
        credits.length > 0)
    ) {
      inventory.hasData = true
      inventory.providers.add(row.provider)
    }
  }
}

function addNativeProviderState(
  inventory: AlbumInventory,
  row: { provider: string; payload: JsonValue },
) {
  const payload = isJsonRecord(row.payload)
    ? (row.payload.data ?? row.payload.spotify ?? row.payload)
    : row.payload
  if (
    (row.provider === 'spotify' &&
      SpotifyAlbumSchema.safeParse(payload).success) ||
    readAlbumProviderDetails(row.provider, payload)
  ) {
    inventory.hasData = true
    inventory.providers.add(row.provider)
  }
}

/** Titles, IDs and user-added dates establish library identity and membership. */
export async function readAlbumMetadataInventory(
  ids: string[],
  providers: Pick<ProviderSummary, 'id' | 'browseFields'>[] = [],
) {
  const results = new Map<string, AlbumInventory>()
  if (!ids.length) return results
  const fieldsBySource: SourceFields = Object.entries(sourceFields)
  for (const { id, browseFields } of providers) {
    if (Object.hasOwn(sourceFields, id)) continue
    const keys = browseFields
      .map(({ key }) => key)
      .filter((key) => key.startsWith(`plugin.${id}.`))
    if (keys.length) fieldsBySource.push([id, keys])
  }
  const [albums, states, tags] = await Promise.all([
    db
      .select({
        id: album.mediaItemId,
        metadata: album.metadata,
        mediaMetadata: mediaItem.metadata,
        artworkUrl: mediaItem.artworkUrl,
        releaseDate: mediaItem.releaseDate,
        originalTitle: mediaItem.originalTitle,
        summary: mediaItem.summary,
        duration: album.durationSec,
        trackCount: album.trackCount,
        hasTag: sql<boolean>`exists (
          select 1 from media_item_tag t where t.media_item_id = ${album.mediaItemId}
        )`,
        hasTrack: sql<boolean>`exists (
          select 1 from track t where t.album_media_item_id = ${album.mediaItemId}
        )`,
        spotifyTrack: sql<boolean>`exists (
          select 1 from track t join library_track lt on lt.media_item_id = t.track_media_item_id
          where t.album_media_item_id = ${album.mediaItemId}
            and t.external_id = lt.spotify_track_id
            and t.external_id ~ '^[A-Za-z0-9]{22}$'
        )`,
      })
      .from(album)
      .innerJoin(mediaItem, eq(mediaItem.id, album.mediaItemId))
      .where(sql`${album.mediaItemId} = any(${sql.param(ids)}::text[])`),
    db
      .select({
        stateId: providerCurrentState.id,
        id: providerCurrentState.mediaItemId,
        provider: providerCurrentState.provider,
        normalized: providerCurrentState.normalizedData,
        scrapedAt: providerCurrentState.lastScrapedAt,
      })
      .from(providerCurrentState)
      .where(
        and(
          sql`${providerCurrentState.mediaItemId} = any(${sql.param(ids)}::text[])`,
          or(
            eq(providerCurrentState.status, 'ready'),
            isNotNull(providerCurrentState.lastSuccessfulAt),
          ),
        ),
      ),
    db
      .selectDistinct({
        id: tagOccurrence.mediaItemId,
        provider: tagOccurrence.provider,
        source: tagOccurrence.source,
      })
      .from(tagOccurrence)
      .innerJoin(
        mediaItemTag,
        and(
          eq(mediaItemTag.mediaItemId, tagOccurrence.mediaItemId),
          eq(mediaItemTag.tagId, tagOccurrence.tagId),
        ),
      )
      .where(
        sql`${tagOccurrence.mediaItemId} = any(${sql.param(ids)}::text[])`,
      ),
  ])
  for (const row of albums) {
    const inventory: AlbumInventory = {
      hasData: Boolean(
        hasText(row.artworkUrl) ||
        row.releaseDate ||
        hasText(row.originalTitle) ||
        hasText(row.summary) ||
        (row.duration ?? 0) > 0 ||
        row.trackCount > 0 ||
        row.hasTrack ||
        row.hasTag,
      ),
      providers: new Set(),
      scrapedAt: new Map(),
    }
    for (const metadata of [row.metadata, row.mediaMetadata])
      addMetadata(inventory, metadata, fieldsBySource)
    if (
      (row.artworkUrl &&
        /^https?:\/\/(?:[a-z0-9-]+\.)+scdn\.co\//i.test(row.artworkUrl)) ||
      (row.releaseDate &&
        SpotifyAlbumSchema.shape.release_date_precision
          .unwrap()
          .safeParse(row.mediaMetadata?.spotifyReleaseDatePrecision).success) ||
      row.spotifyTrack
    ) {
      inventory.hasData = true
      inventory.providers.add('spotify')
    }
    results.set(row.id, inventory)
  }
  for (const tag of tags) {
    const inventory = results.get(tag.id)
    if (!inventory) continue
    if (tag.provider) inventory.providers.add(tag.provider)
    if (tag.source) inventory.providers.add(tag.source)
  }
  const unresolvedNative = []
  for (const state of states) {
    const inventory = results.get(state.id)
    if (!inventory) continue
    if (state.scrapedAt)
      inventory.scrapedAt.set(state.provider, state.scrapedAt)
    addProviderState(inventory, state, fieldsBySource)
    if (
      nativePayloadProviders.has(state.provider) &&
      !inventory.providers.has(state.provider)
    )
      unresolvedNative.push(state.stateId)
  }
  // Only read raw data for native album results without normalized or
  // canonical evidence. Legacy imports can project just an ID and a link.
  if (unresolvedNative.length) {
    const native = await db
      .select({
        id: providerCurrentState.mediaItemId,
        provider: providerCurrentState.provider,
        payload: providerCurrentState.payload,
      })
      .from(providerCurrentState)
      .where(
        sql`${providerCurrentState.id} = any(${sql.param(unresolvedNative)}::text[])`,
      )
    for (const state of native) {
      const inventory = results.get(state.id)
      if (inventory) addNativeProviderState(inventory, state)
    }
  }
  return results
}
