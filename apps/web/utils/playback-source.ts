import { BrowsePageSliceSchema } from '@repo/schemas/browse'
import { PaginatedDataSchema } from '@repo/schemas/common'
import { z } from 'zod'
import {
  AlbumDetailSchema,
  AlbumListItemSchema,
  type AlbumDetail,
  type AlbumListItem,
} from '@repo/schemas/media'
import {
  PlaylistDetailSchema,
  PlaylistEntrySortSchema,
  TRACK_POSITIONS_MAX,
  TrackListItemSchema,
  TrackPositionsSchema,
  type PlaylistEntry,
  type TrackListItem,
} from '@repo/schemas/tracks'
import { LibraryPlaylistEntriesPageSchema } from '@repo/schemas/library-playlists'
import type { SavedSource } from '@repo/schemas/playback'
import { fetchApiData } from './api'
import { detailPageHref } from './detail-inspector'
import type { PlayableLibrary } from './library-playlists'
import {
  albumPlayable,
  libraryTrackPlayable,
  type PendingPlaybackSource,
  type PlayableItem,
  type PlaybackSource,
} from './playback'
import { browsePageSize } from './virtual-browse'

const AlbumPageSchema = PaginatedDataSchema(AlbumListItemSchema)
const TrackPageSchema = BrowsePageSliceSchema(TrackListItemSchema)
export type TrackBrowsePage = z.infer<typeof TrackPageSchema>
const PAGE_CACHE_SIZE = 4
const ALBUM_CACHE_SIZE = 12
const AlbumTrackViewSchema = z.object({
  id: z.string(),
  q: z.string().max(200).default(''),
  sortBy: PlaylistEntrySortSchema.or(z.literal('externalId')).default(
    'position',
  ),
  direction: z.enum(['asc', 'desc']).default('asc'),
})

function savedAlbumTrackView(value: string | null, id: string) {
  try {
    const parsed = AlbumTrackViewSchema.safeParse(JSON.parse(value ?? '{}'))
    if (parsed.success && parsed.data.id === id) return parsed.data
  } catch {
    // Malformed URL state restores the original album track order.
  }
  return null
}

/** Table settings are scoped to one album so another drawer starts normally. */
export function albumTrackView(value: string | null, id: string) {
  return savedAlbumTrackView(value, id) ?? AlbumTrackViewSchema.parse({ id })
}

type SourceOptions = {
  apiBaseUrl: string
  params: URLSearchParams
  href: string
  label: string
  total: number
  startIndex: number
}

/** Small per-source caches outlive the view without retaining the full library. */
function cached<K, V>(limit: number, load: (key: K) => Promise<V>) {
  const entries = new Map<K, Promise<V>>()
  return (key: K): Promise<V> => {
    const existing = entries.get(key)
    if (existing) {
      entries.delete(key)
      entries.set(key, existing)
      return existing
    }
    const pending = load(key).catch((error: unknown) => {
      if (entries.get(key) === pending) entries.delete(key)
      throw error
    })
    entries.set(key, pending)
    while (entries.size > limit) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    return pending
  }
}

function tracksInAlbum(
  album: AlbumDetail,
  selection?: readonly AlbumDetail['tracks'][number][],
): PlayableItem[] {
  const tracks = (
    selection ?? [...album.tracks].sort((a, b) => a.position - b.position)
  ).flatMap(({ track }) => {
    const playable = libraryTrackPlayable(track)
    return playable ? [playable] : []
  })
  if (tracks.length || selection) return tracks
  const playable = albumPlayable(album)
  return playable ? [playable] : []
}

function albumLoader(apiBaseUrl: string) {
  return cached(ALBUM_CACHE_SIZE, async (id: string) =>
    tracksInAlbum(
      await fetchApiData(
        apiBaseUrl,
        `/api/v1/albums/${encodeURIComponent(id)}`,
        AlbumDetailSchema,
      ),
    ),
  )
}

function pageQuery(params: URLSearchParams, page: number) {
  const query = new URLSearchParams(params)
  query.set('page', String(page))
  query.set('size', String(browsePageSize))
  return query
}

function validIndex(index: number, length: number) {
  return Number.isInteger(index) && index >= 0 && index < length
}

function trackBrowsePages(
  apiBaseUrl: string,
  params: URLSearchParams,
  getCachedPage?: (page: number) => TrackBrowsePage | undefined,
) {
  const captured = new URLSearchParams(params)
  return cached(
    PAGE_CACHE_SIZE,
    async (page: number) =>
      getCachedPage?.(page) ??
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/browse-page?${pageQuery(captured, page)}`,
        TrackPageSchema,
      ),
  )
}

/** Captures a browse query; later navigation cannot change its source. */
export function createBrowsePlaybackSource({
  apiBaseUrl,
  collection,
  params,
  href,
  label,
  total,
  startIndex,
  initialItem,
  readTrackPage = trackBrowsePages(apiBaseUrl, params),
}: SourceOptions & {
  collection: 'albums' | 'tracks'
  initialItem?: AlbumListItem | TrackListItem
  readTrackPage?: ReturnType<typeof trackBrowsePages>
}): PlaybackSource {
  const captured = new URLSearchParams(params)
  const albums = albumLoader(apiBaseUrl)
  const pages = cached(PAGE_CACHE_SIZE, async (page: number) => {
    const query = pageQuery(captured, page)
    if (collection === 'albums')
      return (
        await fetchApiData(
          apiBaseUrl,
          `/api/v1/albums?${query}`,
          AlbumPageSchema,
        )
      ).items
    return (await readTrackPage(page)).items
  })
  const playables = async (item: AlbumListItem | TrackListItem | undefined) => {
    if (!item) return []
    if (item.mediaType === 'album') return albums(item.id)
    const playable = libraryTrackPlayable(item)
    return playable ? [playable] : []
  }
  const initial = (index: number) =>
    index === startIndex ? initialItem : undefined
  /** Tracks anywhere in the list, in one request for each batch of positions. */
  async function loadScattered(indexes: number[]) {
    const wanted = [
      ...new Set(
        indexes.filter((index) => validIndex(index, total) && !initial(index)),
      ),
    ]
    const batches: number[][] = []
    for (let at = 0; at < wanted.length; at += TRACK_POSITIONS_MAX)
      batches.push(wanted.slice(at, at + TRACK_POSITIONS_MAX))
    const found = new Map<number, TrackListItem>()
    const results = await Promise.all(
      batches.map((positions) => {
        const query = new URLSearchParams(captured)
        query.delete('page')
        query.delete('size')
        query.set('positions', positions.join(','))
        return fetchApiData(
          apiBaseUrl,
          `/api/v1/tracks/positions?${query}`,
          TrackPositionsSchema,
        )
      }),
    )
    for (const result of results)
      for (const { position, item } of result.items) found.set(position, item)
    return Promise.all(
      indexes.map((index) =>
        validIndex(index, total)
          ? playables(initial(index) ?? found.get(index))
          : [],
      ),
    )
  }
  return {
    label,
    href,
    length: total,
    startIndex,
    kind: collection === 'albums' ? 'album' : 'list',
    descriptor: { type: 'browse', collection, params: captured.toString() },
    async load(index) {
      if (!validIndex(index, total)) return []
      return playables(
        initial(index) ??
          (await pages(Math.floor(index / browsePageSize) + 1))[
            index % browsePageSize
          ],
      )
    },
    ...(collection === 'tracks' ? { loadScattered } : {}),
  }
}

/** Ordered playback can read more rows while the exact matching count is unavailable. */
export function createPendingTrackBrowseSource(
  options: Omit<SourceOptions, 'total'> & {
    initialItem: TrackListItem
    getCachedPage?: (page: number) => TrackBrowsePage | undefined
  },
  resolveTotal: () => Promise<number>,
): PendingPlaybackSource {
  const { apiBaseUrl, href, label, startIndex, initialItem } = options
  const params = new URLSearchParams(options.params)
  const readTrackPage = trackBrowsePages(
    apiBaseUrl,
    params,
    options.getCachedPage,
  )
  const withLength = (total: number) =>
    createBrowsePlaybackSource({
      ...options,
      params,
      collection: 'tracks',
      total,
      readTrackPage,
    })
  const readAt = (index: number) =>
    readTrackPage(Math.floor(index / browsePageSize) + 1)
  return {
    href,
    label,
    startIndex,
    kind: 'list',
    async load(index) {
      const track =
        index === startIndex
          ? initialItem
          : (await readAt(index)).items[index % browsePageSize]
      const item = track && libraryTrackPlayable(track)
      return item ? [item] : []
    },
    async readPageEnd(index) {
      const { items, page, hasMore } = await readAt(index)
      return { end: (page - 1) * browsePageSize + items.length, hasMore }
    },
    withLength,
    async resolve() {
      return withLength(await resolveTotal())
    },
  }
}

/** Reads the stored playlist entries in the captured table order. */
export function createPlaylistPlaybackSource({
  apiBaseUrl,
  id,
  params,
  href,
  label,
  total,
  startIndex,
  initialEntry,
}: SourceOptions & {
  id: string
  initialEntry?: PlaylistEntry
}): PlaybackSource {
  const captured = new URLSearchParams(params)
  const albums = albumLoader(apiBaseUrl)
  const pages = cached(PAGE_CACHE_SIZE, async (page: number) => {
    const result = await fetchApiData(
      apiBaseUrl,
      `/api/v1/playlists/${encodeURIComponent(id)}?${pageQuery(captured, page)}`,
      PlaylistDetailSchema,
    )
    return result.items.items
  })
  return {
    label,
    href,
    length: total,
    startIndex,
    kind: 'list',
    descriptor: { type: 'playlist', id, params: captured.toString() },
    async load(index) {
      if (!validIndex(index, total)) return []
      const entry =
        index === startIndex && initialEntry
          ? initialEntry
          : (await pages(Math.floor(index / browsePageSize) + 1))[
              index % browsePageSize
            ]
      if (!entry) return []
      if (entry.kind === 'album') return albums(entry.album.id)
      const playable = libraryTrackPlayable(entry.track)
      return playable ? [playable] : []
    },
  }
}

/**
 * Reads a library playlist's entries in position order: a track playlist's
 * tracks, or an album playlist's albums with each album's stored tracks.
 */
export function createLibraryPlaylistPlaybackSource({
  apiBaseUrl,
  id,
  library,
  href,
  label,
  total,
  startIndex,
  initialItem,
}: Omit<SourceOptions, 'params'> & {
  id: string
  library: PlayableLibrary
  initialItem?: AlbumListItem | TrackListItem
}): PlaybackSource {
  const albums = albumLoader(apiBaseUrl)
  const pages = cached(PAGE_CACHE_SIZE, async (page: number) => {
    const result = await fetchApiData(
      apiBaseUrl,
      `/api/v1/library-playlists/${encodeURIComponent(id)}/entries?${new URLSearchParams(
        { page: String(page), size: String(browsePageSize) },
      )}`,
      LibraryPlaylistEntriesPageSchema,
    )
    if (result.library === 'albums' || result.library === 'tracks')
      return result.items.map(({ item }) => item)
    return []
  })
  return {
    label,
    href,
    length: total,
    startIndex,
    kind: library === 'albums' ? 'album' : 'list',
    descriptor: { type: 'library-playlist', id, library },
    async load(index) {
      if (!validIndex(index, total)) return []
      const item =
        index === startIndex && initialItem
          ? initialItem
          : (await pages(Math.floor(index / browsePageSize) + 1))[
              index % browsePageSize
            ]
      if (!item) return []
      if (item.mediaType === 'album') return albums(item.id)
      const playable = libraryTrackPlayable(item)
      return playable ? [playable] : []
    },
  }
}

/** An opened album already has its stored tracks, so needs no further reads. */
export function createAlbumPlaybackSource(
  album: AlbumDetail,
  href: string,
  selection?: readonly AlbumDetail['tracks'][number][],
): PlaybackSource {
  return albumTracksSource(album.title, href, tracksInAlbum(album, selection))
}

function albumTracksSource(
  label: string,
  href: string,
  tracks: PlayableItem[],
): PlaybackSource {
  return {
    label,
    href,
    length: 1,
    startIndex: 0,
    kind: 'album',
    descriptor: { type: 'album', tracks },
    load: async (index) => (index === 0 ? [...tracks] : []),
  }
}

/** A captured Similar list keeps its order through refreshes and navigation. */
export function createSimilarTracksPlaybackSource(
  itemId: string,
  tracks: readonly (PlayableItem | null)[],
  startIndex: number,
): PlaybackSource {
  const captured = [...tracks]
  return {
    label: 'Similar tracks',
    href: detailPageHref(
      { kind: 'track', id: itemId },
      new URLSearchParams({ tab: 'similar' }),
    ),
    length: captured.length,
    startIndex,
    kind: 'list',
    descriptor: { type: 'similar-tracks', itemId, tracks: captured },
    async load(index) {
      const track = captured[index]
      return track ? [track] : []
    },
  }
}

/**
 * Recreates a saved source, for a session restored after a
 * reload or taken over from another device.
 */
export function restorePlaybackSource(
  apiBaseUrl: string,
  saved: Pick<
    SavedSource,
    'descriptor' | 'label' | 'href' | 'length' | 'startIndex'
  >,
): PlaybackSource {
  const { descriptor, label, href } = saved
  if (descriptor.type === 'album')
    return albumTracksSource(label, href, descriptor.tracks)
  if (descriptor.type === 'similar-tracks')
    return createSimilarTracksPlaybackSource(
      descriptor.itemId,
      descriptor.tracks,
      saved.startIndex,
    )
  if (descriptor.type === 'library-playlist')
    return createLibraryPlaylistPlaybackSource({
      apiBaseUrl,
      id: descriptor.id,
      library: descriptor.library,
      href,
      label,
      total: saved.length,
      startIndex: saved.startIndex,
    })
  const options = {
    apiBaseUrl,
    params: new URLSearchParams(descriptor.params),
    href,
    label,
    total: saved.length,
    startIndex: saved.startIndex,
  }
  return descriptor.type === 'playlist'
    ? createPlaylistPlaybackSource({ ...options, id: descriptor.id })
    : createBrowsePlaybackSource({
        ...options,
        collection: descriptor.collection,
      })
}
