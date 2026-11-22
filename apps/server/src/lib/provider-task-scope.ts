import { LASTFM_SPOTIFY_SEARCH_TASK } from '@repo/schemas/lastfm'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_TASK,
  TIDAL_TRACK_MATCH_TASK,
} from '@repo/schemas/tidal'
import {
  MIX_STATION_SYNC_TASKS,
  MixStationSchema,
} from '@repo/schemas/subscriptions'

export function stationForProviderTask(task: string, provider: string) {
  const station = MixStationSchema.safeParse(provider)
  return station.success && MIX_STATION_SYNC_TASKS[station.data] === task
    ? station.data
    : null
}

export function isProviderReplayTask(task: string | null, provider: string) {
  return (
    task !== null &&
    (stationForProviderTask(task, provider) !== null ||
      (provider === 'spotify' &&
        (task === LASTFM_SPOTIFY_SEARCH_TASK ||
          task === SPOTIFY_TRACK_SEARCH_TASK ||
          task === SPOTIFY_SIMILAR_LOOKUP_TASK)) ||
      (provider === 'tidal' &&
        (task === TIDAL_TRACK_MATCH_TASK || task === TIDAL_SIMILAR_TASK)))
  )
}
