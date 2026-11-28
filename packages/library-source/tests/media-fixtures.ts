import {
  albumBrowseFields,
  filmBrowseFields,
  type BrowseField,
} from '@repo/schemas/browse'
import {
  devicePayloadSchemas,
  type DeviceBrowseLibrary,
} from '@repo/schemas/device'
import {
  AlbumQuerySchema,
  FilmQuerySchema,
  type AlbumQuery,
  type FilmQuery,
} from '@repo/schemas/media'
import { foldText } from '../src/fold'
import type { StoreRow } from './device-store'
import {
  albumPayload,
  filmPayload,
  tagPayload,
  type TagOptions,
} from './fixtures'

/** Synthetic Album and Film rows only: every name, ID and time below is invented. */

export const DAY_US = 86_400_000_000
export const BASE_US = 1_700_000_000_000_000

/** Plugin fields matching the catch-all keys `albumPayload` writes, and one date. */
export const albumPluginFields: BrowseField[] = [
  { key: 'pluginMood', label: 'Mood', type: 'text', filterable: true },
  { key: 'pluginScore', label: 'Score', type: 'number', filterable: true },
  { key: 'pluginSeen', label: 'Seen', type: 'date', filterable: true },
]

export const filmPluginFields: BrowseField[] = [
  { key: 'pluginCut', label: 'Cut', type: 'text', filterable: true },
  { key: 'pluginRank', label: 'Rank', type: 'number', filterable: true },
]

/** The `fields:<library>` meta row the server publishes. */
export function fieldsRow(
  library: DeviceBrowseLibrary,
  fields: readonly BrowseField[],
): StoreRow {
  return {
    entity: 'meta',
    id: `fields:${library}`,
    payload: { kind: 'fields', library, fields },
  }
}

export const albumFieldsRow = () =>
  fieldsRow('album', [...albumBrowseFields, ...albumPluginFields])
export const filmFieldsRow = () =>
  fieldsRow('film', [...filmBrowseFields, ...filmPluginFields])

/** Changes to a default row, section by section; the result is validated. */
export type MediaRowPatch = {
  item?: Record<string, unknown>
  text?: Record<string, string[]>
  search?: Record<string, string[]>
  num?: Record<string, number | null>
  sort?: Record<string, string | null>
  extra?: Record<string, unknown>
}

/** Album rows also patch the Tags sort per location. */
export type AlbumRowPatch = MediaRowPatch & {
  genre?: Record<string, string | null>
}

export function albumRow(id: string, patch: AlbumRowPatch = {}): StoreRow {
  const base = albumPayload(id)
  return {
    entity: 'album',
    id,
    payload: devicePayloadSchemas.album.parse({
      item: { ...base.item, ...patch.item },
      text: { ...base.text, ...patch.text },
      search: { ...base.search, ...patch.search },
      num: { ...base.num, ...patch.num },
      sort: {
        ...base.sort,
        ...patch.sort,
        genre: { ...base.sort.genre, ...patch.genre },
      },
      extra: { ...base.extra, ...patch.extra },
    }),
  }
}

export function filmRow(id: string, patch: MediaRowPatch = {}): StoreRow {
  const base = filmPayload(id)
  return {
    entity: 'film',
    id,
    payload: devicePayloadSchemas.film.parse({
      item: { ...base.item, ...patch.item },
      text: { ...base.text, ...patch.text },
      search: { ...base.search, ...patch.search },
      num: { ...base.num, ...patch.num },
      sort: { ...base.sort, ...patch.sort },
      extra: { ...base.extra, ...patch.extra },
    }),
  }
}

/** A patch whose title, title text and title sort agree. */
export function titled(title: string, patch: MediaRowPatch = {}) {
  return {
    ...patch,
    item: { title, ...patch.item },
    text: { title: [title], ...patch.text },
    sort: { title: foldText(title), ...patch.sort },
  }
}

/** A patch for an item added `day` days after the base date. */
export function addedOn(day: number, patch: AlbumRowPatch = {}) {
  const dateAdded = BASE_US + day * DAY_US
  return {
    ...patch,
    item: {
      dateAdded: new Date(dateAdded / 1000).toISOString(),
      ...patch.item,
    },
    num: { dateAdded, ...patch.num },
  }
}

export function albumTag(id: string, options: TagOptions): StoreRow {
  return { entity: 'tag', id, payload: tagPayload(options) }
}

export function filmTag(id: string, options: TagOptions): StoreRow {
  return {
    entity: 'tag',
    id,
    payload: devicePayloadSchemas.tag.parse({
      ...tagPayload(options),
      mediaType: 'film',
    }),
  }
}

export function tagKey(
  mediaType: 'album' | 'film',
  key: string,
  ancestorKeys: string[],
): StoreRow {
  return {
    entity: 'tag_key',
    id: `${mediaType}:${key}`,
    payload: { mediaType, key, ancestorKeys },
  }
}

/** Scrobbles linked to an album, as epoch seconds. */
export function albumPlays(albumId: string, times: number[]): StoreRow {
  return { entity: 'album_plays', id: albumId, payload: { plays: times } }
}

/** Album and Film filters arrive as a JSON string, as in the URL. */
function serializedFilters(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Array.isArray(input.filters)
    ? { ...input, filters: JSON.stringify(input.filters) }
    : input
}

export function albumQuery(input: Record<string, unknown> = {}): AlbumQuery {
  return AlbumQuerySchema.parse(serializedFilters(input))
}

export function filmQuery(input: Record<string, unknown> = {}): FilmQuery {
  return FilmQuerySchema.parse(serializedFilters(input))
}

export function seconds(iso: string): number {
  return Date.parse(iso) / 1000
}

export const sorted = (ids: string[]) => [...ids].sort()
