import { artistBrowseFields } from '@repo/schemas/artist-browse'
import type { BrowseField } from '@repo/schemas/browse'
import {
  devicePayloadSchemas,
  type DeviceArtistRow,
  type DevicePlaylistJobRow,
  type DevicePlaylistRow,
} from '@repo/schemas/device'
import type { StoreRow } from './device-store'
import { artistPayload, playlistPayload } from './fixtures'

/** Synthetic Artists and Playlists rows: every name, ID and time below is invented. */

export type ArtistRowPatch = {
  item?: Partial<DeviceArtistRow['item']>
  text?: Partial<DeviceArtistRow['text']>
  search?: Partial<DeviceArtistRow['search']>
  num?: Partial<DeviceArtistRow['num']>
  sort?: Partial<DeviceArtistRow['sort']>
  extra?: Partial<DeviceArtistRow['extra']>
}

/** An artist row whose name, name text, name search and name sort agree. */
export function artist(
  id: string,
  name: string,
  patch: ArtistRowPatch = {},
): StoreRow {
  const base = artistPayload(id, { name })
  const payload = devicePayloadSchemas.artist.parse({
    item: { ...base.item, ...patch.item },
    text: { ...base.text, ...patch.text },
    search: { ...base.search, name: [name], ...patch.search },
    num: { ...base.num, ...patch.num },
    sort: { ...base.sort, ...patch.sort },
    extra: { ...base.extra, ...patch.extra },
  })
  return { entity: 'artist', id, payload }
}

export type PlaylistRowPatch = {
  item?: Partial<DevicePlaylistRow['item']>
  search?: Partial<DevicePlaylistRow['search']>
  num?: Partial<DevicePlaylistRow['num']>
  sort?: Partial<DevicePlaylistRow['sort']>
  extra?: Partial<DevicePlaylistRow['extra']>
}

/** A playlist row whose name, name search and name sort agree. */
export function playlist(
  id: string,
  name: string,
  patch: PlaylistRowPatch = {},
): StoreRow {
  const base = playlistPayload(id)
  const payload = devicePayloadSchemas.playlist.parse({
    item: { ...base.item, name, ...patch.item },
    text: {},
    search: { ...base.search, name: [name], ...patch.search },
    num: { ...base.num, ...patch.num },
    sort: { ...base.sort, name: name.toLowerCase(), ...patch.sort },
    extra: { ...base.extra, ...patch.extra },
  })
  return { entity: 'playlist', id, payload }
}

/** The latest import job of sync group `groupKey`. */
export function playlistJob(
  groupKey: string,
  status: DevicePlaylistJobRow['status'],
  jobId = `job-${groupKey}`,
): StoreRow {
  const active = status === 'queued' || status === 'running'
  return {
    entity: 'playlist_job',
    id: groupKey,
    payload: devicePayloadSchemas.playlist_job.parse({
      jobId,
      status,
      errorMessage: status === 'failed' ? 'Example failure' : null,
      finishedAt: active ? null : '2024-06-01T10:00:00.000Z',
      progress: null,
      activity: null,
    }),
  }
}

/** The scrobbles attributed to an artist, as whole epoch seconds. */
export function artistPlays(artistId: string, times: number[]): StoreRow {
  return { entity: 'artist_plays', id: artistId, payload: { plays: times } }
}

export function artistFields(
  fields: BrowseField[] = artistBrowseFields,
): StoreRow {
  return {
    entity: 'meta',
    id: 'fields:artist',
    payload: { kind: 'fields', library: 'artist', fields },
  }
}

export function listeningStart(historyStart: string | null): StoreRow {
  return {
    entity: 'meta',
    id: 'listening',
    payload: { kind: 'listening', historyStart },
  }
}

export function tagKey(key: string, ancestorKeys: string[]): StoreRow {
  return {
    entity: 'tag_key',
    id: `album:${key}`,
    payload: { mediaType: 'album', key, ancestorKeys },
  }
}

export function seconds(iso: string): number {
  return Date.parse(iso) / 1000
}

/** Epoch microseconds of an ISO time, the stored date unit. */
export function microseconds(iso: string): number {
  return Date.parse(iso) * 1000
}
