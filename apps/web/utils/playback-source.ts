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
  TrackListItemSchema,
  type PlaylistEntry,
  type TrackListItem,
} from '@repo/schemas/tracks'
import { fetchApiData } from './api'
import {
  albumPlayable,
  libraryTrackPlayable,
  trackPlayable,
  type PlayableItem,
  type PlaybackSource,
} from './playback'
import { browsePageSize } from './virtual-browse'

const AlbumPageSchema = PaginatedDataSchema(AlbumListItemSchema)
const TrackPageSchema = PaginatedDataSchema(TrackListItemSchema)
const PAGE_CACHE_SIZE = 4
const ALBUM_CACHE_SIZE = 12
const AlbumTrackViewSchema = z.object({
  id: z.string(),
  q: z.string().max(200).default(''),
  sortBy: z
    .enum(['position', 'title', 'duration', 'scrobbles', 'externalId'])
    .default('position'),
  direction: z.enum(['asc', 'desc']).default('asc'),
})
const AlbumDetailTabSchema = z.enum([
  'overview',
  'tracks',
  'listening',
  'edit',
  'history',
])

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

export function albumDetailTab(params: URLSearchParams, id: string) {
  if (!savedAlbumTrackView(params.get('albumTrackView'), id)) return 'overview'
  const tab = AlbumDetailTabSchema.safeParse(params.get('tab'))
  return tab.success ? tab.data : 'overview'
}

/** Restores the table and its tab without dropping the surrounding browse URL. */
export function albumTrackViewHref(
  pathname: string,
  params: URLSearchParams,
  view: z.infer<typeof AlbumTrackViewSchema>,
  tab = 'tracks',
) {
  const next = new URLSearchParams(params)
  next.set('albumTrackView', JSON.stringify(view))
  next.set('tab', tab)
  return `${pathname}?${next}`
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
  ).flatMap((track) => {
    const playable = trackPlayable(album, track)
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
}: SourceOptions & {
  collection: 'albums' | 'tracks'
  initialItem?: AlbumListItem | TrackListItem
}): PlaybackSource {
  const captured = new URLSearchParams(params)
  const albums = albumLoader(apiBaseUrl)
  const pages = cached(PAGE_CACHE_SIZE, async (page: number) => {
    const path = `/api/v1/${collection}?${pageQuery(captured, page)}`
    if (collection === 'albums')
      return (await fetchApiData(apiBaseUrl, path, AlbumPageSchema)).items
    return (await fetchApiData(apiBaseUrl, path, TrackPageSchema)).items
  })
  return {
    label,
    href,
    length: total,
    startIndex,
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

/** An opened album already has its stored tracks, so needs no further reads. */
export function createAlbumPlaybackSource(
  album: AlbumDetail,
  href: string,
  selection?: readonly AlbumDetail['tracks'][number][],
): PlaybackSource {
  const tracks = tracksInAlbum(album, selection)
  return {
    label: album.title,
    href,
    length: 1,
    startIndex: 0,
    load: async (index) => (index === 0 ? [...tracks] : []),
  }
}
