import type { z } from 'zod'
import type { JsonValue } from '@repo/schemas/common'
import { devicePayloadSchemas, type DeviceEntity } from '@repo/schemas/device'
import type { DeviceFeedRenderer } from '../device-feed'
import { listArtistIds, renderArtists } from './artists'
import {
  listMetaIds,
  listTagIds,
  listTagKeyIds,
  renderMeta,
  renderTagKeys,
  renderTags,
} from './library'
import { listMediaIds, listTrackPeerIds, renderMedia } from './media'
import { listPlaysIds, renderPlays } from './plays'
import {
  listPlaylistIds,
  listPlaylistJobIds,
  renderPlaylistJobs,
  renderPlaylists,
} from './playlists'
import { toJson, type JsonObject } from './projection'

/**
 * The device feed's rows (DEVICE-02): list items from the loaders the list
 * endpoints use, projections from the Browse services' own SQL, each payload
 * parsed by its schema before the feed sees it.
 */

function renderPayloads(
  entity: DeviceEntity,
  ids: string[],
): Promise<Map<string, JsonObject>> {
  switch (entity) {
    case 'track':
    case 'album':
    case 'film':
      return renderMedia(entity, ids)
    case 'artist':
      return renderArtists(ids)
    case 'playlist':
      return renderPlaylists(ids)
    case 'playlist_job':
      return renderPlaylistJobs(ids)
    case 'tag':
      return renderTags(ids)
    case 'tag_key':
      return renderTagKeys(ids)
    case 'scrobble_name':
    case 'album_plays':
    case 'artist_plays':
      return renderPlays(entity, ids)
    case 'meta':
      return renderMeta(ids)
  }
}

function listPublishedIds(
  entity: DeviceEntity,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  switch (entity) {
    case 'track':
    case 'album':
    case 'film':
      return listMediaIds(entity, afterId, limit)
    case 'artist':
      return listArtistIds(afterId, limit)
    case 'playlist':
      return listPlaylistIds(afterId, limit)
    case 'playlist_job':
      return listPlaylistJobIds(afterId, limit)
    case 'tag':
      return listTagIds(afterId, limit)
    case 'tag_key':
      return listTagKeyIds(afterId, limit)
    case 'scrobble_name':
    case 'album_plays':
    case 'artist_plays':
      return listPlaysIds(entity, afterId, limit)
    case 'meta':
      return listMetaIds(afterId, limit)
  }
}

function validated(schema: z.ZodType, payload: JsonObject): JsonValue {
  return toJson(schema.parse(payload))
}

export const deviceRowRenderer: DeviceFeedRenderer = {
  async render(entity, ids) {
    const unique = [...new Set(ids)]
    const rows = new Map<string, JsonValue>()
    if (!unique.length) return rows
    const schema = devicePayloadSchemas[entity]
    for (const [id, payload] of await renderPayloads(entity, unique))
      rows.set(id, validated(schema, payload))
    return rows
  },
  listIds(entity, afterId, limit) {
    return listPublishedIds(entity, afterId, limit)
  },
  // DEVICE-04: a track's recording group depends on its title-key peers and
  // on the group it was published in.
  async expand(entity, ids) {
    return entity === 'track' ? listTrackPeerIds(ids) : []
  },
}
